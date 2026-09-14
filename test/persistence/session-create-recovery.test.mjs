/**
 * Persistence layer: FR-STATE-2 and FR-SESS-3 — recovering a `session.create` that was already
 * acknowledged, where FR-STATE-2 is the `uncertain`-outcome rule and FR-SESS-3 is the reattach-after-restart
 * rule (the workspace/cwd rule is FR-SESS-6 and is a different requirement: see `test/security/workspace-cwd`).
 *
 * Two cases, both about the same durable fact: `#dispatch` records the operation BEFORE any byte is
 * written and records the Host's answer the moment it arrives, while the SESSION ROW is written by
 * `#recordSessionFromCreate` afterwards. Everything the bridge needs to know how far a create got is
 * therefore on disk before that row exists, and each case pins one way the old code failed to use it.
 *
 *   1. **An authorised retry of an UNCERTAIN create.** An outcome that could not be observed (the Host
 *      took the request and its answer was lost) leaves the operation `uncertain`, and a retry is
 *      legitimate for `session.create` alone, because it accepts the caller-preallocated id. The retry
 *      used to send while the row still said "outcome unknown" and then try to acknowledge the answer
 *      FROM that state, which the store refuses — so the very response that resolved the uncertainty
 *      raised `ILLEGAL_TRANSITION`. The case asserts the durable state DURING the retry (`dispatching`,
 *      observed while the response is held) and after it (`succeeded`), with the Host's own request log
 *      as the independent oracle that a second attempt really went out.
 *
 *   2. **A crash between the acknowledgement and the session row.** The Host answered `session.create`,
 *      the answer was durably recorded, and the process died before the row was written. The session
 *      exists on the Host under the preallocated id, so the old behaviour — report `ok` with NO session
 *      — left it unreachable: no later prompt, cancel or state query could name it. The row is now
 *      reconstructed from the acknowledgement, and the oracle that it names the REAL Host session is
 *      the Host's own session lookup refusing prompts for sessions it does not have.
 *
 * Scope: the fake Host is NOT the DSH product. These are claims about our client against our own
 * fixture; the official-Host layer is `test/isolated-host`.
 */

import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assert, ipcClient, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/**
 * A fake Host, a real daemon child over a fresh state directory, and a task.
 *
 * The unary deadline is run small (`DSH_PILOT_HOST_TIMEOUT_MS`) so the case that needs an UNOBSERVABLE
 * outcome waits for its own configured bound instead of the fifteen-second default.
 * @param {string} label
 */
async function boot(label) {
  const host = await new FakeHost().start();
  const scratch = scratchDir(`session-create-${label}`);
  const stateDir = join(scratch.dir, 'state');
  const daemon = await startDaemon({
    hostBase: host.baseUrl,
    stateDir,
    extraEnv: { DSH_PILOT_HOST_TIMEOUT_MS: '1200' },
  });
  const ipc = await ipcClient(daemon.socketPath);
  await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 10_000, what: `[${label}] the daemon mux downlink to reach ready` });
  const task = await ipc.request({ op: 'task.ensure', clientKey: `t-${label}` });
  return {
    host, scratch, stateDir, daemon, ipc,
    taskId: task.task.taskId,
    sessionKey: `s-${label}`,
    teardown: async () => {
      try { ipc.close(); } catch { /* already closed */ }
      await daemon.stop();
      try { await host.stop(); } catch { /* already stopped */ }
      scratch.cleanup();
    },
  };
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

/** Start a daemon over an existing state directory, as an operator's restart would. */
async function startOver(stateDir, hostBaseUrl) {
  const daemon = await startDaemon({
    hostBase: hostBaseUrl,
    stateDir,
    extraEnv: { DSH_PILOT_HOST_TIMEOUT_MS: '1200' },
  });
  const ipc = await ipcClient(daemon.socketPath);
  await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 10_000, what: 'the restarted daemon to attach' });
  return { daemon, ipc };
}

/**
 * The durable operation rows for one task, read directly from the state file.
 *
 * Read through a second connection while the daemon runs: the state database is in WAL mode, so a
 * reader sees committed rows without disturbing the writer.
 * @param {string} stateDir
 */
function operationsFor(stateDir) {
  const db = new DatabaseSync(join(stateDir, 'state.sqlite'), { readOnly: true });
  try {
    return db.prepare('select operation_id, kind, state from operations order by rowid').all()
      .map((row) => ({
        operationId: String(row.operation_id),
        kind: String(row.kind),
        state: String(row.state),
      }));
  } finally {
    db.close();
  }
}

export default {
  'FR-STATE-2 a retry of an UNCERTAIN session.create is re-marked dispatching before the send, and its confirmed answer is acknowledged': async () => {
    const r = await boot('retry-uncertain');
    try {
      // An outcome that cannot be observed: the Host TAKES the request and its answer is lost. The
      // operation must end `uncertain` — asserted, not assumed, because the rest of the case is only
      // meaningful from that state.
      r.host.dropResponseFor('session.create');
      const first = await r.ipc.request({ op: 'session.start', taskId: r.taskId, clientKey: r.sessionKey });
      assert.equal(first.session, null,
        `an unobservable outcome must not report a session: ${JSON.stringify(first)}`);
      assert.equal(first.operation.state, 'uncertain',
        `the durable row must say the outcome is unknown: ${JSON.stringify(first.operation)}`);
      assert.equal(r.host.requestsFor('session.create').length, 1,
        'the Host must have received exactly one create attempt before the retry');

      // The retry is legitimate for `session.create` alone, and it is the same client key, so it
      // resolves to the SAME operation rather than minting a second one.
      r.host.stopDropping('session.create');
      r.host.barrierFor('session.create');
      // The catch is attached IMMEDIATELY rather than at the await, because the failure this case exists
      // for is loud: without the fix the daemon refuses its own retry with ILLEGAL_TRANSITION, dies, and
      // the pending request rejects when the socket closes. An unhandled rejection here would take down
      // the whole runner and hide every other case's result, so the rejection is turned into a value that
      // the assertion below can report as this case's failure.
      const retrying = r.ipc.request({ op: 'session.start', taskId: r.taskId, clientKey: r.sessionKey })
        .catch((error) => ({ failed: String(error?.message ?? error), code: String(error?.code ?? '') }));
      await waitFor(() => r.host.barrierReached('session.create'),
        { timeoutMs: 10_000, what: 'the retry to reach the Host, with its response held' });

      // THE ASSERTION the finding is about: while the retry is in flight the durable row must be
      // `dispatching` again. A retry that sent while the row still said `uncertain` could not record
      // the answer at all — `markAcknowledged` accepts only `dispatching`/`sent` — which is the
      // ILLEGAL_TRANSITION the old code raised on the one response that resolved the uncertainty.
      const during = operationsFor(r.stateDir).find((row) => row.kind === 'session.create');
      assert.equal(during?.state, 'dispatching',
        `the row must be dispatching again before the retry's answer is read, got ${JSON.stringify(during)}`);

      r.host.releaseBarrier('session.create');
      const reply = await retrying;

      assert.equal(reply.failed, undefined,
        `the retry must be answered rather than fail: ${JSON.stringify(reply)}`);
      assert.equal(reply.error, undefined,
        `the retry must be able to acknowledge its answer, got ${JSON.stringify(reply.error)}`);
      assert.equal(reply.operation.state, 'succeeded',
        `the confirmed answer must be recorded as success, got ${JSON.stringify(reply.operation)}`);
      assert.ok(reply.session, `the retry must return the session the Host already created: ${JSON.stringify(reply)}`);
      assert.equal(r.host.requestsFor('session.create').length, 2,
        'the retry must have really reached the Host a second time');
      // Idempotent by contract: both attempts carry the SAME preallocated Host session id, which is
      // what makes a retry safe and what makes the fixture answer with the session it already has.
      const attempts = r.host.requestsFor('session.create').map((request) => request.payload.sessionId);
      assert.equal(new Set(attempts).size, 1,
        `both attempts must reuse one preallocated Host session id, got ${JSON.stringify(attempts)}`);

      // And the session is usable afterwards: the row exists and names the Host's session.
      const state = await r.ipc.request({
        op: 'session.state', taskId: r.taskId, sessionId: reply.session.sessionId,
      });
      assert.equal(state.session.hostSessionId, reply.session.hostSessionId,
        'the recovered session must be readable through the ordinary session state query');
    } finally {
      await r.teardown();
    }
  },

  'FR-SESS-3 crash: a create acknowledged before the session row was written is recovered, and reattach names the preallocated Host session': async () => {
    const r = await boot('ack-window');
    let revived = null;
    try {
      // A real, acknowledged create first: the Host has this session and the operation row records the
      // answer it gave.
      const first = await r.ipc.request({ op: 'session.start', taskId: r.taskId, clientKey: r.sessionKey });
      assert.equal(first.operation.state, 'succeeded', JSON.stringify(first.operation));
      const preallocated = first.session.hostSessionId;
      assert.equal(r.host.requestsFor('session.create').length, 1, 'exactly one create reached the Host');

      // Kill the daemon, then remove EXACTLY the write the crash window omits: the session row. The
      // acknowledgement and its response JSON stay, which is what the process left behind when it died
      // in that window — the surgery reproduces the window, it does not invent a different state.
      const pid = await daemonPid(r.ipc);
      process.kill(pid, 'SIGKILL');
      await waitForExit(pid);
      const db = new DatabaseSync(join(r.stateDir, 'state.sqlite'));
      try {
        const removed = db.prepare('delete from sessions where host_session_id = ?').run(preallocated);
        assert.equal(Number(removed.changes), 1,
          'this case is only meaningful if the session row is the one thing the crash window omits');
        const acked = db.prepare('select state, response_json from operations where kind = ?').get('session.create');
        assert.equal(String(acked?.state), 'succeeded',
          `the acknowledgement must still be on disk when the process dies: ${JSON.stringify(acked)}`);
        assert.ok(String(acked?.response_json ?? '').includes(preallocated),
          'and it must still carry the Host\'s own answer, which is what the row is rebuilt from');
      } finally {
        db.close();
      }

      const after = await startOver(r.stateDir, r.host.baseUrl);
      revived = after;
      const reply = await after.ipc.request({ op: 'session.start', taskId: r.taskId, clientKey: r.sessionKey });

      // The recovery: a session is returned, it is the one the Host already has, and the Host received
      // NO second create — the fact that makes this a reconstruction rather than a re-creation.
      assert.ok(reply.session,
        `the acknowledged create must be recovered into a session row rather than reported as ok with none: ${JSON.stringify(reply)}`);
      assert.equal(reply.session.hostSessionId, preallocated,
        'the recovered row must name the preallocated Host session, not a freshly minted id');
      assert.equal(reply.operation.state, 'succeeded', JSON.stringify(reply.operation));
      assert.equal(reply.reused, true, 'the caller must be told this was a reuse, not a new create');
      assert.equal(r.host.requestsFor('session.create').length, 1,
        'recovery must not send a second create to the Host');

      // Reattach, in this bridge's vocabulary: the recovered row is usable, and the proof that it names
      // a session the Host really has is that the Host APPLIES work to it. The fixture refuses a prompt
      // for a session it does not know (`session-not-found`), so a wrongly minted id cannot pass here.
      const state = await after.ipc.request({
        op: 'session.state', taskId: r.taskId, sessionId: reply.session.sessionId,
      });
      assert.equal(state.session.hostSessionId, preallocated, 'the reattached session is the Host session');
      const prompted = await after.ipc.request({
        op: 'session.prompt', taskId: r.taskId, sessionId: reply.session.sessionId,
        clientKey: 'prompt-after-recovery', text: 'the recovered session must accept work',
      });
      assert.equal(prompted.operation.state, 'succeeded',
        `the Host must accept work on the recovered session, got ${JSON.stringify(prompted.operation)}`);
      assert.equal(r.host.requestsFor('session.prompt').length, 1,
        'and it must be the recovered session that received it');
    } finally {
      if (revived) {
        try { revived.ipc.close(); } catch { /* already closed */ }
        await revived.daemon.stop();
      }
      await r.teardown();
    }
  },
};
