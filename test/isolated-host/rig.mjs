/**
 * Shared rig for the isolated official-DSH-Host layer.
 *
 * Why this file exists: several suites need the same thing — a REAL DSH Host, booted by the test,
 * in a home root the test owns, with a model route that never leaves `127.0.0.1`. Doing that
 * correctly involves four things that are easy to get subtly wrong, so they live in one place
 * instead of being copied:
 *
 *   1. **Isolation.** The Host gets its own `DSH_HOME`, its own OS-assigned port, and its own
 *      working directory. It can never reach the operator's real home, and it can never bind the
 *      port a running Host or the Web GUI is using.
 *   2. **A closed provider route.** The only reachable model route is the mock's loopback endpoint.
 *      No ambient credential value is read; the settings reference an environment variable NAME and
 *      the test supplies a value for it.
 *   3. **Determinism.** The mock answers from a script the test sets, so a turn ends because DSH
 *      really ran its loop, not because we fabricated a success.
 *   4. **Cleanup.** Everything the rig started is stopped, including after a failing assertion.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { scratchDir, waitFor } from '../helpers.mjs';
import { MockProvider, isolatedHostSettings, MOCK_API_KEY_ENV, MOCK_MODEL_ID, MOCK_PROVIDER_ID } from '../fixtures/mock-provider.mjs';

/**
 * Sandbox capability for hosts this rig boots — declared from settings, then MEASURED by a tool.
 *
 * Why this exists: the strongest oracle in this layer is a file on disk written by a real bash
 * tool. Whether that is verifiable depends on the HOST's confinement backend, not on the bridge.
 * An earlier revision handled that by widening the policy to `danger-full-access`, which the
 * coordinator's review rejected — correctly, because loosening a sandbox after it refuses is
 * escalation-after-refusal, and a tool running unconfined is not the tool an operator's DSH runs.
 *
 * So the capability is split into two honest halves:
 *
 *   - `policyMode` is DECLARED, read from the settings file the Host actually booted with. It is a
 *     pure read of our own configuration, and it also makes "no test may run unconfined" checkable.
 *   - `toolEffectsPossible` is MEASURED, and only ever set from an observed `tool/result`. It stays
 *     `null` until a real tool has been attempted, so nothing can substitute an environment guess
 *     for an observation.
 */

/**
 * Read the sandbox mode back out of a settings file this rig wrote, so the declared mode is the
 * one the Host actually read rather than a constant we merely believe in.
 * @param {string} settingsPath
 * @returns {string|null}
 */
export function readSandboxMode(settingsPath) {
  try {
    const text = readFileSync(settingsPath, 'utf8');
    const match = text.match(/sandbox-policy:\s*\n\s*mode:\s*(\S+)/);
    return match ? match[1] : null;
  } catch { return null; }
}

/** @type {{toolEffectsPossible: boolean|null, evidence: string|null}} */
export const sandboxCapability = { toolEffectsPossible: null, evidence: null };

/**
 * Record what a real tool attempt observed. Called only with the outcome of an actual tool result.
 * @param {{possible: boolean, evidence: string}} observation
 */
export function recordSandboxCapability(observation) {
  sandboxCapability.toolEffectsPossible = observation.possible;
  sandboxCapability.evidence = observation.evidence;
}

/** Absolute path to the repository root, from this file's location. */
const HERE = new URL('..', import.meta.url).pathname;

/**
 * Locate an installed DSH CLI.
 *
 * The published `bin` entry is `lib/bin.js`; a `bin/dsh.mjs` path was assumed at first and is
 * wrong, which is exactly the kind of guess this function exists to remove — it checks candidates
 * and returns null rather than throwing, so a caller can SKIP with a reason.
 * @returns {string|null}
 */
export function resolveDshBin() {
  /** @type {string[]} */
  const candidates = [
    process.env.DSH_PILOT_DSH_BIN,
    join(HERE, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  ].filter((candidate) => typeof candidate === 'string');
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  try {
    const globalRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const candidate = join(globalRoot, '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (existsSync(candidate)) return candidate;
    const manifest = join(globalRoot, '@deepseek-ai', 'dsh', 'package.json');
    if (existsSync(manifest)) {
      const parsed = JSON.parse(execFileSync('cat', [manifest], { encoding: 'utf8' }));
      const bin = typeof parsed.bin === 'string' ? parsed.bin : parsed.bin?.dsh;
      if (bin) {
        const resolved = join(globalRoot, '@deepseek-ai', 'dsh', bin);
        if (existsSync(resolved)) return resolved;
      }
    }
  } catch { /* npm unavailable or the package is absent: reported as null */ }
  return null;
}

/**
 * Boot an isolated Host routed exclusively at a fresh mock provider.
 *
 * The sandbox/approval policy is NOT a parameter, and that is deliberate. An earlier revision
 * accepted `permission: 'danger-full-access'` so a tool test could still run on a machine whose
 * sandbox backend is unavailable; the coordinator's review rejected that, correctly, as
 * escalation-after-refusal. A confinement policy that gets loosened whenever the strict policy
 * refuses is not a confinement policy, and a tool that runs unconfined is not the tool an operator's
 * DSH runs. Every Host this rig boots therefore uses the same `workspace-write` + `ask` posture an
 * operator uses, and a suite that cannot verify a tool effect under it must say so rather than
 * widen the boundary.
 *
 * The `permission` option was REMOVED on purpose; see the note above.
 * @param {{label?: string, defaultReply?: string, extraEnv?: Record<string,string>, llmRetries?: number}} [options]
 * @returns {Promise<{
 *   hostBase: string, home: string, scratch: object, mock: MockProvider, dshBin: string,
 *   pid: number|undefined, settingsPath: string, sandboxMode: string|null,
 *   output: () => string, isAlive: () => boolean,
 *   restart: () => Promise<string>, stop: () => Promise<void>, cleanup: () => void,
 * }>}
 */
export async function startMockedDshHost(options = {}) {
  const dshBin = resolveDshBin();
  if (!dshBin) throw new Error('no installed @deepseek-ai/dsh found');
  const scratch = scratchDir(options.label ?? 'isolated-host');
  const home = join(scratch.dir, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });

  const mock = new MockProvider({ defaultText: options.defaultReply ?? 'isolated mock reply' });
  await mock.start();
  // Written BEFORE boot: the route must exist in the settings the Host reads at startup, so the
  // Host cannot silently fall back to a different, ambient provider.
  const settingsPath = join(home, 'settings.yaml');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(settingsPath, isolatedHostSettings({
    messagesBaseUrl: mock.baseUrl,
    ...(options.llmRetries !== undefined ? { llmRetries: options.llmRetries } : {}),
  }));

  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  let output = '';
  let exited = false;

  const launch = async () => {
    output = '';
    exited = false;
    child = spawn(process.execPath, [dshBin, 'web', '--port', '0', '--host', '127.0.0.1', '--no-open'], {
      // The Host's own working directory, so any relative artefact it writes lands in our scratch.
      cwd: home,
      env: {
        ...process.env,
        DSH_HOME: home,
        NO_COLOR: '1',
        // The VALUE never appears in the repository, in a fixture, or in an assertion message.
        // The settings reference the NAME; this supplies the value for the authenticated client.
        [MOCK_API_KEY_ENV]: 'mock-value-not-a-real-credential',
        ...(options.extraEnv ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    child.on('close', () => { exited = true; });
    child.on('error', () => { exited = true; });

    // `hostBase` is assigned inside the `waitFor` closure above, so its declared type is written on
    // the initializer: control-flow analysis does not see the closure assignment, and without this
    // the check below would compare against a value it believes is still null.
    let hostBase = /** @type {string|null} */ (null);
    await waitFor(() => {
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return false;
      hostBase = `http://127.0.0.1:${match[1]}`;
      return true;
    }, { timeoutMs: 45_000, what: 'the isolated Host to report its listening URL', intervalMs: 100 });

    if (!hostBase) throw new Error('the isolated Host never reported a URL');
    if (hostBase.endsWith(':3080')) {
      // Defensive: this rig must never adopt a Host that someone else is running.
      throw new Error(`refusing to use port 3080 (${hostBase}); the suite must own its Host`);
    }

    // Wait until the control plane actually answers, so tests do not race the boot.
    await waitFor(async () => {
      try {
        const response = await fetch(`${hostBase}/api/host.describe`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'rig-probe', method: 'host.describe', payload: {} }),
        });
        return response.ok;
      } catch { return false; }
    }, { timeoutMs: 30_000, what: 'the isolated Host control plane to answer' });
    return hostBase;
  };

  const stop = async () => {
    if (!child || exited) return;
    const stopping = child;
    stopping.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => stopping.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (!exited) stopping.kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => stopping.once('close', resolve)),
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
  };

  const hostBase = await launch();

  return {
    hostBase,
    home,
    scratch,
    mock,
    dshBin,
    get pid() { return child?.pid; },
    // The settings file this Host booted from, and the confinement mode read back out of it. A test
    // can therefore assert the posture it ran under instead of trusting the rig's intent.
    settingsPath,
    sandboxMode: readSandboxMode(settingsPath),
    output: () => output,
    isAlive: () => !exited,
    /**
     * Stop and re-boot the Host on a NEW ephemeral port, keeping the same home root. Used to prove
     * that a caller can reattach to durable state after the Host itself restarted. It resolves with
     * the new base URL, because that is what `launch` returns and what a reattaching caller needs.
     */
    restart: async () => { await stop(); return launch(); },
    stop,
    cleanup: () => { try { scratch.cleanup(); } catch { /* best effort */ } },
  };
}

/** Re-exported so a suite does not need to import the fixture directly for the common ids. */
export { MOCK_API_KEY_ENV, MOCK_MODEL_ID, MOCK_PROVIDER_ID };
