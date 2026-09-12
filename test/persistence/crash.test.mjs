/**
 * Persistence and crash layer: real processes, real SIGKILL, real restarts.
 *
 * Why these tests exist: the durability claims are the ones most easily faked by an in-process
 * test. Here every claim is checked across an actual process boundary — a daemon is killed
 * mid-flight and a NEW process is started against the same state directory, so "durable before
 * send" means the request was committed by a process that no longer exists and can be read by
 * one that did not see it.
 *
 * The signal choice matters. SIGKILL cannot be caught, so nothing gets a chance to tidy up:
 * whatever the next process finds IS the durable state. That is the only honest way to test
 * "recover from a crash".
 */

import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { assert, collect, ipcClient, scratchDir, spawnNode, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/** Start a daemon whose child we also keep for signal tests. */
async function bootDaemon(hostBase, stateDir) {
  return startDaemon({ hostBase, stateDir });
}

/** Wait until the daemon reports an in-flight (dispatching) operation, or fail loudly. */
async function waitForInFlight(socketPath, timeoutMs = 5000) {
  const client = await ipcClient(socketPath);
  try {
    await waitFor(async () => {
      const health = await client.request({ op: 'health' });
      return (health.operations.dispatching ?? 0) > 0;
    }, { timeoutMs, what: 'an operation to reach the dispatching state', intervalMs: 5 });
  } finally {
    client.close();
  }
}

export default {
  'SIGKILL during dispatch: the next process reports the operation as uncertain, never as sent': async () => {
    const host = await new FakeHost().start();
    const scratch = scratchDir('crash-dispatch');
    const stateDir = join(scratch.dir, 'state');
    let daemon = await bootDaemon(host.baseUrl, stateDir);
    try {
      const ipc = await ipcClient(daemon.socketPath);
      const task = await ipc.request({ op: 'task.ensure', clientKey: 'crash-task' });
      const session = await ipc.request({ op: 'session.start', taskId: task.task.taskId, clientKey: 'crash-session' });
      assert.ok(session.session);
      ipc.close();

      // Hold the Host's reply open so the request is provably on the wire when we kill.
      host.delayFor('session.prompt', 800);
      const pending = (async () => {
        const client = await ipcClient(daemon.socketPath);
        try {
          return await client.request({
            op: 'session.prompt', taskId: task.task.taskId, sessionId: session.session.sessionId,
            clientKey: 'crash-prompt', text: 'about to die',
          });
        } finally {
          client.close();
        }
      })().catch((error) => ({ failed: String(error.message) }));

      await waitForInFlight(daemon.socketPath);
      // No grace: the process is not allowed to finish anything.
      daemon.child.kill('SIGKILL');
      const exit = await collect(daemon.child);
      assert.equal(exit.signal, 'SIGKILL', `expected the daemon to be killed hard, got ${JSON.stringify(exit)}`);
      await pending;
      assert.equal(host.requestsFor('session.prompt').length, 1, 'the request did reach the Host before the kill');

      // A brand new process opens the same state directory.
      daemon = await bootDaemon(host.baseUrl, stateDir);
      const ipc2 = await ipcClient(daemon.socketPath);
      try {
        const health = await ipc2.request({ op: 'health' });
        assert.equal(health.recovery.sweptOperations, 1,
          `the new process must sweep exactly the interrupted dispatch: ${JSON.stringify(health.recovery)}`);
        const state = await ipc2.request({
          op: 'session.state', taskId: task.task.taskId, sessionId: session.session.sessionId,
        });
        const prompt = state.operations.find((op) => op.idempotencyKey === 'prompt:crash-prompt');
        assert.ok(prompt, `the interrupted operation must survive the crash: ${JSON.stringify(state.operations)}`);
        assert.equal(prompt.state, 'uncertain', `a crash between send and ack is "possibly sent": ${JSON.stringify(prompt)}`);
        assert.match(prompt.uncertainReason ?? '', /crash-during-dispatch/);
        // The uncertain operation is NOT replayed: the Host must not see a second prompt.
        assert.equal(host.requestsFor('session.prompt').length, 1, 'an uncertain mutation must never be auto-retried');
      } finally {
        ipc2.close();
      }
    } finally {
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    }
  },

  'a restart preserves task, session and event identity, and never invents a new session': async () => {
    const host = await new FakeHost().start();
    const scratch = scratchDir('crash-identity');
    const stateDir = join(scratch.dir, 'state');
    let daemon = await bootDaemon(host.baseUrl, stateDir);
    try {
      const ipc = await ipcClient(daemon.socketPath);
      const task = await ipc.request({ op: 'task.ensure', clientKey: 'identity-task' });
      const session = await ipc.request({ op: 'session.start', taskId: task.task.taskId, clientKey: 'identity-session' });
      const prompt = await ipc.request({
        op: 'session.prompt', taskId: task.task.taskId, sessionId: session.session.sessionId,
        clientKey: 'identity-prompt', text: 'durable',
      });
      assert.equal(prompt.operation.state, 'succeeded');
      await waitFor(async () => {
        const page = await ipc.request({ op: 'session.events', taskId: task.task.taskId, sessionId: session.session.sessionId, limit: 50 });
        return page.events.length >= 3;
      }, { timeoutMs: 5000, what: 'the turn events to be stored' });
      const before = await ipc.request({ op: 'session.state', taskId: task.task.taskId, sessionId: session.session.sessionId });
      ipc.close();

      daemon.child.kill('SIGKILL');
      await collect(daemon.child);
      daemon = await bootDaemon(host.baseUrl, stateDir);
      const ipc2 = await ipcClient(daemon.socketPath);
      try {
        // The same client keys resolve to the same durable identities after restart.
        const taskAgain = await ipc2.request({ op: 'task.ensure', clientKey: 'identity-task' });
        assert.equal(taskAgain.task.taskId, task.task.taskId);
        assert.equal(taskAgain.created, false);
        const sessionAgain = await ipc2.request({
          op: 'session.start', taskId: task.task.taskId, clientKey: 'identity-session',
        });
        assert.ok(sessionAgain.session, `session must resolve after restart: ${JSON.stringify(sessionAgain)}`);
        assert.equal(sessionAgain.session.sessionId, session.session.sessionId);
        assert.equal(sessionAgain.session.hostSessionId, session.session.hostSessionId);
        const creates = host.requestsFor('session.create').length;
        assert.equal(creates, 1, `restart must not create a second Host session, saw ${creates}`);

        const after = await ipc2.request({
          op: 'session.state', taskId: task.task.taskId, sessionId: session.session.sessionId,
        });
        assert.equal(after.events, before.events, 'the stored event count must survive the restart');
        assert.equal(after.cursor.highWater, before.cursor.highWater);
        // The turn that ended before the crash is still recorded as ended, by evidence.
        assert.equal(after.execution.state, before.execution.state);
      } finally {
        ipc2.close();
      }
    } finally {
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    }
  },

  'two daemons cannot own one state directory, and a clean release lets the next one in': async () => {
    const host = await new FakeHost().start();
    const scratch = scratchDir('crash-owner');
    const stateDir = join(scratch.dir, 'state');
    const daemon = await bootDaemon(host.baseUrl, stateDir);
    try {
      const contender = spawnNode(['dist/bin/dsh-pilot-daemon.js', '--state-dir', stateDir, '--host', host.baseUrl]);
      const refused = await collect(contender);
      assert.equal(refused.code, 4, `a second owner must be refused: ${JSON.stringify(refused)}`);
      // Stop the owner cleanly, then a new daemon must be able to take over.
      await daemon.stop();
      const replacement = await bootDaemon(host.baseUrl, stateDir);
      try {
        const ipc = await ipcClient(replacement.socketPath);
        const health = await ipc.request({ op: 'health' });
        assert.equal(health.pid, replacement.child.pid);
        ipc.close();
      } finally {
        await replacement.stop();
      }
    } finally {
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    }
  },

  'SIGSTOP on the living owner: ownership is retained, and it comes back with its state': async () => {
    const host = await new FakeHost().start();
    const scratch = scratchDir('crash-stop');
    const stateDir = join(scratch.dir, 'state');
    const daemon = await bootDaemon(host.baseUrl, stateDir);
    try {
      // A live but suspended owner must keep ownership: a timeout-based lease would hand the
      // state directory to a second daemon while the first is still running, which is the
      // failure mode this test exists to prevent.
      daemon.child.kill('SIGSTOP');
      await new Promise((resolve) => setTimeout(resolve, 300));
      const contender = spawnNode(['dist/bin/dsh-pilot-daemon.js', '--state-dir', stateDir, '--host', host.baseUrl]);
      const refused = await collect(contender);
      assert.equal(refused.code, 4,
        `a suspended owner must still hold the state directory (got exit ${refused.code}: ${refused.stderr.trim()})`);

      // Resume: the original process is still the owner and its state is intact.
      daemon.child.kill('SIGCONT');
      await waitFor(() => {
        try {
          const info = JSON.parse(readFileSync(join(stateDir, 'daemon.ready.json'), 'utf8'));
          return typeof info.pid === 'number';
        } catch { return false; }
      }, { timeoutMs: 5000, what: 'the resumed daemon to remain usable' });
      const ipc = await ipcClient(daemon.socketPath);
      try {
        const health = await ipc.request({ op: 'health' });
        assert.equal(health.pid, daemon.child.pid, 'the resumed process must still be the owner');
        // The downlink re-establishes after resume; wait on the observable state rather than
        // asserting on the instant, since the loop resumes on its own schedule.
        await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready', {
          timeoutMs: 10000, what: 'the resumed owner to rebind its downlink',
        });
      } finally {
        ipc.close();
      }
    } finally {
      try { daemon.child.kill('SIGCONT'); } catch { /* already running */ }
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    }
  },

  'locking primitive is real: the probe refuses a second handle on this platform': async () => {
    const { probeLocking } = await import('../../dist/lib/owner-lock.js');
    const scratch = scratchDir('crash-lockprobe');
    const lockPath = join(scratch.dir, 'owner.lock.sqlite');
    const probe = probeLocking(lockPath);
    // This test exists to make the platform assumption explicit: if the primitive is absent
    // the design's exclusion guarantee does not hold, and that must be a loud failure rather
    // than a quietly weaker guarantee.
    assert.equal(probe.supported, true, `no exclusion primitive on this platform: ${JSON.stringify(probe)}`);
    assert.equal(probe.secondRefused, true, `the primitive did not exclude a second handle: ${JSON.stringify(probe)}`);
    assert.equal(probe.inodeStable, true, 'the lock inode must not change while held');
    scratch.cleanup();
  },

  'state directory permissions: the authority token is private to the operator account': async () => {
    const host = await new FakeHost().start();
    const scratch = scratchDir('crash-perms');
    const stateDir = join(scratch.dir, 'state');
    const daemon = await bootDaemon(host.baseUrl, stateDir);
    try {
      const tokenPath = join(stateDir, 'authority.token');
      const mode = statSync(tokenPath).mode & 0o777;
      assert.equal(mode, 0o600, `the authority token must not be world readable (mode ${mode.toString(8)})`);
      const dirMode = statSync(stateDir).mode & 0o777;
      assert.equal(dirMode & 0o077, 0, `the state directory must not be group/world accessible (mode ${dirMode.toString(8)})`);
      // The token is a random secret, not a constant, and is not derived from the path.
      const token = readFileSync(tokenPath, 'utf8').trim();
      assert.ok(token.length >= 32);
      assert.notEqual(token, stateDir);
    } finally {
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    }
  },
};
