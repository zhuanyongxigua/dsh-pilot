/**
 * Isolated official-DSH-Host layer: control plane.
 *
 * Why these tests exist: everything else in this repository is evidence about OUR client. Only
 * this layer touches the real product, and it does so the only acceptable way — a Host this test
 * starts itself, in its own home root, on an OS-assigned port, never the operator's Host.
 *
 * Scope: boot, `host.describe`, an empty session list, the `426` upgrade refusal on both
 * downlinks, and reaching `ready` against the real Host. Turn-level behaviour lives in
 * `turns.test.mjs`, which is routed at a deterministic mock provider.
 *
 * Opt-in: requires an installed `@deepseek-ai/dsh`; run with `--isolated`. Skipped by default.
 */

import { assert, skip } from '../helpers.mjs';
import { resolveDshBin, startMockedDshHost } from './rig.mjs';

/** @param {any} context */
function requireIsolated(context) {
  if (!context?.isolated) skip('opt-in: run with --isolated (this layer starts a real DSH Host)');
  if (!resolveDshBin()) skip('no installed @deepseek-ai/dsh found; set DSH_PILOT_DSH_BIN to run this layer');
}

/** @param {string} baseUrl */
async function controlCall(baseUrl, method, payload = {}) {
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `probe-${method}`, method, payload }),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { /* a non-JSON body is reported by the caller */ }
  return { status: response.status, parsed, text };
}

export default {
  'an isolated Host boots on an OS-assigned port, in its own home, and answers host.describe': async (context) => {
    requireIsolated(context);
    const rig = await startMockedDshHost({ label: 'isolated-boot' });
    try {
      assert.ok(rig.home.startsWith(rig.scratch.dir), 'the Host must run inside the test single-use home');
      assert.equal(rig.hostBase.endsWith(':3080'), false);

      const describe = await controlCall(rig.hostBase, 'host.describe');
      assert.equal(describe.status, 200, `host.describe failed: ${describe.text.slice(0, 300)}`);
      assert.equal(describe.parsed.result.ok, true, JSON.stringify(describe.parsed).slice(0, 300));
      const value = describe.parsed.result.value;
      // Measured fact, recorded rather than assumed: `version` is a diagnostic string, NOT a pin.
      // On this machine it reports 0.0.1 while the installed package is 0.1.1-rc.2.
      process.stdout.write(`       host.describe version=${JSON.stringify(value.version)} provider=${JSON.stringify(value.provider)} model=${JSON.stringify(value.model)}\n`);
      assert.ok(typeof value.version === 'string');
      // The route must be the one the rig wrote, proving the settings were honoured and no ambient
      // provider was substituted.
      assert.equal(value.provider, 'dsh-pilot-mock', 'the Host must use the rig mock provider');
      assert.equal(value.model, 'dsh-pilot-mock-1', 'the Host must use the rig mock model');
      assert.equal(rig.mock.requests.length, 0, 'host.describe must not call the model route');

      const list = await controlCall(rig.hostBase, 'session.list');
      assert.equal(list.status, 200);
      assert.equal(Array.isArray(list.parsed.result.value.items), true);
      assert.equal(list.parsed.result.value.items.length, 0, 'the isolated Host must start with no sessions');
    } finally {
      await rig.stop();
      rig.cleanup();
    }
  },

  'both event downlinks refuse a plain GET with 426, as the bridge assumes': async (context) => {
    requireIsolated(context);
    const rig = await startMockedDshHost({ label: 'isolated-426' });
    try {
      for (const path of ['/api/events.mux', '/api/events.host']) {
        const response = await fetch(`${rig.hostBase}${path}`);
        assert.equal(response.status, 426, `${path} must refuse a plain GET with 426, got ${response.status}`);
      }
    } finally {
      await rig.stop();
      rig.cleanup();
    }
  },

  'the unverified method set is reported, and a method outside it is refused not faked': async (context) => {
    requireIsolated(context);
    const rig = await startMockedDshHost({ label: 'isolated-drift' });
    try {
      // `command.execute` existed in an older published tree and is gone from this one. The bridge
      // must not answer it with a plausible default.
      const gone = await controlCall(rig.hostBase, 'command.execute', { command: 'true' });
      const answered = gone.parsed?.result?.ok === true;
      assert.equal(answered, false, 'a method absent from this Host must not answer ok:true');
      // Record how the real Host refuses, so a future drift is visible in the log rather than
      // silently absorbed by a status-code assertion.
      process.stdout.write(`       command.execute -> HTTP ${gone.status} ${gone.text.slice(0, 160)}\n`);
    } finally {
      await rig.stop();
      rig.cleanup();
    }
  },

  'the bridge attaches to a real Host and reaches ready without a protocol error': async (context) => {
    requireIsolated(context);
    const rig = await startMockedDshHost({ label: 'isolated-attach' });
    const { startDaemon, ipcClient, waitFor } = await import('../helpers.mjs');
    let daemon = null;
    try {
      daemon = await startDaemon({ hostBase: rig.hostBase, stateDir: `${rig.scratch.dir}/state` });
      const ipc = await ipcClient(daemon.socketPath);
      try {
        // This is the claim the fake-Host layer cannot make: the real Host's own downlinks and
        // envelope shapes satisfy our client, not merely our fixture's.
        await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
          { timeoutMs: 20_000, what: 'the bridge to attach to the real Host downlinks' });
        const health = await ipc.request({ op: 'health' });
        assert.equal(health.connection, 'ready');
        assert.equal(health.adapterStats.protocolErrors, 0, `the real Host produced protocol errors: ${JSON.stringify(health.adapterStats)}`);
        process.stdout.write(`       pinned methods=${health.capabilities.declared.length} unverified=${health.capabilities.unverified.length}\n`);
        const task = await ipc.request({ op: 'task.ensure', clientKey: `isolated-${Date.now()}` });
        assert.match(task.task.taskId, /^task_/);
      } finally {
        ipc.close();
      }
    } finally {
      if (daemon) await daemon.stop();
      await rig.stop();
      rig.cleanup();
    }
  },
};
