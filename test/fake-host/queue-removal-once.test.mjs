/**
 * Fake-Host layer: FR-CANCEL-1 — a queue removal is sent at most once per item, whatever happens.
 *
 * Why this file exists: `queue.clear`'s decision to send was taken BEFORE the per-session
 * serialization boundary. Two concurrent callers therefore both read the same `session/queue`
 * snapshot, both concluded the same item was sendable, and both sent — the lock ordered two
 * destructive requests instead of preventing the second. Worse, nothing recorded the outcome: on
 * success the item was not marked removed, so a third caller could send again; on an unknown outcome
 * nothing was recorded either, so a RETRY of a request that may already have been applied was one
 * call away. The suite passed because it only ever tested the sequential case, where the Host's own
 * `queue-item-not-found` answer happened to hide the duplicate.
 *
 * What replaces it, and what this file asserts:
 *
 *   1. The decision — "is this item still observed, and is it already settled?" — is taken INSIDE the
 *      same per-session lock that orders the sends, so two concurrent callers cannot both send.
 *   2. The outcome is durable: `removed` on a confirmed removal, `uncertain` when bytes reached the
 *      Host and the answer was never proven. Both survive a restart, and both BLOCK a re-send.
 *   3. A refusal decided before any byte was written records nothing, so a network blip cannot
 *      permanently block an item that is provably still present.
 *   4. An `uncertain` row is resolved by OBSERVING the Host's queue without the item, never by
 *      retrying and never by guessing.
 *
 * Non-decorative by construction: the oracle for "was it sent twice?" is the fixture's own request
 * log, and for "was anything sent at all?" the fixture can hold snapshot delivery so the bridge keeps
 * believing an item is still queued. Every case counts requests ON THE HOST, not bridge-side claims.
 *
 * Scope: this fixture is NOT the DSH product. A passing run is evidence about our client against our
 * own fixture, never about the official Host (that layer is `test/isolated-host`).
 */

import { join } from 'node:path';
import { assert, ipcClient, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/**
 * A fixture host, a real daemon child against it, and the ids of one open session.
 * @param {string} label
 * @param {{ autoTurn?: boolean }} [options]
 */
async function rig(label, options = {}) {
  const host = await new FakeHost().start();
  host.autoTurn = options.autoTurn ?? false;
  const scratch = scratchDir(`queue-once-${label}`);
  const stateDir = join(scratch.dir, 'state');
  const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir });
  const ipc = await ipcClient(daemon.socketPath);
  await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 10_000, what: 'the daemon mux downlink to reach ready' });
  const task = await ipc.request({ op: 'task.ensure', clientKey: `t-${label}` });
  const taskId = task.task.taskId;
  const started = await ipc.request({ op: 'session.start', taskId, clientKey: `s-${label}` });
  assert.equal(started.operation.state, 'succeeded', JSON.stringify(started.operation));
  return {
    host, ipc, daemon, stateDir, taskId,
    sessionId: started.session.sessionId,
    hostSessionId: started.session.hostSessionId,
    teardown: async () => {
      try { ipc.close(); } catch { /* already closed */ }
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    },
  };
}

/** The bridge's own view of the Host's pending inbox, as `session.state` reports it. */
async function observedQueue(ipc, taskId, sessionId) {
  const state = await ipc.request({ op: 'session.state', taskId, sessionId });
  return state.queue.remote;
}

/**
 * How many `session.updateQueue` requests the BRIDGE has sent to the Host.
 *
 * Counted from the fixture's request log rather than from any bridge-side report, which is what makes
 * every claim in this file non-decorative. The log is filtered by `rpcId` prefix because a test may
 * legitimately send its own control-plane request to the same Host, and that one must not be counted
 * as the bridge's.
 */
function removalsSent(host) {
  // The bridge's adapter mints a bare UUID with no prefix, so the test's own probes are excluded by
  // the prefix THIS file gives them rather than by guessing at the bridge's format.
  return host.requestsFor('session.updateQueue')
    .filter((row) => !String(row.rpcId ?? '').startsWith('test-probe-')).length;
}

/**
 * One control-plane call to the fixture Host, so a test can act as a second client.
 * @param {string} baseUrl
 * @param {string} method
 * @param {object} [payload]
 */
async function controlCall(baseUrl, method, payload = {}) {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: new URL(baseUrl).host },
    body: JSON.stringify({ type: 'client-request', rpcId: `test-probe-${method}`, method, payload }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* a non-JSON body is reported by the caller */ }
  return { status: response.status, parsed, text };
}

export default {
  'two concurrent callers naming one item produce at most one removal request on the wire': async () => {
    const r = await rig('concurrent');
    try {
      const item = r.host.enqueue(r.hostSessionId, { text: 'one item, two callers' });
      await waitFor(async () => (await observedQueue(r.ipc, r.taskId, r.sessionId)).length === 1,
        { timeoutMs: 5000, what: 'the item to be observed' });
      assert.equal(removalsSent(r.host), 0, 'nothing may be sent before a caller asks');

      // Both callers ask for the SAME item, concurrently, with no ordering between them. This is the
      // shape the defect was about: both requests race to read the snapshot before either has sent.
      //
      // What this case observes is the OUTCOME — one send — and both mechanisms contribute: the
      // decision is now taken under the per-session lock, and the durable ledger settles the item as
      // soon as the first send is confirmed, so the second caller finds it settled. The case does not
      // claim to isolate the lock from the ledger, and it deliberately is not satisfied by the
      // bridge's own report: the count is taken from the fixture's request log.
      const [first, second] = await Promise.all([
        r.ipc.request({ op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id] }),
        r.ipc.request({ op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id] }),
      ]);

      // THE claim: the Host received exactly one removal for this item. Counted at the Host, so no
      // bridge-side report can satisfy it.
      assert.equal(removalsSent(r.host), 1,
        `exactly one removal request may reach the Host for one item, got ${removalsSent(r.host)}: ` +
        `${JSON.stringify(r.host.requestsFor('session.updateQueue').map((row) => row.payload))}`);
      assert.equal(r.host.queueMutations.length, 1,
        `the Host must have applied one mutation, got ${JSON.stringify(r.host.queueMutations)}`);
      assert.deepEqual(r.host.queueItems(r.hostSessionId), [], 'the item must actually be gone');

      // Exactly one caller may report a confirmed removal, and the other must be a typed refusal —
      // never a second success, and never a second send.
      const scopes = [first.remoteScope, second.remoteScope];
      const cleared = scopes.filter((scope) => scope.status === 'cleared');
      const refused = scopes.filter((scope) => scope.status === 'refused');
      assert.equal(cleared.length, 1,
        `exactly one caller may report the removal as confirmed, got ${JSON.stringify(scopes)}`);
      assert.equal(refused.length, 1,
        `the other caller must be refused, got ${JSON.stringify(scopes)}`);
      assert.equal(refused[0].cleared, false, 'a refusal is never a clear');
      assert.deepEqual(refused[0].removed, [], 'a refusal must not claim a removal');
      assert.equal(refused[0].refused.length, 1);
      assert.equal(refused[0].refused[0].sent, false,
        'the losing caller must not have sent anything');
      // Whichever code it carries, it must be one of the two local refusals, not a generic failure:
      // either the snapshot no longer lists the item, or the durable ledger already settled it.
      assert.ok(
        ['queue-item-not-found', 'queue-item-already-removed'].includes(refused[0].refused[0].code),
        `the refusal must be a specific local code, got ${JSON.stringify(refused[0].refused[0])}`);
    } finally {
      await r.teardown();
    }
  },

  'a confirmed removal is not re-sent after a daemon restart, and the ledger survives the restart': async () => {
    const r = await rig('restart');
    let restarted = null;
    try {
      const item = r.host.enqueue(r.hostSessionId, { text: 'removed before the restart' });
      await waitFor(async () => (await observedQueue(r.ipc, r.taskId, r.sessionId)).length === 1,
        { timeoutMs: 5000, what: 'the item to be observed' });
      const removed = await r.ipc.request({ op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id] });
      assert.equal(removed.remoteScope.status, 'cleared', JSON.stringify(removed.remoteScope));
      assert.equal(removalsSent(r.host), 1);

      // Restart the daemon over the SAME state directory. Holding snapshot delivery across the
      // restart is what makes this case bite: the new daemon has no in-memory snapshot, and once the
      // Host re-sends one the item is genuinely absent from it — but if the Host re-sends nothing
      // the observed set is empty too, and an implementation that only consulted the snapshot would
      // have nothing to consult. The durable ledger must be what refuses.
      r.host.holdQueueSnapshots(r.hostSessionId);
      const pid = Number((await r.ipc.request({ op: 'health' })).pid);
      r.ipc.close();
      await r.daemon.stop();
      await waitFor(() => {
        try { process.kill(pid, 0); return false; } catch { return true; }
      }, { timeoutMs: 20_000, what: 'the daemon process to exit before restarting' });

      const daemon2 = await startDaemon({ hostBase: r.host.baseUrl, stateDir: r.stateDir });
      const ipc2 = await ipcClient(daemon2.socketPath);
      restarted = { daemon: daemon2, ipc: ipc2 };
      await waitFor(async () => (await ipc2.request({ op: 'health' })).connection === 'ready',
        { timeoutMs: 10_000, what: 'the restarted daemon to attach' });

      // The durable claim, read directly: the ledger row survived the process restart. This is what
      // "durable" means here, and it is asserted on the ledger itself rather than inferred from a
      // downstream refusal — because a restarted daemon has NO in-memory snapshot, so a refusal could
      // otherwise be produced by the binding alone and this case would prove nothing about durability.
      const restartedLedger = (await ipc2.request({ op: 'session.state', taskId: r.taskId, sessionId: r.sessionId }))
        .queue.removalLedger;
      const survived = restartedLedger.find((row) => row.itemId === item.id);
      assert.ok(survived,
        `the removal ledger must survive a restart, got ${JSON.stringify(restartedLedger)}`);
      assert.equal(survived.state, 'removed',
        'the Host confirmed this removal, so the restarted daemon must still know it was removed');

      // And the restarted daemon must refuse the item without sending anything.
      const afterRestart = await ipc2.request({ op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id] });
      assert.equal(afterRestart.remoteScope.cleared, false,
        'a removal already confirmed before the restart must not be reported as cleared again');
      assert.deepEqual(afterRestart.remoteScope.removed, [],
        'a re-request must not be reported as a fresh removal');
      assert.equal(afterRestart.remoteScope.refused.length, 1);
      assert.equal(afterRestart.remoteScope.refused[0].sent, false,
        'the restart must not turn a settled removal into a second send');
      assert.equal(removalsSent(r.host), 1,
        `the Host must still have received exactly one removal, got ${removalsSent(r.host)}`);

      // Now release the snapshot, so the restarted daemon observes the queue as it really is. The
      // refusal must not change into a send, and the ledger must still say the item is gone.
      r.host.releaseQueueSnapshots(r.hostSessionId);
      await waitFor(async () => (await observedQueue(ipc2, r.taskId, r.sessionId)).length === 0,
        { timeoutMs: 5000, what: 'the released snapshot to show an empty queue' });
      const settled = await ipc2.request({ op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id] });
      assert.equal(settled.remoteScope.refused[0].sent, false);
      assert.equal(removalsSent(r.host), 1, 'observing an empty queue must not cause a send either');
      const finalLedger = (await ipc2.request({ op: 'session.state', taskId: r.taskId, sessionId: r.sessionId }))
        .queue.removalLedger.find((row) => row.itemId === item.id);
      assert.equal(finalLedger?.state, 'removed',
        'observing the queue without the item must not disturb a confirmed removal');
    } finally {
      if (restarted) {
        try { restarted.ipc.close(); } catch { /* already closed */ }
        await restarted.daemon.stop();
      }
      await r.teardown();
    }
  },

  'an outcome that was never proven blocks a retry, and a fresh queue snapshot without the item resolves it': async () => {
    const r = await rig('uncertain');
    try {
      const item = r.host.enqueue(r.hostSessionId, { text: 'outcome never proven' });
      await waitFor(async () => (await observedQueue(r.ipc, r.taskId, r.sessionId)).length === 1,
        { timeoutMs: 5000, what: 'the item to be observed' });

      // Hold snapshot delivery so the daemon keeps believing the item is still queued, then use the
      // fixture's own `dropResponseFor`: the request is ACCEPTED AND APPLIED and the reply is
      // discarded with the socket destroyed. That is the honest uncertain path — bytes reached the
      // Host, the outcome was never proven — and it is produced by the fixture rather than asserted
      // as an intention by this test.
      r.host.holdQueueSnapshots(r.hostSessionId);
      r.host.dropResponseFor('session.updateQueue');
      const unproven = await r.ipc.request({ op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id] });
      const sent = removalsSent(r.host);
      r.host.stopDropping('session.updateQueue');

      assert.ok(sent >= 1, 'the request must have reached the Host for the outcome to be unprovable');
      assert.deepEqual(r.host.queueItems(r.hostSessionId), [],
        'the fixture must have APPLIED the removal, so "unproven" is the truth rather than "not applied"');
      assert.notEqual(unproven.remoteScope.status, 'cleared',
        'an unproven removal must never be reported as cleared');
      assert.ok(unproven.remoteScope.uncertain.length >= 1,
        `an unproven removal must be reported as uncertain, got ${JSON.stringify(unproven.remoteScope)}`);

      // THE claim: a retry must NOT be sent. The item is still in the held snapshot, so a snapshot-only
      // decision would send again — a second destructive request for an occurrence that may already be
      // gone. The ledger is what stops it.
      const retry = await r.ipc.request({ op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id] });
      assert.equal(removalsSent(r.host), sent,
        `an unproven outcome must not be retried automatically: sent went from ${sent} to ${removalsSent(r.host)}`);
      assert.equal(retry.remoteScope.refused.length, 1);
      assert.equal(retry.remoteScope.refused[0].code, 'queue-item-removal-uncertain',
        `the retry must be refused as still-unproven, got ${JSON.stringify(retry.remoteScope.refused[0])}`);
      assert.equal(retry.remoteScope.refused[0].sent, false);
      assert.equal(retry.remoteScope.cleared, false);

      // Resolution is by OBSERVATION, not by retrying: release the snapshot, and the item's absence
      // from the Host's own queue is what settles the outcome.
      r.host.releaseQueueSnapshots(r.hostSessionId);
      await waitFor(async () => (await observedQueue(r.ipc, r.taskId, r.sessionId)).length === 0,
        { timeoutMs: 5000, what: 'the Host snapshot to show the queue without the item' });

      // The ledger itself is what the resolution changed, so it is read directly rather than inferred
      // from a downstream report. `removed` here means the bridge now KNOWS the item is gone — the
      // outcome stopped being unproven because the Host's own queue was observed without it.
      const ledger = async () => (await r.ipc.request({ op: 'session.state', taskId: r.taskId, sessionId: r.sessionId }))
        .queue.removalLedger;
      const resolved = (await ledger()).find((row) => row.itemId === item.id);
      assert.ok(resolved, `the item must have a ledger row, got ${JSON.stringify(await ledger())}`);
      assert.equal(resolved.state, 'removed',
        'observing the Host queue without the item must settle the unproven removal as removed, got '
        + JSON.stringify(resolved));

      const afterObservation = await r.ipc.request({ op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id] });
      assert.equal(removalsSent(r.host), sent, 'resolution must not send anything either');
      assert.equal(afterObservation.remoteScope.cleared, false,
        'the observation settles the ledger, it does not retroactively claim a confirmed clear');
      assert.deepEqual(afterObservation.remoteScope.removed, [], 'and it must not report a removal');
      assert.equal(afterObservation.remoteScope.refused[0].sent, false);
      // Either local refusal is correct here and both are honest: the snapshot no longer lists the
      // item, and the ledger has settled it. What must NOT happen is a send, a clear, or a claim.
      assert.ok(
        ['queue-item-not-found', 'queue-item-already-removed'].includes(afterObservation.remoteScope.refused[0].code),
        'the request must be refused locally, got ' + JSON.stringify(afterObservation.remoteScope.refused[0]),
      );
    } finally {
      await r.teardown();
    }
  },

  'with the observed snapshot still listing a settled item, the ledger alone refuses the second send': async () => {
    const r = await rig('ledger-only');
    try {
      const item = r.host.enqueue(r.hostSessionId, { text: 'settled while the snapshot was held' });
      await waitFor(async () => (await observedQueue(r.ipc, r.taskId, r.sessionId)).length === 1,
        { timeoutMs: 5000, what: 'the item to be observed' });

      // Hold delivery AFTER the item was observed. The daemon now believes the item is still queued
      // and will keep believing it: no further frame arrives. The Host applies the removal and
      // confirms it, so the ledger settles — while the bridge's observed snapshot still LISTS the
      // item. That combination is the one where nothing but the ledger can prevent a second send, and
      // it is a real ordering rather than a contrivance: the removal's confirmation rides HTTP and
      // the inbox snapshot rides the WebSocket, so a stale snapshot arriving after a confirmed removal
      // is exactly what the wire permits.
      r.host.holdQueueSnapshots(r.hostSessionId);
      const first = await r.ipc.request({ op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id] });
      assert.equal(first.remoteScope.status, 'cleared', JSON.stringify(first.remoteScope));
      assert.equal(removalsSent(r.host), 1);

      // Both conditions are now in place, asserted so the case cannot pass vacuously: the item is
      // still in the bridge's observed snapshot, and the ledger says it is settled.
      const state = await r.ipc.request({ op: 'session.state', taskId: r.taskId, sessionId: r.sessionId });
      assert.deepEqual(state.queue.remote.map((row) => row.itemId), [item.id],
        'this case requires the observed snapshot to STILL list the item, otherwise the binding would '
        + 'refuse on its own and the ledger would not be tested');
      assert.equal(state.queue.removalLedger.find((row) => row.itemId === item.id)?.state, 'removed',
        'and the ledger must have settled it');

      const retry = await r.ipc.request({ op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id] });
      assert.equal(retry.remoteScope.refused[0].code, 'queue-item-already-removed',
        `the ledger must be the thing that refuses, got ${JSON.stringify(retry.remoteScope.refused[0])}`);
      assert.equal(retry.remoteScope.refused[0].sent, false);
      assert.equal(retry.remoteScope.cleared, false);
      assert.equal(removalsSent(r.host), 1,
        `nothing may be sent for a settled item even when the snapshot still lists it, got ${removalsSent(r.host)}`);

      r.host.releaseQueueSnapshots(r.hostSessionId);
      await waitFor(async () => (await observedQueue(r.ipc, r.taskId, r.sessionId)).length === 0,
        { timeoutMs: 5000, what: 'the released snapshot to arrive' });
    } finally {
      await r.teardown();
    }
  },

  "the host's own not-pending answer settles the item, so the duplicate is refused here and not by the host": async () => {
    const r = await rig('not-pending');
    try {
      const item = r.host.enqueue(r.hostSessionId, { text: 'already gone at the host' });
      await waitFor(async () => (await observedQueue(r.ipc, r.taskId, r.sessionId)).length === 1,
        { timeoutMs: 5000, what: 'the item to be observed' });

      // Hold the snapshot so the bridge keeps believing the item is queued, then have the Host drop
      // it WITHOUT a removal: the Agent claimed it. The next removal therefore meets a Host that has
      // no such pending item and answers `queue-item-not-found` — a definite refusal, and the fact
      // that there is nothing left to remove.
      r.host.holdQueueSnapshots(r.hostSessionId);
      // The item is removed by ANOTHER client speaking to the Host directly — a real control-plane
      // request, not a fixture shortcut. The bridge never learns: snapshot delivery is held, so its
      // observed snapshot still lists the item. Its own removal therefore meets a Host that no longer
      // has anything to remove.
      const direct = await controlCall(r.host.baseUrl, 'session.updateQueue', {
        sessionId: r.hostSessionId, itemId: item.id, action: { kind: 'remove' },
      });
      assert.equal(direct.parsed?.result?.ok, true,
        `the direct removal must be applied by the Host, got ${direct.text.slice(0, 200)}`);
      assert.deepEqual(r.host.queueItems(r.hostSessionId), [], 'the item must really be gone');
      assert.equal(removalsSent(r.host), 0,
        'the direct removal must not be conflated with a bridge-sent removal');

      const first = await r.ipc.request({ op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id] });
      assert.equal(first.remoteScope.status, 'refused', JSON.stringify(first.remoteScope));
      assert.equal(first.remoteScope.refused[0].code, 'queue-item-not-found',
        `the Host's own code must be surfaced: ${JSON.stringify(first.remoteScope.refused[0])}`);
      assert.equal(first.remoteScope.refused[0].sent, true, 'this refusal came from the Host');
      const sent = removalsSent(r.host);
      assert.equal(sent, 1);

      // The item is settled as `not-pending`. That is neither a removal nor an unknown outcome, and
      // it is what stops the next attempt.
      const ledgerRow = (await r.ipc.request({ op: 'session.state', taskId: r.taskId, sessionId: r.sessionId }))
        .queue.removalLedger.find((row) => row.itemId === item.id);
      assert.equal(ledgerRow?.state, 'not-pending',
        `the Host's definite answer must settle the item, got ${JSON.stringify(ledgerRow)}`);

      // THE claim the coordinator asked for: the duplicate is refused HERE, without a second request.
      // Before this, safety depended on the Host answering `queue-item-not-found` a second time —
      // which a Host is not obliged to do, and which a lost first answer would not reach at all.
      const retry = await r.ipc.request({ op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id] });
      assert.equal(retry.remoteScope.refused[0].code, 'queue-item-not-pending',
        `the duplicate must be refused locally, got ${JSON.stringify(retry.remoteScope.refused[0])}`);
      assert.equal(retry.remoteScope.refused[0].sent, false, 'and must not reach the wire');
      assert.equal(removalsSent(r.host), sent,
        `the Host must not be asked twice, got ${removalsSent(r.host)} requests`);

      r.host.releaseQueueSnapshots(r.hostSessionId);
    } finally {
      await r.teardown();
    }
  },
};
