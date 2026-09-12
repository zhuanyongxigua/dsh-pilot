/**
 * Persistence layer: FR-CANCEL-1 — a removal attempt that reached the Host survives a REAL process
 * crash, and the item is never removed twice.
 *
 * The defect these cases exist for. `queueClear` recorded its ledger row (`queue_removals`) only
 * AFTER `#dispatch` returned, and each call minted a fresh `randomUUID` operation, so the ledger was
 * the ONLY place a removal attempt could be remembered. The window between the Host applying a
 * `remove` and that write is therefore a hole: a process killed inside it leaves no ledger row, the
 * item still looks untouched, and the next `queueClear` — possibly from a different caller — sends a
 * SECOND destructive request for the same occurrence. The item's continued presence in the observed
 * `session/queue` snapshot is not evidence that the first removal did not happen: the snapshot is
 * re-broadcast on the Host's schedule and can be stale.
 *
 * The fix uses the index that has no such hole. `#dispatch` persists the operation as `pending` and
 * then `dispatching` BEFORE writing any byte, so every attempt that could possibly have reached the
 * Host is already on disk with its item id in `request_json`. On restart, `recover()` reconciles
 * every `session.updateQueue` remove attempt that has no ledger row against that operation's durable
 * state: `pending`/`refused` prove nothing was applied and stay retryable, while `succeeded`
 * (confirmed or not) and `uncertain` settle the item so a blind re-send cannot happen.
 *
 * Oracles. The Host's own request log is the count of removals it received — never a bridge-side
 * report — and the crash is a real SIGKILL of a real daemon child. The timing window is opened by a
 * BARRIER in the fixture that holds the response AFTER applying it, so nothing here guesses at a
 * sleep duration and no case is retried until it happens to pass.
 *
 * Scope: the fixture is NOT the DSH product. This is evidence about our client against our own
 * fixture; the official-Host layer is `test/isolated-host`.
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assert, ipcClient, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/**
 * A fake Host, a real daemon child over a fresh state directory, one task and one session.
 * @param {string} label
 */
async function boot(label) {
  const host = await new FakeHost().start();
  const scratch = scratchDir(`removal-crash-${label}`);
  const stateDir = join(scratch.dir, 'state');
  const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir });
  const ipc = await ipcClient(daemon.socketPath);
  await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 10_000, what: `[${label}] the daemon mux downlink to reach ready` });
  const task = await ipc.request({ op: 'task.ensure', clientKey: `t-${label}` });
  const started = await ipc.request({ op: 'session.start', taskId: task.task.taskId, clientKey: `s-${label}` });
  assert.equal(started.operation.state, 'succeeded', JSON.stringify(started.operation));
  return {
    host, scratch, stateDir, daemon, ipc,
    taskId: task.task.taskId,
    hostSessionId: started.session.hostSessionId,
    sessionId: started.session.sessionId,
    teardown: async () => {
      try { ipc.close(); } catch { /* already closed */ }
      await daemon.stop();
      try { await host.stop(); } catch { /* already stopped */ }
      scratch.cleanup();
    },
  };
}

/**
 * The bridge's own view of the Host's pending inbox, as `session.state` reports it: the observed
 * `session/queue` snapshot, at `queue.remote`. Named once here rather than inlined, because reading
 * the wrong path in a wait condition is how a test silently measures nothing.
 * @param {any} ipc @param {string} taskId @param {string} sessionId
 */
async function observedQueue(ipc, taskId, sessionId) {
  const state = await ipc.request({ op: 'session.state', taskId, sessionId });
  return state.queue.remote ?? [];
}

/**
 * Enqueue an occurrence and wait until the bridge has OBSERVED it. The id comes from the fixture,
 * because the bridge refuses to remove an item it has never seen — a hand-picked id would exercise
 * the refusal path rather than the removal path.
 * @param {Awaited<ReturnType<typeof boot>>} r
 */
async function queueOneItem(r) {
  const item = r.host.enqueue(r.hostSessionId, { text: 'the occurrence whose removal is crashed' });
  await waitFor(async () => (await observedQueue(r.ipc, r.taskId, r.sessionId)).length === 1,
    { timeoutMs: 5000, what: 'the bridge to observe the queued occurrence' });
  return item;
}

/** The daemon's pid, read from its own health reply rather than from the spawn handle. */
async function daemonPid(ipc) {
  const health = await ipc.request({ op: 'health' });
  return Number(health.pid);
}

/** Wait for a pid to be gone, so the next daemon is not refused as a second owner. */
async function waitForExit(pid) {
  await waitFor(() => {
    try { process.kill(pid, 0); return false; } catch { return true; }
  }, { timeoutMs: 20_000, what: `daemon pid ${pid} to exit` });
}

/**
 * Start a daemon over an existing state directory, as the operator's restart would.
 * @param {string} stateDir @param {string} hostBaseUrl
 */
async function startOver(stateDir, hostBaseUrl) {
  const daemon = await startDaemon({ hostBase: hostBaseUrl, stateDir });
  const ipc = await ipcClient(daemon.socketPath);
  await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 10_000, what: 'the restarted daemon to attach' });
  return { daemon, ipc };
}

/**
 * The durable removal ledger entries for one item, read directly so the assertion is on the row
 * rather than on a summary the bridge produced.
 * @param {string} stateDir @param {string} itemId
 */
function ledgerFor(stateDir, itemId) {
  const db = new DatabaseSync(join(stateDir, 'state.sqlite'), { readOnly: true });
  try {
    return db.prepare('select item_id, state, operation_id from queue_removals').all()
      .map((row) => ({ itemId: String(row.item_id), state: String(row.state), operationId: String(row.operation_id) }))
      .filter((row) => row.itemId === itemId);
  } finally {
    db.close();
  }
}

export default {
  'FR-CANCEL-1 crash: the Host applied the removal and the process died before the ledger was written, so the item is never removed twice': async () => {
    const r = await boot('applied-then-killed');
    /** @type {{daemon: any, ipc: any}|null} */
    let revived = null;
    /** @type {any} */
    let second = null;
    try {
      const item = await queueOneItem(r);
      const pid = await daemonPid(r.ipc);
      // Hold the response AFTER the Host applies the removal. The barrier is reached only once the
      // removal is genuinely applied, so the kill below happens with it already done.
      r.host.barrierFor('session.updateQueue');
      const clearing = r.ipc.request({
        op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id],
      }).catch(() => null);

      await waitFor(() => r.host.barrierReached('session.updateQueue'),
        { timeoutMs: 10_000, what: 'the Host to apply the removal and hold its response' });
      assert.equal(r.host.requestsFor('session.updateQueue').length, 1,
        'the Host must have received exactly one removal when the process is killed');
      assert.deepEqual(r.host.queueItems(r.hostSessionId), [],
        'the Host must have APPLIED the removal, not merely received it');

      process.kill(pid, 'SIGKILL');
      await clearing;
      await waitForExit(pid);
      // The precondition is measured, not assumed: the ledger must be empty, or the crash did not land
      // in the window this case exists for.
      assert.deepEqual(ledgerFor(r.stateDir, item.id), [],
        'this case is only meaningful if the ledger is EMPTY when the process dies');

      // A local const, so the wait's closure reads a value the compiler can see is not null rather
      // than the outer mutable handle.
      const after = await startOver(r.stateDir, r.host.baseUrl);
      revived = after;
      // The Host re-reports the SAME occurrence, and it does so AFTER the restarted daemon is
      // connected: a snapshot broadcast to nobody would leave the item unobserved, and the bridge
      // refuses an item it has never seen for a separate, legitimate reason — so the snapshot guard
      // would answer first and the ledger, which is what this case is about, would never be consulted.
      // Whether the removal was not applied yet or the queue event merely lagged, the effect is the
      // same, and it is the effect the finding describes.
      r.host.enqueue(r.hostSessionId, { id: item.id, text: 'the same occurrence, re-reported by the host' });
      await waitFor(async () => (await observedQueue(after.ipc, r.taskId, r.sessionId)).length === 1,
        { timeoutMs: 5000, what: 'the restarted daemon to observe the re-reported occurrence' });
      // The restart, then the SECOND, INDEPENDENT caller clearing the same item. The order matters:
      // the claim this case exists for is the one about the WIRE, so it is asserted first and from the
      // Host's own request log. Asserting the ledger state first would fail under a broken
      // implementation with "no ledger row" — true, but a statement about our own bookkeeping rather
      // than about the second destructive request that reached the Host because of it.
      second = await ipcClient(revived.daemon.socketPath);
      const reply = await second.request({
        op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id],
      });
      const removalsForItem = r.host.requestsFor('session.updateQueue')
        .filter((row) => row.payload?.itemId === item.id).length;
      assert.equal(removalsForItem, 1,
        `the Host must have received exactly ONE removal for this item, ever, even though the item was `
        + `re-reported in its snapshot: got ${removalsForItem}. A second one means a crash in this window `
        + 'turns one destructive request into two.');

      const settled = ledgerFor(r.stateDir, item.id);
      assert.equal(settled.length, 1,
        `the restart must settle the orphaned removal attempt in the ledger, found ${JSON.stringify(settled)}`);
      // The operation never returned, so its outcome is unproven — never `removed`. Claiming `removed`
      // would assert a fact nobody observed; recording nothing would invite the duplicate.
      assert.equal(settled[0].state, 'uncertain',
        `an attempt killed in flight must settle as unproven, got ${JSON.stringify(settled[0])}`);

      const stateAfter = await revived.ipc.request({ op: 'session.state', taskId: r.taskId, sessionId: r.sessionId });
      const ledgerReport = stateAfter.queue?.removalLedger ?? [];
      assert.equal(ledgerReport.find((entry) => entry.itemId === item.id)?.state, 'uncertain',
        `the unproven removal must be visible to a caller, got ${JSON.stringify(ledgerReport)}`);

      // And the second caller is refused LOCALLY, for the unproven removal, without a request. The
      // bridge must not be relying on the Host to reject the duplicate: a Host-side rejection is not a
      // defence, because it is the Host that would have applied a second removal if it still held one.
      const shaped = /** @type {{remoteScope?: {refused?: {code?: string, sent?: boolean}[], uncertain?: unknown[]}}} */ (reply);
      assert.equal(shaped.remoteScope?.refused?.[0]?.code, 'queue-item-removal-uncertain',
        `the second caller must be refused locally for an unproven removal, got ${JSON.stringify(reply)}`);
      assert.equal(shaped.remoteScope?.refused?.[0]?.sent, false,
        'and the refusal must say nothing was sent');
      assert.equal(shaped.remoteScope?.uncertain?.length ?? 0, 0,
        'and it must NOT be reported as a fresh uncertain attempt, because nothing was sent');
      assert.equal(r.host.respondReceipts.length, 0, 'no approval receipt is involved in a queue removal');
    } finally {
      r.host.releaseBarrier('session.updateQueue');
      if (second) { try { second.close(); } catch { /* already closed */ } }
      if (revived) { try { revived.ipc.close(); } catch { /* already closed */ } await revived.daemon.stop(); }
      await r.teardown();
    }
  },

  'FR-CANCEL-1 crash: an ack persisted but never written to the ledger settles as removed, and is refused without a send': async () => {
    // The other half of the same window, reached without a crash: the operation is on disk carrying
    // the Host's confirmation and the ledger write is the one thing missing. That state is written
    // here the way a crash would leave it — a real state directory, real rows, the real schema and its
    // real constraints — and then a real daemon is started over it. Reproducing the state rather than
    // racing to crash inside it is deliberate: the window is a few statements wide, and a test that
    // had to win a race would be a test that sometimes passes.
    const host = await new FakeHost().start();
    const scratch = scratchDir('removal-crash-acked');
    const stateDir = join(scratch.dir, 'state');
    /** @type {any} */
    let first = null;
    /** @type {any} */
    let restarted = null;
    try {
      first = await startDaemon({ hostBase: host.baseUrl, stateDir });
      const ipc = await ipcClient(first.socketPath);
      await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
        { timeoutMs: 10_000, what: 'the first daemon to attach' });
      const task = await ipc.request({ op: 'task.ensure', clientKey: 'acked' });
      const taskId = task.task.taskId;
      const started = await ipc.request({ op: 'session.start', taskId, clientKey: 'acked-session' });
      const hostSessionId = started.session.hostSessionId;
      const sessionId = started.session.sessionId;
      const item = host.enqueue(hostSessionId, { text: 'removal already confirmed by the host' });
      await waitFor(async () => (await observedQueue(ipc, taskId, sessionId)).length === 1,
        { timeoutMs: 5000, what: 'the queued occurrence to be observed' });
      ipc.close();
      await first.stop();
      first = null;

      const db = new DatabaseSync(join(stateDir, 'state.sqlite'), { readOnly: false });
      try {
        const countRow = db.prepare('select count(*) as n from queue_removals').get();
        assert.equal(Number(countRow?.n ?? -1), 0,
          'the crash state must have no ledger row, or this case is not testing the window it names');
        db.prepare(
          `insert into operations(operation_id, task_id, session_id, kind, state, idempotency_key,
             payload_digest, request_id, request_json, response_json, created_at, updated_at)
           values (?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          'operation_crash_acked_window', taskId, sessionId, 'session.updateQueue', 'succeeded',
          'queue-remove:crash-window:fixture', 'digest-fixture', 'request-fixture',
          JSON.stringify({ sessionId: hostSessionId, itemId: item.id, action: { kind: 'remove' } }),
          JSON.stringify({ accepted: true }), Date.now() - 1000, Date.now() - 1000,
        );
      } finally {
        db.close();
      }

      const after = await startOver(stateDir, host.baseUrl);
      restarted = after;
      // The restarted daemon has no in-memory snapshot, so it has to receive one before the LEDGER can
      // be the thing that refuses — and the re-broadcast has to come after it connects.
      //
      // A plain re-broadcast, not a re-enqueue: the occurrrence was never removed from this Host, so it
      // is still in the queue and adding it again would put TWO items with this id there. That would
      // also be observed as two items, and this case would then be measuring a queue the Host cannot
      // really be in.
      host.emitQueueSnapshot(hostSessionId);
      await waitFor(async () => (await observedQueue(after.ipc, taskId, sessionId)).length === 1,
        { timeoutMs: 5000, what: 'the restarted daemon to observe the still-queued occurrence' });
      try {
        const settled = ledgerFor(stateDir, item.id);
        assert.equal(settled.length, 1,
          `recovery must settle an acked-but-unrecorded removal, found ${JSON.stringify(settled)}`);
        assert.equal(settled[0].state, 'removed',
          `the Host's own confirmation is durable on disk, so it must settle as removed, got ${JSON.stringify(settled[0])}`);

        const reply = await restarted.ipc.request({ op: 'queue.clear', taskId, sessionId, itemIds: [item.id] });
        const shaped = /** @type {{remoteScope?: {refused?: {code?: string}[]}}} */ (reply);
        assert.equal(shaped.remoteScope?.refused?.[0]?.code, 'queue-item-already-removed',
          `a confirmed removal must be refused as already removed, got ${JSON.stringify(reply)}`);
        assert.equal(host.requestsFor('session.updateQueue').length, 0,
          'the Host must receive NO removal at all: the case is refused from the durable ledger, locally');
      } finally {
        restarted.ipc.close();
      }
    } finally {
      if (first) await first.stop();
      if (restarted) await restarted.daemon.stop();
      await host.stop();
      scratch.cleanup();
    }
  },

  'FR-CANCEL-1: a removal that provably never left the process stays retryable across a restart': async () => {
    // The counter-case that keeps the fix from becoming a blanket lock. An attempt whose send failed
    // before any byte was written is provably unapplied, so it must NOT be recorded as a block: the
    // operator's later retry has to be able to reach the Host. If recovery wrote `uncertain` for every
    // orphaned attempt, this case would fail by finding a block where there should be none.
    const r = await boot('provably-unsent');
    /** @type {{daemon: any, ipc: any}|null} */
    let revived = null;
    /** @type {any} */
    let host2 = null;
    try {
      const item = await queueOneItem(r);
      const pid = await daemonPid(r.ipc);
      // Force a DETERMINISTIC refusal from the Host that is already running, rather than taking the
      // Host away: a refused envelope means the Host never applied anything, so "not sent" is a fact
      // about the protocol rather than a guess — and it keeps the same origin, so the restarted daemon
      // can still answer questions about this task (a different Host is a different owner, which is
      // its own error and would make this case fail for an unrelated reason).
      r.host.rejectWith('session.updateQueue', { code: 'agent-busy', message: 'fixture refusal for the retryable case' });
      const refused = await r.ipc.request({
        op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id],
      });
      assert.deepEqual(r.host.queueItems(r.hostSessionId).map((entry) => entry.id), [item.id],
        'a refused removal must leave the occurrence exactly where it was');
      const shaped = /** @type {{remoteScope?: {refused?: {code?: string}[], uncertain?: unknown[], status?: string}}} */ (refused);
      assert.ok((shaped.remoteScope?.refused?.length ?? 0) + (shaped.remoteScope?.uncertain?.length ?? 0) > 0,
        `a refused removal must be reported, got ${JSON.stringify(refused)}`);
      assert.notEqual(shaped.remoteScope?.status, 'cleared',
        'and it must not be reported as a removal');
      // Read the operation row the refusal left behind, so the reconciliation's input is measured.
      const db = new DatabaseSync(join(r.stateDir, 'state.sqlite'), { readOnly: true });
      /** @type {string} */
      let operationState = '';
      try {
        const row = db.prepare(
          "select state from operations where kind = 'session.updateQueue' order by created_at desc limit 1",
        ).get();
        operationState = String(row?.state ?? '');
      } finally {
        db.close();
      }
      assert.ok(operationState === 'refused' || operationState === 'pending',
        `this case is about an attempt that provably never left the process, but the operation is ${operationState}`);

      // Kill and restart, so recovery runs over that attempt.
      process.kill(pid, 'SIGKILL');
      await waitForExit(pid);
      assert.deepEqual(ledgerFor(r.stateDir, item.id), [],
        'a provably-unsent attempt must leave no ledger row at all, which is what keeps the item retryable');

      // Back to the SAME Host with the refusal lifted. The origin is unchanged, which is what keeps this
      // case about the ledger rather than about reattaching to a different owner.
      r.host.stopRejecting('session.updateQueue');
      const after = await startOver(r.stateDir, r.host.baseUrl);
      revived = after;
      // Recovery must not have recorded anything for this item, and the caller must be able to SEE that
      // it was not recorded — a block hidden from the caller would be just as wrong as a lock.
      assert.deepEqual(ledgerFor(r.stateDir, item.id), [],
        'recovery must not block an item whose attempt provably never left the process');
      // The occurrence must be visible to the restarted daemon before a retry is even meaningful.
      r.host.emitQueueSnapshot(r.hostSessionId);
      await waitFor(async () => (await observedQueue(after.ipc, r.taskId, r.sessionId)).length === 1,
        { timeoutMs: 5000, what: 'the restarted daemon to observe the still-queued occurrence' });
      const report = await after.ipc.request({ op: 'session.state', taskId: r.taskId, sessionId: r.sessionId });
      const ledgerReport = report.queue?.removalLedger ?? [];
      assert.deepEqual(ledgerReport.filter((entry) => entry.itemId === item.id), [],
        `the reported ledger must be empty for it, so a caller sees it as retryable, got ${JSON.stringify(ledgerReport)}`);

      // THE assertion of this case, and the reason it is an end-to-end retry rather than a flag check:
      // an item that was provably never applied must still be removable. A recovery that wrote a
      // blanket block would fail HERE, by never reaching the Host — which is exactly the failure a
      // caller would experience, whereas an internally-consistent flag could look correct and still
      // leave the operator unable to clear their queue.
      const retry = await after.ipc.request({
        op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id],
      });
      const retryScope = /** @type {{remoteScope?: {status?: string, removed?: string[]}}} */ (retry).remoteScope;
      assert.equal(retryScope?.status, 'cleared',
        `the retry must be allowed to succeed, got ${JSON.stringify(retry)}`);
      assert.deepEqual(retryScope?.removed, [item.id], 'and the Host must have removed that item');
      assert.deepEqual(r.host.queueItems(r.hostSessionId), [],
        'the Host must actually have applied the retry');
      assert.equal(r.host.requestsFor('session.updateQueue').length, 2,
        'the retry has to reach the Host: one refused attempt and one applied retry');
      assert.equal(ledgerFor(r.stateDir, item.id)[0]?.state, 'removed',
        'and the confirmed retry must settle the ledger');
      process.stdout.write(
        `      measurement: the refused attempt left operation state "${operationState}" and no ledger row, `
        + 'so recovery kept the item retryable and the retry reached the Host\n',
      );
    } finally {
      if (revived) { try { revived.ipc.close(); } catch { /* already closed */ } await revived.daemon.stop(); }
      await r.teardown();
    }
  },

  'FR-CANCEL-1: the reconciler reads the response the REAL successful path persists, so a confirmed removal is never downgraded': async () => {
    // The loop the hand-written crash state in the case above leaves open: that case asserts the
    // reconciler's classification of a row a TEST wrote. If the real `#dispatch`/`markAcknowledged`
    // path persisted a differently-shaped value, the reconciler would misread every real success —
    // over-conservatively as `uncertain`, or worse as a removal that never happened. So this case
    // performs a real, confirmed removal through the bridge, deletes ONLY the ledger row (which is
    // precisely the state the crash window leaves behind, with a real operation row), and asserts the
    // restart reclassifies it as `removed`.
    const r = await boot('real-response');
    /** @type {{daemon: any, ipc: any}|null} */
    let revived = null;
    try {
      const item = await queueOneItem(r);
      const removed = await r.ipc.request({
        op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id],
      });
      assert.equal(/** @type {any} */ (removed).remoteScope?.status, 'cleared', JSON.stringify(removed));
      assert.equal(ledgerFor(r.stateDir, item.id)[0]?.state, 'removed',
        'the real path must settle a confirmed removal as removed');

      // Read what the real path persisted, and assert the reconciler's own test is the right one.
      const db = new DatabaseSync(join(r.stateDir, 'state.sqlite'), { readOnly: false });
      /** @type {{response_json: unknown} | undefined} */
      let persisted;
      try {
        persisted = /** @type {any} */ (db.prepare(
          "select response_json from operations where kind = 'session.updateQueue' and state = 'succeeded'",
        ).get());
        assert.ok(persisted, 'a confirmed removal must leave a succeeded operation');
        const parsed = JSON.parse(String(persisted.response_json));
        assert.equal(parsed?.accepted, true,
          `the reconciler looks for \`accepted === true\` at the top level of this value; the real path `
          + `persisted ${JSON.stringify(parsed)}, which it would NOT read as a confirmation, so a real `
          + 'confirmed removal would be downgraded to unproven after a crash');
        // Delete ONLY the ledger row: the crash state, but built from a real operation.
        db.prepare('delete from queue_removals where item_id = ?').run(item.id);
      } finally {
        db.close();
      }
      const pid = await daemonPid(r.ipc);
      process.kill(pid, 'SIGKILL');
      await waitForExit(pid);

      const after = await startOver(r.stateDir, r.host.baseUrl);
      revived = after;
      assert.equal(ledgerFor(r.stateDir, item.id)[0]?.state, 'removed',
        'the reconciler must read the real persisted ack as the confirmation it is');
      // And the durable removal must not be undone into a second send.
      r.host.emitQueueSnapshot(r.hostSessionId);
      await waitFor(async () => (await observedQueue(after.ipc, r.taskId, r.sessionId)).filter((entry) => entry.id === item.id).length === 0,
        { timeoutMs: 5000, what: 'the Host to report the item as gone' });
      const reply = await after.ipc.request({ op: 'queue.clear', taskId: r.taskId, sessionId: r.sessionId, itemIds: [item.id] });
      const shaped = /** @type {any} */ (reply);
      assert.notEqual(shaped.remoteScope?.status, 'cleared', 'a settled removal must not be repeated');
      assert.equal(r.host.requestsFor('session.updateQueue').filter((row) => row.payload?.itemId === item.id).length, 1,
        'the Host must have received exactly one removal in the whole case');
    } finally {
      if (revived) { try { revived.ipc.close(); } catch { /* already closed */ } await revived.daemon.stop(); }
      await r.teardown();
    }
  },
};
