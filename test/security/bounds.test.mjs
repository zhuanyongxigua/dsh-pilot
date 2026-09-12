/**
 * Security and bounds layer.
 *
 * Why these tests exist: an "unbounded" or "unauthenticated" path is not a theoretical worry
 * here — the bridge sits between a model-driven caller and a system that can run shell tools.
 * Each test below targets one specific way that boundary could be crossed, and each asserts a
 * REFUSAL (a typed error, a closed connection, a 0600 file) rather than merely "no crash".
 *
 * Boundary note: none of these tests exercise network reachability or TLS, because the trust
 * fence is a browser-origin defence and not an auth layer; claiming otherwise would be a lie.
 */

import { join } from 'node:path';
import { createServer } from 'node:net';
import { readFileSync, statSync } from 'node:fs';
import { assert, ipcClient, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/**
 * A refusal from the daemon is a coded BridgeError; the assertions below read that code.
 * @typedef {import('../../dist/lib/errors.js').BridgeError} BridgeError
 */

async function rig(label) {
  const host = await new FakeHost().start();
  const scratch = scratchDir(label);
  const stateDir = join(scratch.dir, 'state');
  const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir });
  const teardown = async () => {
    await daemon.stop();
    await host.stop();
    scratch.cleanup();
  };
  return { host, daemon, stateDir, teardown };
}

export default {
  'IPC is a local socket with 0600 permissions, not a network listener': async () => {
    const { daemon, teardown } = await rig('sec-ipc');
    try {
      // A unix socket path, never a TCP port.
      assert.ok(daemon.socketPath.startsWith('/'), `expected a local socket path, got ${daemon.socketPath}`);
      assert.equal(daemon.socketPath.includes(':'), false, 'the IPC endpoint must not be a host:port');
      const mode = statSync(daemon.socketPath).mode & 0o777;
      assert.equal(mode & 0o077, 0, `the IPC socket must not be group/world accessible (mode ${mode.toString(8)})`);
      assert.equal(mode & 0o777, 0o600, `expected 0600 on the socket, got ${mode.toString(8)}`);
    } finally {
      await teardown();
    }
  },

  'a hostile IPC line is refused without taking the daemon down': async () => {
    const { daemon, teardown } = await rig('sec-line');
    try {
      const { createConnection } = await import('node:net');
      // Oversized line: the daemon must close the connection, not buffer unboundedly.
      const socket = createConnection(daemon.socketPath);
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      const huge = `{"op":"health","pad":"${'x'.repeat(5 * 1024 * 1024)}"}\n`;
      let closed = false;
      socket.on('close', () => { closed = true; });
      socket.write(huge);
      // The bound is deliberately looser than it looks like it needs to be, and the reason is measured
      // rather than hypothetical: at 5 s this wait timed out once during a full-suite run and passed in
      // isolation immediately afterwards, twice over. The condition is real (the socket must close) and
      // the refusal itself is not in question — what the extra headroom covers is the daemon process
      // being scheduled alongside the rest of the suite. A bound that fails under load reports a
      // property about the machine as if it were a property about the bridge.
      await waitFor(() => closed, { timeoutMs: 20_000, what: 'the daemon to drop an oversized IPC line' });
      // The daemon is still alive and serving.
      const client = await ipcClient(daemon.socketPath);
      try {
        const health = await client.request({ op: 'health' });
        assert.equal(health.status, 'ok');
      } finally {
        client.close();
      }
    } finally {
      await teardown();
    }
  },

  'an unauthenticated caller cannot decide an approval, even with a well-formed request': async () => {
    const { host, daemon, teardown } = await rig('sec-approval');
    try {
      const client = await ipcClient(daemon.socketPath);
      try {
        const task = await client.request({ op: 'task.ensure', clientKey: 'sec-task' });
        const session = await client.request({ op: 'session.start', taskId: task.task.taskId, clientKey: 'sec-session' });
        const approval = host.emitApprovalRequested(session.session.hostSessionId);
        await waitFor(async () => (await client.request({ op: 'interaction.list', taskId: task.task.taskId })).interactions.length >= 1,
          { timeoutMs: 5000, what: 'the approval to be recorded' });
        const interaction = (await client.request({ op: 'interaction.list', taskId: task.task.taskId })).interactions[0];

        // Every unauthenticated shape must be refused, and nothing may be delivered upstream.
        const attempts = [
          { label: 'no token', payload: {} },
          { label: 'empty token', payload: { authorityToken: '' } },
          { label: 'wrong token', payload: { authorityToken: 'x'.repeat(64) } },
          { label: 'token from another state dir', payload: { authorityToken: 'y'.repeat(64) } },
        ];
        for (const attempt of attempts) {
          /** @type {BridgeError|null} */
          let caught = null;
          try {
            await client.request({
              op: 'interaction.decide', taskId: task.task.taskId, interactionId: interaction.interactionId,
              decision: 'allowed-once', ...attempt.payload,
            });
          } catch (error) {
            caught = /** @type {BridgeError} */ (error);
          }
          assert.ok(caught, `${attempt.label} must be refused`);
          assert.equal(caught.code, 'APPROVAL_UNAUTHORIZED', `${attempt.label}: unexpected code ${caught.code}`);
        }
        assert.equal(host.respondReceipts.length, 0, 'no unauthenticated attempt may reach the Host');
        assert.equal(approval.rpcId.length > 0, true);
      } finally {
        client.close();
      }
    } finally {
      await teardown();
    }
  },

  'the authority token is never readable through the IPC surface': async () => {
    const { daemon, stateDir, teardown } = await rig('sec-token-leak');
    try {
      const token = readFileSync(join(stateDir, 'authority.token'), 'utf8').trim();
      const client = await ipcClient(daemon.socketPath);
      try {
        const health = await client.request({ op: 'health' });
        const serialized = JSON.stringify(health);
        assert.equal(serialized.includes(token), false, 'health must not echo the authority token');
        assert.equal(serialized.includes('authority.token') && serialized.includes(token), false);
        // No op returns the token.
        for (const request of [{ op: 'health' }, { op: 'task.ensure', clientKey: 'sec-leak' }]) {
          const response = await client.request(request);
          assert.equal(JSON.stringify(response).includes(token), false, `${request.op} leaked the token`);
        }
      } finally {
        client.close();
      }
    } finally {
      await teardown();
    }
  },

  'host error details are bounded before they reach a caller': async () => {
    const { host, daemon, teardown } = await rig('sec-bounds');
    try {
      const client = await ipcClient(daemon.socketPath);
      try {
        const task = await client.request({ op: 'task.ensure', clientKey: 'sec-bounds-task' });
        const session = await client.request({ op: 'session.start', taskId: task.task.taskId, clientKey: 'sec-bounds-session' });
        // A Host that answers with an enormous error message and a huge details object must not
        // be able to inflate our own response without limit.
        host.rejectWith('session.prompt', { code: 'agent-busy', message: 'm'.repeat(100_000) });
        const result = await client.request({
          op: 'session.prompt', taskId: task.task.taskId, sessionId: session.session.sessionId,
          clientKey: 'sec-bounds-prompt', text: 'x',
        });
        const serialized = JSON.stringify(result);
        assert.ok(serialized.length < 20_000, `a host error must be bounded, got ${serialized.length} bytes`);
        assert.equal(result.operation.state, 'refused');
      } finally {
        client.close();
      }
    } finally {
      await teardown();
    }
  },

  'an oversized event frame is refused as oversize rather than buffered': async () => {
    const { host, daemon, teardown } = await rig('sec-frame');
    try {
      const client = await ipcClient(daemon.socketPath);
      try {
        const task = await client.request({ op: 'task.ensure', clientKey: 'sec-frame-task' });
        const session = await client.request({ op: 'session.start', taskId: task.task.taskId, clientKey: 'sec-frame-session' });
        await waitFor(async () => (await client.request({ op: 'health' })).connection === 'ready', { timeoutMs: 5000, what: 'mux ready' });
        // The fixture sends a frame well over the configured 1MiB ceiling.
        host.injectFaults({ oversizeFrames: 1 });
        host.emitSessionEvent(session.session.hostSessionId, { type: 'note', text: 'trigger' });
        await waitFor(async () => (await client.request({ op: 'health' })).eventStats.oversize >= 1,
          { timeoutMs: 5000, what: 'the oversize frame to be refused' });
        // Oversize frames are counted, never stored.
        const page = await client.request({ op: 'session.events', taskId: task.task.taskId, sessionId: session.session.sessionId, limit: 50 });
        for (const event of page.events) {
          assert.ok(JSON.stringify(event).length < 2 * 1024 * 1024, 'no oversized event may be stored');
        }
      } finally {
        client.close();
      }
    } finally {
      await teardown();
    }
  },

  'an event page is bounded by the configured maximum regardless of what is asked for': async () => {
    const { host, daemon, teardown } = await rig('sec-page');
    try {
      const client = await ipcClient(daemon.socketPath);
      try {
        const task = await client.request({ op: 'task.ensure', clientKey: 'sec-page-task' });
        const session = await client.request({ op: 'session.start', taskId: task.task.taskId, clientKey: 'sec-page-session' });
        for (let i = 0; i < 12; i += 1) {
          host.emitSessionEvent(session.session.hostSessionId, { type: 'note', text: `e${i}` });
        }
        await waitFor(async () => (await client.request({ op: 'session.events', taskId: task.task.taskId, sessionId: session.session.sessionId, limit: 50 })).events.length >= 12,
          { timeoutMs: 5000, what: 'events to land' });
        const page = await client.request({ op: 'session.events', taskId: task.task.taskId, sessionId: session.session.sessionId, limit: 5 });
        assert.equal(page.events.length, 5, 'the page size must be honoured');
        assert.equal(page.hasMore, true, 'a truncated page must say so');
        // An absurd limit is clamped, not rejected with an unbounded result.
        const clamped = await client.request({ op: 'session.events', taskId: task.task.taskId, sessionId: session.session.sessionId, limit: 10_000_000 });
        assert.ok(clamped.events.length <= 200, `the page must be clamped to the configured maximum, got ${clamped.events.length}`);
      } finally {
        client.close();
      }
    } finally {
      await teardown();
    }
  },

  'state directory contents contain no credential values, only references': async () => {
    const { daemon, stateDir, teardown } = await rig('sec-secrets');
    try {
      const client = await ipcClient(daemon.socketPath);
      try {
        const task = await client.request({ op: 'task.ensure', clientKey: 'sec-secrets-task' });
        await client.request({ op: 'session.start', taskId: task.task.taskId, clientKey: 'sec-secrets-session' });
      } finally {
        client.close();
      }
      // Read the durable state as bytes and look for credential-shaped material. The markers
      // below are values a careless implementation would copy out of the environment.
      const sqlite = process.getBuiltinModule('node:sqlite');
      const db = new sqlite.DatabaseSync(join(stateDir, 'state.sqlite'), { readOnly: true });
      const dump = db.prepare('select cast(group_concat(sql) as blob) as text from sqlite_master').get();
      const rows = db.prepare('select * from tasks union all select * from sessions').all();
      db.close();
      const haystack = `${JSON.stringify(dump)}${JSON.stringify(rows)}`;
      for (const marker of ['ANTHROPIC_AUTH_TOKEN', 'sk-', 'Bearer ', 'apiKey=', 'authToken']) {
        assert.equal(haystack.includes(marker), false, `state must not contain credential-like material (${marker})`);
      }
      // And the raw file must not contain an API-key-looking literal either.
      const raw = readFileSync(join(stateDir, 'state.sqlite')).toString('latin1');
      assert.equal(/sk-[A-Za-z0-9]{16,}/.test(raw), false, 'no API-key-shaped literal may appear in durable state');
    } finally {
      await teardown();
    }
  },

  'the daemon refuses to bind anything on a TCP port': async () => {
    const { daemon, teardown } = await rig('sec-nolisten');
    try {
      // Prove the daemon exposes exactly one endpoint: the socket file. If it had opened a TCP
      // listener it would show up as a listening port owned by its pid.
      const { execFileSync } = await import('node:child_process');
      const pid = daemon.child.pid;
      assert.equal(typeof pid, 'number', 'the fixture must report the daemon pid, otherwise this check is vacuous');
      let listing = '';
      try {
        listing = execFileSync('lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-p', String(pid)], { encoding: 'utf8' });
      } catch (error) {
        // lsof exits non-zero when there is nothing to report; that is the expected outcome.
        listing = /** @type {{stdout?: string}} */ (error).stdout ?? '';
      }
      // Without -a, lsof ORs its filters and would list every process on the machine; the
      // assertion below is only meaningful because -a makes the pid filter binding.
      for (const line of listing.split('\n')) {
        if (!line.includes(String(pid))) continue;
        assert.equal(/LISTEN/.test(line), false, `the daemon must not listen on TCP: ${line}`);
      }
    } finally {
      await teardown();
    }
  },
};
