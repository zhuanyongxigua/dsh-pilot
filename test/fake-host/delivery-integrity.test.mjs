/**
 * Two defects found by driving the approval and queue paths, fixed, and pinned here.
 *
 * Both were the same shape of bug: the daemon read the Host's value ONE LEVEL TOO DEEP, because a
 * comment described the adapter's result as an envelope (`{value, rpcId}`) when it is not. Measured
 * against the fixture, `adapter.call()` returns
 *
 *     { status: 'ok', value: { sessionId: '…' }, rpcId: '…' }
 *
 * so `result.value` IS the Host's payload and `result.value['value']` is a key that never exists. The
 * consequences were silent rather than loud, which is why they survived until someone read the code
 * with that measurement in hand:
 *
 *   1. **The durable ack lost every value.** `markAcknowledged({ value: result.value['value'] })`
 *      always stored `undefined`, so the record of what the Host answered was empty and an
 *      acknowledged operation could not be replayed after a crash — the exact guarantee the outbox
 *      exists to provide.
 *   2. **The reconnect history refetch was dead code.** `refetchHistoryForKnownSessions` read the
 *      same nonexistent key, so `events` was always `[]` and it appended nothing, every time. The
 *      existing reconnect case did not catch it because the fixture broadcast every event AND the
 *      daemon's backoff reconnects fast enough that a "missed" event usually arrives live on the new
 *      socket. The fixture now also records history (as the real Host does), and
 *      `recordSessionEvent` records an event that is NEVER broadcast, so the refetch is the only way
 *      it can reach the store. That is what these cases assert.
 *
 * Neither case is satisfied by the other: case 1 fails if the ack value regresses, case 2 fails if
 * the refetch regresses, and each was verified to fail under its own mutation of `src/lib/daemon.ts`.
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { scratchDir, startDaemon, ipcClient, waitFor, assert } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/**
 * A daemon child, a real fake Host, and a scratch state directory.
 *
 * `new FakeHost()` takes no options — `autoTurn` is a public field, and passing an options object is
 * silently ignored — so this uses the same construction every other suite in this layer does.
 * @param {string} label
 * @returns {Promise<object>}
 */
async function rig(label) {
  const host = await new FakeHost().start();
  const scratch = scratchDir(label);
  const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir: join(scratch.dir, 'state') });
  const ipc = await ipcClient(daemon.socketPath);
  const teardown = async () => {
    ipc.close();
    await daemon.stop();
    await host.stop();
    scratch.cleanup();
  };
  return { host, ipc, daemon, teardown, stateDir: join(scratch.dir, 'state') };
}

/**
 * Read one operation row straight out of the durable database.
 *
 * Read as a FILE, after the daemon has been stopped: the daemon holds the state database's lock for
 * its whole lifetime (that is the ownership model), so a second reader cannot open it while the
 * daemon runs. Stopping first is the honest way to look at what was committed.
 * @param {string} stateDir
 * @param {string} operationId
 * @returns {object}
 */
function readOperationRow(stateDir, operationId) {
  const db = new DatabaseSync(join(stateDir, 'state.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('select state, response_json, error_code from operations where operation_id = ?')
      .get(operationId);
    assert.ok(row, `expected a durable row for ${operationId}`);
    return row;
  } finally {
    db.close();
  }
}

export default {
  'the acknowledged operation stores the value the Host actually answered with': async () => {
    const { host, ipc, daemon, teardown, stateDir } = await rig('ack-value-retained');
    let operationId = null;
    try {
      const task = await ipc.request({ op: 'task.ensure', clientKey: 'ack-value' });
      const started = await ipc.request({
        op: 'session.start', taskId: task.task.taskId, clientKey: 'ack-value-session',
      });
      operationId = started.operation.operationId;
      assert.equal(started.operation.state, 'succeeded', 'the Host accepted the call, so the operation is acknowledged');

      // The Host's own value for `session.create` is the session it created. The assertion is on the
      // CONTENT, not merely on presence, because `{value: undefined}` and `{}` are both "present".
      assert.ok(started.session.hostSessionId.startsWith('session-'),
        `the fixture mints a host session id, got ${started.session.hostSessionId}`);

      await daemon.stop();
      const row = readOperationRow(stateDir, operationId);
      assert.equal(row.state, 'succeeded');
      assert.ok(typeof row.response_json === 'string' && row.response_json !== 'null' && row.response_json !== 'undefined',
        `an acknowledged operation must store the Host's answer; stored ${JSON.stringify(row.response_json)}. ` +
        'A null here means the value was read from a key the adapter never sets.');
      const stored = JSON.parse(row.response_json);
      assert.equal(stored.sessionId, started.session.hostSessionId,
        `the stored ack value must be the Host's own reply, got ${JSON.stringify(stored)}`);
    } finally {
      await teardown();
    }
  },

  'an event the Host never broadcast is recovered by the reconnect history refetch': async () => {
    const { host, ipc, daemon, teardown } = await rig('history-refetch-recovers');
    try {
      const task = await ipc.request({ op: 'task.ensure', clientKey: 'history' });
      const started = await ipc.request({
        op: 'session.start', taskId: task.task.taskId, clientKey: 'history-session',
      });
      const { taskId } = task.task;
      const { sessionId, hostSessionId } = started.session;

      // A live event first, so the session is known to be streaming and the baseline is non-empty.
      host.emitSessionEvent(hostSessionId, { type: 'user/message', text: 'live-before-outage' });
      await waitFor(async () => {
        const page = await ipc.request({ op: 'session.events', taskId, sessionId, limit: 100 });
        return page.events.some((event) => event.kind === 'user/message');
      }, { timeoutMs: 5000, what: 'the live event to be stored' });

      // The event history must recover: recorded in the Host's log, never on the wire. Nothing but
      // `refetchHistoryForKnownSessions` can bring it in, so a regression there cannot be masked by
      // the live socket — which is how this path stayed broken without any test noticing.
      const missed = host.recordSessionEvent(hostSessionId, {
        type: 'user/message',
        text: 'recorded-while-down-and-never-broadcast',
      });
      const beforeRefetch = await ipc.request({ op: 'session.events', taskId, sessionId, limit: 100 });
      assert.equal(beforeRefetch.events.some((event) => event.seq === missed.seq), false,
        'the unreachable event must not be in the store before a refetch happens');

      // Force the reconnect path: dropping the downlinks makes the daemon reopen them and refetch.
      host.dropDownlinks();
      await waitFor(async () => {
        const state = await ipc.request({ op: 'session.state', taskId, sessionId });
        return state.connection === 'ready';
      }, { timeoutMs: 15000, what: 'the downlink to be re-established' });

      await waitFor(async () => {
        const page = await ipc.request({ op: 'session.events', taskId, sessionId, limit: 100 });
        return page.events.some((event) => event.seq === missed.seq);
      }, { timeoutMs: 15000, what: 'the history refetch to append the never-broadcast event' });

      const afterRefetch = await ipc.request({ op: 'session.events', taskId, sessionId, limit: 100 });
      const recovered = afterRefetch.events.find((event) => event.seq === missed.seq);
      assert.ok(recovered, 'the recovered event must be readable');
      assert.equal(recovered.kind, 'user/message', 'the recovered event must keep its kind');

      const health = await ipc.request({ op: 'health' });
      assert.ok(health.eventStats.reconnects >= 1,
        'the refetch must have happened as part of a counted reconnect');
    } finally {
      await teardown();
    }
  },

  'FR-EV-4 a gap wider than one history page is reconciled by following beforeSeq, so the sweep is never silently partial': async () => {
    const { host, ipc, daemon, teardown } = await rig('history-refetch-pages');
    try {
      const task = await ipc.request({ op: 'task.ensure', clientKey: 'history-pages' });
      const { taskId } = task.task;
      const started = await ipc.request({
        op: 'session.start', taskId, clientKey: 'history-pages-session',
      });
      const { sessionId, hostSessionId } = started.session;

      // More events missed than ONE page holds. The daemon asks for `eventPageMax` (200) messages per
      // request, so 250 history-only events need a second page to be recovered at all. None of them is
      // broadcast, so the refetch is their only route into the store — and with a single-page sweep the
      // newest 200 arrive while the OLDEST ones, the far end of the very gap the sweep exists to close,
      // are dropped in silence: the cursor then describes the stored rows as a complete run and the
      // omitted events are unreachable forever. Following `beforeSeq` while `hasMore` is what this case
      // pins; it fails on the single-page form and passes on the loop.
      const missedSeqs = [];
      for (let index = 0; index < 250; index += 1) {
        const recorded = host.recordSessionEvent(hostSessionId, {
          type: 'user/message',
          text: `recorded-while-down-${index}`,
        });
        missedSeqs.push(Number(recorded.seq));
      }
      const oldest = Math.min(...missedSeqs);

      host.dropDownlinks();
      await waitFor(async () => {
        const state = await ipc.request({ op: 'session.state', taskId, sessionId });
        return state.connection === 'ready';
      }, { timeoutMs: 15000, what: 'the downlink to be re-established' });

      // Read the store through the SAME cursor API a client uses, paging back with `beforeSeq`, so the
      // assertion is about what the bridge serves rather than about an internal table.
      /** Collect stored events from the newest page backwards until the oldest missed one is seen. */
      const collectStored = async () => {
        const seen = new Set();
        let beforeSeq = null;
        for (let page = 0; page < 8; page += 1) {
          const reply = await ipc.request({
            op: 'session.events', taskId, sessionId, limit: 200,
            ...(beforeSeq === null ? {} : { beforeSeq }),
          });
          const events = reply.events ?? [];
          for (const event of events) seen.add(Number(event.seq));
          if (!events.length) break;
          const oldestHere = Math.min(...events.map((event) => Number(event.seq)));
          if (seen.has(oldest)) break;
          if (beforeSeq !== null && oldestHere >= beforeSeq) break;
          beforeSeq = oldestHere;
        }
        return seen;
      };

      await waitFor(async () => (await collectStored()).has(oldest), {
        timeoutMs: 20000,
        what: 'the oldest missed event to arrive from an older history page',
      });

      const stored = await collectStored();
      const omitted = missedSeqs.filter((seq) => !stored.has(seq));
      assert.deepEqual(omitted, [],
        `every missed event must be recovered, not only the newest page: ${omitted.length} of `
        + `${missedSeqs.length} were never stored (oldest omitted ${omitted.length ? Math.min(...omitted) : 'none'})`);
      assert.equal(stored.has(oldest), true,
        'the OLDEST missed event is the one a single-page refetch drops, so it must be present');

      const health = await ipc.request({ op: 'health' });
      assert.ok(health.eventStats.historyTruncations >= 1,
        'the sweep must count the pages the Host truncated rather than reporting a silent partial sweep');
    } finally {
      await teardown();
    }
  },

  'the fixture records the event it broadcasts, so history and the live stream agree': async () => {
    // The fidelity property the recovery case depends on. Without it the fixture's history is a
    // mirror of the live stream and no test can distinguish a working refetch from a broken one —
    // and this case would be the only place that difference is visible.
    const host = await new FakeHost().start();
    try {
      const created = await host.createSession();
      const emitted = host.emitSessionEvent(created.sessionId, { type: 'user/message', text: 'both-sides' });

      // Read the fixture's own history through its real HTTP surface, which is what the daemon reads.
      const response = await fetch(`${host.baseUrl}/api/session.history`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: new URL(host.baseUrl).host },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'fixture-history-probe',
          method: 'session.history',
          payload: { sessionId: created.sessionId, maxMessages: 100 },
        }),
      });
      // `Response.json()` is `unknown`: this is the wire boundary, so the shape is cast here and then
      // asserted field by field rather than trusted.
      const body = /** @type {any} */ (await response.json());
      assert.equal(body.result?.ok, true, `the fixture must serve session.history, got ${JSON.stringify(body)}`);
      const events = body.result.value.events.map((entry) => entry.event);
      assert.ok(events.some((event) => event.seq === emitted.seq),
        `a broadcast event must also be in the fixture's history; emitted seq ${emitted.seq}, ` +
        `history has ${JSON.stringify(events.map((event) => event.seq))}`);

      // And the record-only path must be in history WITHOUT having been broadcast: proven by the fact
      // that the fixture's own broadcast count does not move.
      const recorded = host.recordSessionEvent(created.sessionId, { type: 'user/message', text: 'only-history' });
      assert.ok(recorded.seq > emitted.seq, 'the recorded event must be numbered after the emitted one');
      const second = /** @type {any} */ (await (await fetch(`${host.baseUrl}/api/session.history`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', host: new URL(host.baseUrl).host },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: 'fixture-history-probe-2',
          method: 'session.history',
          payload: { sessionId: created.sessionId, maxMessages: 100 },
        }),
      })).json());
      const secondEvents = second.result.value.events.map((entry) => entry.event);
      assert.ok(secondEvents.some((event) => event.seq === recorded.seq),
        'an event recorded without broadcasting must still be served by history');
    } finally {
      await host.stop();
    }
  },

  'the self-check: the measurement these fixes rest on is asserted, not described': async () => {
    // The whole entry above is premised on `result.value` being the Host's payload. That premise is
    // what the old code got wrong, and a comment saying so is not an oracle. So the premise is
    // measured here, through the public adapter surface.
    const host = await new FakeHost().start();
    try {
      const { DshHostAdapter } = await import('../../dist/lib/adapter.js');
      const adapter = new DshHostAdapter({ baseUrl: host.baseUrl, timeoutMs: 5000 });
      const created = await host.createSession();
      const result = await adapter.call('session.history', { sessionId: created.sessionId, maxMessages: 5 });
      assert.equal(result.status, 'ok');
      // `Result.value` is `unknown` by design (the adapter does not promise a payload shape), so the
      // cast is the documented dynamic boundary and the assertions are the real check.
      const value = /** @type {any} */ (result.value);
      assert.ok(value && typeof value === 'object' && !Array.isArray(value),
        `\`result.value\` must be the Host's payload object, got ${JSON.stringify(value)}`);
      assert.equal(Object.hasOwn(value, 'value'), false,
        '`result.value` must NOT contain a nested `value` key: reading `result.value["value"]` is the ' +
        'defect these cases exist for, and this assertion fails the moment that changes');
      assert.ok(Array.isArray(value.events),
        `\`result.value\` must carry the payload's own fields, got ${JSON.stringify(Object.keys(value))}`);
    } finally {
      await host.stop();
    }
  },
};

