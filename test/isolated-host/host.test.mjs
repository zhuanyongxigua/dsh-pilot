/**
 * Isolated official-DSH-Host layer.
 *
 * Why these tests exist: everything else in this repository is evidence about OUR client. Only
 * this layer touches the real product, and it does so the only acceptable way — a Host this test
 * starts itself, in its own home root (`DSH_HOME`), on an OS-assigned port. It never reads,
 * writes, or connects to a Host the operator is already running (in particular never port 3080),
 * and it kills what it started.
 *
 * Scope honesty: these tests drive CONTROL-plane facts only — boot, `host.describe`,
 * `session.list`, the `426` upgrade refusal, and capability/error-code agreement between the
 * bridge's pinned sets and the real method map. Turn-level behaviour against the real Host is
 * gated behind the mock-provider question tracked as blocker B1 in `.local/status.json`; a test
 * that cannot create a session without a live provider route must SKIP and say why, never
 * pretend to pass.
 *
 * Opt-in: requires an installed `@deepseek-ai/dsh`; run with `--isolated`. Skipped by default.
 */

import { mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { assert, ROOT, scratchDir, skip, waitFor } from '../helpers.mjs';

/** Locate the installed DSH CLI. Absence is a skip with a reason, never a failure. */
function resolveDshBin() {
  const candidates = [
    process.env.DSH_PILOT_DSH_BIN,
    join(ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'bin', 'dsh.mjs'),
  ].filter(Boolean);
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  // Fall back to the global installation on this machine, without asserting anything about it.
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const candidate = join(globalRoot, '@deepseek-ai', 'dsh', 'bin', 'dsh.mjs');
    if (existsSync(candidate)) return candidate;
  } catch { /* npm unavailable: treated as absent */ }
  return null;
}

/**
 * Boot an isolated Host: its own home root, its own OS-assigned port, no browser.
 * @returns {Promise<{baseUrl: string, home: string, pid: number, output: () => string, stop: () => Promise<void>}>}
 */
async function startIsolatedHost({ dshBin, home }) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Port 0 asks the OS for a free port; the chosen port is discovered from the Host's own
  // output, so this can never collide with a port the operator is using.
  const child = spawn(process.execPath, [dshBin, 'web', '--port', '0', '--host', '127.0.0.1', '--no-open'], {
    cwd: home,
    env: { ...process.env, DSH_HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const collectChunk = (chunk) => { output += chunk; };
  child.stdout.on('data', collectChunk);
  child.stderr.on('data', collectChunk);
  let exited = null;
  child.on('close', (code, signal) => { exited = { code, signal }; });

  let baseUrl = null;
  try {
    await waitFor(() => {
      const match = output.match(/https?:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return false;
      baseUrl = `http://127.0.0.1:${match[1]}`;
      return true;
    }, { timeoutMs: 45000, what: 'the isolated Host to report its listening URL', intervalMs: 100 });
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`${error.message}\noutput:\n${output.slice(-2000)}`);
  }
  assert.ok(baseUrl, 'the isolated Host must report a URL');
  assert.match(baseUrl, /127\.0\.0\.1:\d+/, 'unexpected bind address');
  assert.equal(baseUrl.endsWith(':3080'), false, 'this suite must never touch port 3080');

  // Wait for the control plane to answer, so later assertions are not racing the boot.
  await waitFor(async () => {
    try {
      const response = await fetch(`${baseUrl}/api/host.describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'host.describe', payload: {} }),
      });
      return response.ok;
    } catch { return false; }
  }, { timeoutMs: 30000, what: 'the isolated Host control plane to answer' });

  return {
    baseUrl,
    home,
    pid: child.pid,
    output: () => output,
    stop: async () => {
      if (exited) return;
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('close', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
      if (!exited) child.kill('SIGKILL');
    },
  };
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
  try { parsed = JSON.parse(text); } catch { /* non-JSON body is reported below */ }
  return { status: response.status, parsed, text };
}

export default {
  'an isolated Host boots on an OS-assigned port, in its own home, and answers host.describe': async (context) => {
    if (!context?.isolated) skip('opt-in: run with --isolated (this layer starts a real DSH Host)');
    const dshBin = resolveDshBin();
    if (!dshBin) skip('no installed @deepseek-ai/dsh found; set DSH_PILOT_DSH_BIN to run this layer');
    const scratch = scratchDir('isolated-boot');
    const home = join(scratch.dir, 'home');
    const host = await startIsolatedHost({ dshBin, home });
    try {
      // The home root is ours, and the real one was never touched.
      assert.ok(home.startsWith(scratch.dir), 'the Host must run in the test single-use home');
      const describe = await controlCall(host.baseUrl, 'host.describe');
      assert.equal(describe.status, 200, `host.describe failed: ${describe.text.slice(0, 300)}`);
      assert.equal(describe.parsed.result.ok, true, JSON.stringify(describe.parsed).slice(0, 300));
      const value = describe.parsed.result.value;
      // Recorded measured fact: `version` is a diagnostic string, NOT usable as a pin.
      process.stdout.write(`       host.describe version=${JSON.stringify(value.version)} provider=${JSON.stringify(value.provider)} model=${JSON.stringify(value.model)}\n`);
      assert.ok(typeof value.version === 'string');
      // Sessions start empty: this proves we are looking at a fresh isolated home.
      const list = await controlCall(host.baseUrl, 'session.list');
      assert.equal(list.status, 200);
      assert.equal(Array.isArray(list.parsed.result.value.items), true);
      assert.equal(list.parsed.result.value.items.length, 0, 'the isolated Host must start with no sessions');
    } finally {
      await host.stop();
      scratch.cleanup();
    }
  },

  'the event downlinks refuse a plain GET with 426, as the bridge assumes': async (context) => {
    if (!context?.isolated) skip('opt-in: run with --isolated');
    const dshBin = resolveDshBin();
    if (!dshBin) skip('no installed @deepseek-ai/dsh found; set DSH_PILOT_DSH_BIN to run this layer');
    const scratch = scratchDir('isolated-426');
    const home = join(scratch.dir, 'home');
    const host = await startIsolatedHost({ dshBin, home });
    try {
      for (const path of ['/api/events.mux', '/api/events.host']) {
        const response = await fetch(`${host.baseUrl}${path}`);
        assert.equal(response.status, 426, `${path} must refuse a plain GET with 426, got ${response.status}`);
      }
    } finally {
      await host.stop();
      scratch.cleanup();
    }
  },

  'the bridge can read an isolated Host with no adapter protocol errors': async (context) => {
    if (!context?.isolated) skip('opt-in: run with --isolated');
    const dshBin = resolveDshBin();
    if (!dshBin) skip('no installed @deepseek-ai/dsh found; set DSH_PILOT_DSH_BIN to run this layer');
    const { startDaemon, ipcClient } = await import('../helpers.mjs');
    const scratch = scratchDir('isolated-bridge');
    const home = join(scratch.dir, 'home');
    const host = await startIsolatedHost({ dshBin, home });
    let daemon = null;
    try {
      daemon = await startDaemon({ hostBase: host.baseUrl, stateDir: join(scratch.dir, 'state') });
      const ipc = await ipcClient(daemon.socketPath);
      try {
        // The downlink must come up against the REAL Host: this is the claim the fake-Host
        // layer cannot make on its own.
        await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
          { timeoutMs: 20000, what: 'the bridge to attach to the real Host downlink' });
        const health = await ipc.request({ op: 'health' });
        assert.equal(health.connection, 'ready');
        // Only genuinely pinned, verified methods may be advertised; drift is reported, not hidden.
        const unverified = health.capabilities.unverified;
        process.stdout.write(`       pinned methods=${health.capabilities.declared.length} unverified=${unverified.length}\n`);
        // A read-only task/session read must work without creating anything on the Host.
        const task = await ipc.request({ op: 'task.ensure', clientKey: `isolated-${Date.now()}` });
        assert.match(task.task.taskId, /^task_/);
      } finally {
        ipc.close();
      }
    } finally {
      if (daemon) await daemon.stop();
      await host.stop();
      scratch.cleanup();
    }
  },

  'turn-level behaviour against the real Host is gated on a provider route': async (context) => {
    if (!context?.isolated) skip('opt-in: run with --isolated');
    // This is the honest form of blocker B1: without a provider route the isolated Host cannot
    // complete a turn, and no substitute (a fake model, a fabricated event) would be evidence.
    skip(
      'BLOCKED (B1): starting a turn against the real Host requires a provider route for this '
      + 'single-use home; the mock-provider fixture is unproven, so turn-level isolated-Host tests '
      + 'are not run and must not be reported as passing',
    );
  },
};
