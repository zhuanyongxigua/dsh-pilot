/**
 * `session.create`'s VALUE, and what the bridge does with the Host's answer.
 *
 * Why this file exists: two defects sat on this one path, and both were invisible from the outside
 * because a fabricated id looks exactly like a real one.
 *
 *   1. The read was one level too deep. `call()` returns `ok({value: result.value, rpcId})` and
 *      `AdapterCallResult` promotes those fields to the top level, so the Host's `session.create` value
 *      is AT `result.value`. The code read `result.value['value']`, a key that never exists, so
 *      `hostValue` was ALWAYS `undefined` and `hostSessionId` was always the UUID this bridge minted
 *      before the request. The Host's own session id was discarded on every session ever created. Every
 *      downstream use of it then named a session the Host had never heard of — the `sessionId` in a
 *      `/api/respond` answer is the one that matters most, because the real Host compares it against the
 *      session it raised the request for. The same over-deep read had already been corrected in
 *      `#dispatch` and in the event page; this copy was missed.
 *
 *   2. `recordSession` returned `null` for the id it had just minted. The insert is
 *      `on conflict(task_id, host_session_id) do update set updated_at = …`, which keeps the ORIGINAL
 *      session id, and the method then returned `getSession(sessionId)` — the id it had just minted and
 *      which the conflict had just declined to use. So when two client keys resolved to the same Host
 *      session, the second call reported "no session" for a row that existed and was reachable.
 *
 * Both cases are asserted against a Host value the test controls, so the evidence is about the bridge
 * reading its peer correctly rather than about the fixture being generous.
 */

import { join } from 'node:path';
import { assert, ipcClient, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

const RPC = '__RPCID__';

/**
 * A fake Host and a real daemon over a fresh state directory, with one task.
 * @param {string} label
 */
async function rig(label) {
  const host = await new FakeHost().start();
  const scratch = scratchDir(`sess-create-${label}`);
  const stateDir = join(scratch.dir, 'state');
  const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir });
  const client = await ipcClient(daemon.socketPath);
  await waitFor(async () => (await client.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 10_000, what: `[${label}] the daemon mux downlink to reach ready` });
  const task = await client.request({ op: 'task.ensure', clientKey: `t-${label}` });
  return {
    host,
    client,
    stateDir,
    taskId: task.task.taskId,
    start: (key) => client.request({ op: 'session.start', taskId: task.task.taskId, clientKey: key, cwd: '/tmp' }),
    teardown: async () => {
      try { client.close(); } catch { /* already closed */ }
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    },
  };
}

/** A `session.create` answer whose value is exactly what the caller supplies. @param {object} value */
function createAnswer(value) {
  return JSON.stringify({ type: 'server-response', rpcId: RPC, result: { ok: true, value } });
}

export default {
  'the Host session id from session.create is recorded, not replaced by the id this bridge minted': async () => {
    const r = await rig('records');
    try {
      const chosen = 'session-chosen-by-the-host';
      r.host.answerRawFor('session.create', { body: createAnswer({ sessionId: chosen }) });
      const started = /** @type {{session?: {sessionId?: string, hostSessionId?: string}, operation?: {state?: string}}} */ (await r.start('k1'));
      assert.equal(started.operation?.state, 'succeeded', 'the create must have succeeded');
      assert.equal(started.session?.hostSessionId, chosen,
        `the Host's own session id must be recorded; a locally minted one means the answer was discarded. `
        + `Got ${started.session?.hostSessionId}`);
      // It must also be DURABLE, not merely echoed back: a restart reads the row, and the answer the
      // bridge sends for an approval is built from the stored id.
      const state = await r.client.request({ op: 'session.state', taskId: r.taskId, sessionId: started.session?.sessionId });
      assert.equal(/** @type {{session?: {hostSessionId?: string}}} */ (state).session?.hostSessionId, chosen,
        'and the stored session must carry it, because that is what an answer is addressed to');
    } finally {
      await r.teardown();
    }
  },

  'a Host value with no sessionId still falls back to the preallocated id, so the retry path is unchanged': async () => {
    const r = await rig('fallback');
    try {
      // The POSITIVE control for the fix. The fallback is the idempotent-retry path: a Host that answers
      // with a value that names no session cannot be taken to have renamed one, so the id this bridge
      // minted for the request — the one it would retry with — is what stands. A fix that always required
      // a Host id would break that, and this case is here so it cannot.
      r.host.answerRawFor('session.create', { body: createAnswer({ note: 'no sessionId here' }) });
      const started = /** @type {{session?: {hostSessionId?: string}, operation?: {state?: string}}} */ (await r.start('k1'));
      assert.equal(started.operation?.state, 'succeeded', 'the create must still succeed');
      assert.match(String(started.session?.hostSessionId), /^session-/,
        `an absent Host id must fall back to the preallocated one, got ${started.session?.hostSessionId}`);
      // And it is the id the REQUEST carried, which is the whole point of the fallback: a retry with the
      // same id is idempotent for the Host.
      const sent = r.host.requestsFor('session.create');
      const payload = /** @type {{sessionId?: string}} */ (sent[0]?.payload);
      assert.equal(started.session?.hostSessionId, payload?.sessionId,
        'the recorded id must be the one the Host was asked for, so a retry reuses it');
    } finally {
      await r.teardown();
    }
  },

  'two client keys the Host maps to one session resolve to one session rather than "no session"': async () => {
    const r = await rig('conflict');
    try {
      // One Host session id for both calls, which is what a Host does when it answers a second create
      // for the same workspace with the session it already has. The second insert takes the conflict arm,
      // which by design keeps the FIRST row's bridge id — and the method then used to return the id it had
      // just minted, which no row carries, so the reply was `session: null` after a real create.
      const shared = 'session-shared-by-host';
      r.host.answerRawFor('session.create', { body: createAnswer({ sessionId: shared }) });
      const first = /** @type {{session?: {sessionId?: string, hostSessionId?: string}}} */ (await r.start('k1'));
      assert.equal(first.session?.hostSessionId, shared, 'the first create records the Host id');

      r.host.answerRawFor('session.create', { body: createAnswer({ sessionId: shared }) });
      const second = /** @type {{session?: {sessionId?: string, hostSessionId?: string}|null, operation?: {state?: string}}} */ (await r.start('k2'));
      assert.equal(second.operation?.state, 'succeeded', 'the second create succeeded at the Host');
      assert.notEqual(second.session, null,
        'a successful create must not be reported as having no session when the row exists');
      assert.equal(second.session?.hostSessionId, shared, 'and it names the Host session it resolved to');
      // One Host session is one bridge session: the second call must resolve to the row that exists
      // rather than minting a second id for the same Host session, which would make two of our ids point
      // at one Host session and leave one of them unreachable through a lookup by Host id.
      assert.equal(second.session?.sessionId, first.session?.sessionId,
        'both calls must resolve to the same session row, because both name one Host session');
      // Independent oracle: the DURABLE ROWS, read from the state database directly rather than from a
      // reply, because a reply is what the code under test produces and this claim is about what it
      // stored. Read-only: the daemon owns the file.
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(join(r.stateDir, 'state.sqlite'), { readOnly: true });
      try {
        const rows = /** @type {{session_id: string, host_session_id: string}[]} */ (
          db.prepare('select session_id, host_session_id from sessions where task_id = ?').all(r.taskId));
        assert.equal(rows.length, 1,
          `one Host session must be one durable row, got ${rows.length}: ${JSON.stringify(rows)}`);
        assert.equal(rows[0]?.host_session_id, shared, 'and the row carries the Host id');
        assert.equal(rows[0]?.session_id, first.session?.sessionId,
          'and it is the row the first call created, not a second one');
      } finally {
        db.close();
      }
    } finally {
      await r.teardown();
    }
  },
};
