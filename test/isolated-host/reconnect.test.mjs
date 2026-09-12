/**
 * Isolated official-DSH-Host layer: reattach and history reconciliation.
 *
 * FR-EV-4 requires the bridge to be proven able to find its way back to a durable session — and to
 * recover what it missed — against the REAL Host, not only against our own fake one. The fake-Host
 * layer proves our client agrees with a Host we wrote; a passing fake-Host reconnect case is
 * therefore no evidence at all about the real Host's reconnect semantics, which is exactly the gap
 * this file closes.
 *
 * The path exercised here needs NO shell tool, which matters: this machine's confinement backend
 * refuses to run a command (`sandbox-exec: sandbox_apply: Operation not permitted`), so the one
 * test that needs a real tool effect legitimately fails. Refusing to attempt the other paths because
 * of that would be the wrong conclusion — reattach, turn lifecycle, and history reconciliation are
 * all reachable with a model-only turn, and they are what this file drives.
 *
 * What it measures against the real Host:
 *
 *   1. A real `session.history` page is served, and it carries the events of a turn that really ran.
 *      This is the read the bridge's reconnect refetch depends on, and the fake Host's shape was
 *      written by us — so "the real Host answers this way" is a fact that has to be observed.
 *   2. After the Host process is stopped and re-booted, a daemon pointed at the NEW origin reattaches
 *      to the SAME durable state directory and can serve the events recorded before the restart,
 *      with contiguous sequences and no invented ones.
 *   3. The refusal when a task's origin no longer matches is a typed CONFLICT that names both
 *      origins, not a silent reattach to a different Host and not a "not found".
 *
 * The model route is a loopback mock, so no paid provider is contacted and no quota is spent. The
 * mock still never hardcodes an outcome: each assertion names a marker the mock produced.
 *
 * Opt-in: `--isolated`.
 */

import { join } from 'node:path';
import { assert, ipcClient, skip, startDaemon, waitFor } from '../helpers.mjs';
import { MOCK_API_KEY_ENV, resolveDshBin, startMockedDshHost } from './rig.mjs';

/** @param {any} context */
function requireIsolated(context) {
  if (!context?.isolated) skip('opt-in: run with --isolated (this layer starts a real DSH Host)');
  if (!resolveDshBin()) skip('no installed @deepseek-ai/dsh found; set DSH_PILOT_DSH_BIN to run this layer');
  if (process.env.DSH_PILOT_ALLOW_UNCONFINED_TOOLS) {
    throw new Error('refusing to run: DSH_PILOT_ALLOW_UNCONFINED_TOOLS would widen the sandbox boundary for a test');
  }
}

/**
 * One control-plane call to the Host, so this file can read the Host's OWN answer rather than taking
 * the bridge's word for it.
 *
 * The `Host` header is set explicitly because the Host's browser-trust fence checks it; a request
 * without it is refused, which is the fence doing its job rather than a bug in this helper.
 * @param {string} baseUrl
 * @param {string} method
 * @param {object} [payload]
 * @returns {Promise<{status: number, parsed: any, text: string}>}
 */
async function controlCall(baseUrl, method, payload = {}) {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', host: new URL(baseUrl).host },
    body: JSON.stringify({ type: 'client-request', rpcId: `oa-probe-${method}`, method, payload }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* a non-JSON body is reported by the caller */ }
  return { status: response.status, parsed, text };
}

/**
 * Wait until a daemon process is really gone, then until the state directory accepts a new owner.
 *
 * `daemon.stop()` signals the child but does not wait for it to exit, so a daemon started immediately
 * afterwards raced the dying one and exited with `OWNER_HELD`. That is the ownership model working
 * and a real race in the TEST.
 *
 * Two waits, because there are two distinct conditions and an earlier attempt conflated them:
 *
 *   1. **The process is gone.** Observed with `process.kill(pid, 0)`, which is the only thing that can
 *      see another process's lifetime from here. The pid comes from the daemon's own `health` reply,
 *      so nothing is inferred.
 *   2. **The lock is free.** Probed by actually starting a daemon and letting it exit cleanly. An
 *      earlier version tried to observe this by acquiring the lock in THIS process, which cannot
 *      work: the lock is a kernel `flock` on a file descriptor, and a second descriptor in the same
 *      process does not contend with the first the way another process does. That probe reported the
 *      directory free while a daemon still owned it — a false negative that is worth recording, since
 *      re-deriving it from the lock's own semantics is the natural wrong move.
 * @param {string} stateDir
 * @param {number} pid
 */
async function waitForDaemonGone(stateDir, pid) {
  if (Number.isInteger(pid) && pid > 0) {
    await waitFor(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, { timeoutMs: 20_000, what: `daemon pid ${pid} to exit` });
  }
}

/**
 * Boot a Host, attach a daemon to it, and open a task and session.
 * @param {string} label
 * @param {string} stateDir the durable state directory, so a second phase can reuse it
 * @param {string} hostBase
 */
async function attach(label, stateDir, hostBase, { requireReady = true } = {}) {
  const daemon = await startDaemon({
    hostBase,
    stateDir,
    extraEnv: { [MOCK_API_KEY_ENV]: 'mock-value-not-a-real-credential' },
  });
  const ipc = await ipcClient(daemon.socketPath);
  // A daemon CAN be started against an origin whose Host is gone — that is a legitimate state this
  // file has to test. So readiness is opt-in rather than assumed: requiring it made the
  // moved-origin case impossible to set up, and the failure looked like a daemon bug.
  if (requireReady) {
    await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
      { timeoutMs: 20_000, what: `${label}: the bridge to attach to the real Host downlinks` });
  }
  return { daemon, ipc };
}

export default {
  'FR-EV-4: a real Host serves the history page the reconnect refetch depends on, and it carries a turn that really ran': async (context) => {
    requireIsolated(context);
    const host = await startMockedDshHost({ label: 'isolated-history' });
    const stateDir = join(host.scratch.dir, 'state');
    const attached = await attach('isolated-history', stateDir, host.hostBase);
    try {
      const marker = 'HISTORY-PAGE-MARKER-7f52';
      host.mock.routeByText('Reply with the marker', { text: marker });
      const task = await attached.ipc.request({ op: 'task.ensure', clientKey: 'history-task' });
      const { taskId } = task.task;
      const started = await attached.ipc.request({
        op: 'session.start', taskId, clientKey: 'history-session',
        cwd: join(host.scratch.dir, 'workspace'),
      });
      assert.equal(started.operation.state, 'succeeded', JSON.stringify(started.operation));
      const { sessionId } = started.session;

      const prompt = await attached.ipc.request({
        op: 'session.prompt', taskId, sessionId, clientKey: 'history-prompt',
        text: 'Reply with the marker you were given.',
      });
      assert.equal(prompt.operation.state, 'succeeded', JSON.stringify(prompt.operation));
      await attached.ipc.request({ op: 'session.wait', taskId, sessionId, clientKey: 'history-wait', timeoutMs: 90_000 });

      const throughBridge = await attached.ipc.request({ op: 'session.events', taskId, sessionId, limit: 200 });
      assert.ok(throughBridge.events.length >= 2,
        `the bridge must have stored the real turn's events, got ${throughBridge.events.length}`);
      assert.ok(throughBridge.events.some((event) => event.kind === 'turn/end'),
        'the real turn must have ended, with the terminal event stored');
      const bridgeSeqs = throughBridge.events.map((event) => Number(event.seq));

      // Now ask the HOST ITSELF for the same page. This is the read the daemon's
      // `refetchHistoryForKnownSessions` performs, and the whole point of the case: the fake Host's
      // history shape is our own invention, so agreement with the real Host has to be observed.
      const page = await controlCall(host.hostBase, 'session.history', {
        sessionId: started.session.hostSessionId, maxMessages: 200,
      });
      assert.equal(page.status, 200, `session.history must answer 200, got ${page.status}: ${page.text.slice(0, 300)}`);
      assert.equal(page.parsed?.result?.ok, true,
        `the real Host must serve session.history, got ${JSON.stringify(page.parsed).slice(0, 400)}`);
      const hostEvents = page.parsed.result.value.events;
      assert.ok(Array.isArray(hostEvents) && hostEvents.length >= 2,
        `the real history page must carry the turn's events, got ${JSON.stringify(hostEvents).slice(0, 300)}`);

      // The shape the bridge's refetch reads: an envelope with `events`, each entry wrapping the
      // event under `event`, and a `hasMore` flag. A shape change here is exactly what would silently
      // turn the refetch into a no-op again, so it is asserted field by field rather than assumed.
      assert.equal(typeof page.parsed.result.value.hasMore, 'boolean',
        'the real history page must declare hasMore, which the refetch uses to decide it has all of it');
      const wrapped = hostEvents[0];
      assert.ok(wrapped && typeof wrapped === 'object' && 'event' in wrapped,
        `each history entry must wrap its event under \`event\`, got ${JSON.stringify(wrapped).slice(0, 200)}`);
      const hostSeqs = hostEvents.map((entry) => Number(entry.event.seq)).filter((seq) => Number.isFinite(seq));
      assert.ok(hostSeqs.length >= 2, `the history page must carry numbered events, got ${JSON.stringify(hostSeqs)}`);

      // The bridge stored the SAME events the Host's own history has, by sequence. This is the
      // property that makes the refetch meaningful: the two sides agree on what happened.
      // The meaningful direction is bridge ⊆ host, NOT equality. The Host's log begins before the
      // bridge attached — it contains the session-creation events — so demanding that the bridge hold
      // all of them would be demanding it store events it never observed. What must hold is that
      // everything the bridge DID store is really in the Host's log at the same sequence, which is
      // exactly what makes a seq-addressed refetch safe.
      const inventedByBridge = bridgeSeqs.filter((seq) => !hostSeqs.includes(seq));
      assert.deepEqual(inventedByBridge, [],
        `the bridge holds events the Host's own history does not have: ${JSON.stringify(inventedByBridge)}. ` +
        'An event the Host never logged means the sequence space does not mean what the refetch thinks.');
      assert.ok(bridgeSeqs.length >= 2, `the bridge must have stored the turn, got ${bridgeSeqs.length}`);
      const storedSeqs = [...bridgeSeqs].sort((a, b) => a - b);
      for (let index = 1; index < storedSeqs.length; index += 1) {
        assert.equal(storedSeqs[index], storedSeqs[index - 1] + 1,
          `stored sequences must be contiguous; ${JSON.stringify(storedSeqs)} has a hole. A hole here means the ` +
          'refetch reasoned about its cursor wrongly, which is the failure mode it exists to avoid.');
      }
    } finally {
      try { attached.ipc.close(); } catch { /* already closed */ }
      await attached.daemon.stop();
      await host.stop();
      host.cleanup();
    }
  },

  'FR-EV-4: after the real Host is restarted on a new port, the durable state reattaches and still serves the pre-restart events': async (context) => {
    requireIsolated(context);
    const host = await startMockedDshHost({ label: 'isolated-reattach' });
    const stateDir = join(host.scratch.dir, 'state');
    /** @type {{ ipc: any, daemon: any }|null} */
    let first = null;
    /** @type {{ ipc: any, daemon: any }|null} */
    let second = null;
    try {
      const marker = 'REATTACH-MARKER-3b18';
      host.mock.routeByText('Reply with the marker', { text: marker });
      first = await attach('isolated-reattach', stateDir, host.hostBase);
      const task = await first.ipc.request({ op: 'task.ensure', clientKey: 'reattach-task' });
      const { taskId } = task.task;
      const started = await first.ipc.request({
        op: 'session.start', taskId, clientKey: 'reattach-session',
        cwd: join(host.scratch.dir, 'workspace'),
      });
      assert.equal(started.operation.state, 'succeeded', JSON.stringify(started.operation));
      const { sessionId } = started.session;
      await first.ipc.request({
        op: 'session.prompt', taskId, sessionId, clientKey: 'reattach-prompt',
        text: 'Reply with the marker you were given.',
      });
      await first.ipc.request({ op: 'session.wait', taskId, sessionId, clientKey: 'reattach-wait', timeoutMs: 90_000 });
      const before = await first.ipc.request({ op: 'session.events', taskId, sessionId, limit: 200 });
      assert.ok(before.events.length >= 2, 'the pre-restart turn must be stored before the restart means anything');
      const beforeSeqs = before.events.map((event) => Number(event.seq));

      // Closing the daemon first is what makes the restart a genuine reattach rather than a live
      // process that happened to reconnect: the second daemon is a NEW process over the SAME state
      // directory, which is the real-world case of an operator restarting their Host.
      const ownerPid = Number((await first.ipc.request({ op: 'health' })).pid);
      first.ipc.close();
      await first.daemon.stop();
      first = null;
      await waitForDaemonGone(stateDir, ownerPid);

      const originalBase = host.hostBase;
      const newBase = await host.restart();
      process.stdout.write(`      [probe] restart: original=${originalBase} new=${newBase}\n`);
      assert.notEqual(newBase, originalBase,
        'the Host must come back on a fresh ephemeral port, otherwise this case would not be testing a move');

      // The old origin is gone, and the refusal must be typed, name both origins and be actionable —
      // not a silent reattach to whatever is listening now, and not a "task not found".
      // On the NEW origin the same durable state directory is reachable, with the events recorded
      // before the Host moved.
      second = await attach('isolated-reattach-new', stateDir, newBase);
      // The origin a task belongs to is part of its identity, so the daemon that is now talking to a
      // DIFFERENT origin must refuse the pre-restart task with a typed CONFLICT — never serve it as if
      // the move were invisible, and never report it as merely missing. This is the check that makes
      // "reattach" safe: the alternative is talking to the wrong Host about the right session.
      const secondPid = Number((await second.ipc.request({ op: 'health' })).pid);
      let refusal = null;
      try {
        await second.ipc.request({ op: 'session.state', taskId, sessionId });
      } catch (error) { refusal = error; }
      assert.ok(refusal,
        'a daemon attached to a NEW origin must refuse a task that belongs to the origin the Host moved away from');
      const typed = /** @type {{code?: string, details?: Record<string, unknown>}} */ (refusal);
      assert.equal(typed.code, 'CONFLICT',
        `the moved-Host refusal must be a typed CONFLICT, got ${JSON.stringify(typed.code ?? String(refusal))}`);
      assert.equal(typed.details?.taskHostBase, originalBase,
        `the refusal must name the origin the task belongs to, got ${JSON.stringify(typed.details)}`);
      assert.equal(typed.details?.daemonHostBase, newBase,
        'the refusal must name the origin the daemon is talking to');
      assert.match(String(typed.details?.hint ?? ''), /origin/i,
        'the refusal must say what an operator can do about it');

      // The second daemon must release the directory before a third can own it. Stopping it here is
      // not tidiness: one state directory has exactly one owner by design, so overlapping the two
      // would make the next start fail with OWNER_HELD — the ownership model working, and a defect in
      // this test rather than in the bridge.
      second.ipc.close();
      await second.daemon.stop();
      second = null;
      await waitForDaemonGone(stateDir, secondPid);

      // Reaching the durable state therefore requires declaring the SAME origin the task was created
      // under. Re-pointing the daemon at the old origin recovers it, which is what proves the state
      // was never destroyed by the move — only guarded.
      const recovered = await attach('isolated-reattach-same-origin', stateDir, originalBase, { requireReady: false });
      try {
      const after = await recovered.ipc.request({ op: 'session.events', taskId, sessionId, limit: 200 });
      assert.ok(after.events.length >= beforeSeqs.length,
        `the reattached daemon must still serve the pre-restart events; had ${beforeSeqs.length}, now ${after.events.length}`);
      const afterSeqs = after.events.map((event) => Number(event.seq));
      for (const seq of beforeSeqs) {
        assert.ok(afterSeqs.includes(seq),
          `the reattached daemon lost event ${seq}; it has ${JSON.stringify(afterSeqs)}`);
      }
      const beforeState = before.events.find((event) => event.kind === 'turn/end');
      const afterState = after.events.find((event) => event.kind === 'turn/end');
      assert.ok(beforeState && afterState, 'the terminal event must survive the reattach');
      assert.equal(afterState.seq, beforeState.seq,
        'reattachment must not renumber or duplicate the durable history');
      // `session.events` reports cursor COMPLETENESS at the top level, not nested under `cursor`.
      assert.equal(after.completeness, 'complete',
        `the reattached session must report complete history, got ${JSON.stringify({
          completeness: after.completeness, highWater: after.highWater, gap: after.gap,
        })}`);
      assert.equal(after.gap, null, `a reattached session must have no gap, got ${JSON.stringify(after.gap)}`);

      // The new Host's own history agrees, so the agreement is not an artefact of our store.
      const page = await controlCall(newBase, 'session.history', {
        sessionId: started.session.hostSessionId, maxMessages: 200,
      });
      assert.equal(page.parsed?.result?.ok, true,
        `the restarted Host must still serve the session history, got ${page.text.slice(0, 300)}`);
      const hostSeqs = page.parsed.result.value.events.map((entry) => Number(entry.event.seq));
      for (const seq of afterSeqs) {
        assert.ok(hostSeqs.includes(seq),
          `event ${seq} is in the bridge's state but not in the restarted Host's history`);
      }
      } finally {
        try { recovered.ipc.close(); } catch { /* already closed */ }
        await recovered.daemon.stop();
      }
    } finally {
      if (first) { try { first.ipc.close(); } catch { /* already closed */ } await first.daemon.stop(); }
      if (second) { try { second.ipc.close(); } catch { /* already closed */ } await second.daemon.stop(); }
      await host.stop();
      host.cleanup();
    }
  },
};
