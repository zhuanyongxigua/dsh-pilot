/**
 * Rig for the opt-in LIVE suite: a real DSH Host, a real provider route, a real daemon.
 *
 * Why this file exists: the live suite has to be honest about three different things at once, and
 * each one is easy to get wrong:
 *
 *   1. **It must be a real end-to-end run.** The Host is a genuine DSH Host booted by this test, the
 *      model route is the operator's real default route, and turns end because DSH really ran its
 *      agent loop. Nothing here fabricates a turn or fakes a provider reply.
 *   2. **It must stay bounded.** The suite takes a wall-clock budget, a concurrency ceiling and a
 *      memory-round floor from the design, and this rig REFUSES to exceed them rather than
 *      discovering the overrun at the end. A run that would exceed the budget is not launched.
 *   3. **It must not touch the operator's state or leak a credential.** Its own `DSH_HOME` under the
 *      OS temp root, its own ephemeral port, never 3080, and the credential exists only as an
 *      environment-variable NAME whose value goes straight into the child's environment.
 *
 * A separate file from `test/isolated-host/rig.mjs` on purpose: that rig points a Host exclusively at
 * a loopback mock, and AGENTS.md section 7 forbids conflating a fake-provider fixture with a real
 * one. Sharing the file would make the two easy to confuse.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { ipcClient, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { resolveDshBin } from '../isolated-host/rig.mjs';
import { resolveLiveRoute } from './live-route.mjs';
import { OPERATOR_SANDBOX_MODE } from '../fixtures/mock-provider.mjs';

/**
 * Budgets fixed by the design. They are constants, not arguments, so a test cannot quietly widen
 * them to make a run fit.
 */
export const LIVE_BUDGET = Object.freeze({
  /** Total wall-clock ceiling for the whole live layer, in milliseconds. */
  totalMs: 20 * 60 * 1000,
  /** Ceiling on concurrently live sessions. The design says 8, so a test may not ask for 9. */
  maxConcurrentSessions: 8,
  /** Minimum number of real memory-isolation rounds. */
  minIsolationRounds: 3,
  /** Parallel-session widths the design names, as a pattern of one-per-round rather than all at once. */
  parallelSteps: [2, 4, 8],
});

/**
 * A shared wall-clock budget for the whole live layer.
 *
 * The runner imports every suite from one module instance, so one budget object is shared across the
 * suites and each step must ask it for permission before starting work. That is what makes "total
 * under 20 minutes" a property of the run instead of a hope.
 */
export class LiveBudget {
  /** @param {{totalMs?: number}} [options] */
  constructor(options = {}) {
    this.totalMs = options.totalMs ?? LIVE_BUDGET.totalMs;
    this.startedAt = Date.now();
    /** @type {{name: string, ms: number}[]} */
    this.steps = [];
    /** @type {string[]} */
    this.skips = [];
  }

  get elapsedMs() { return Date.now() - this.startedAt; }

  /** @returns {number} milliseconds still available */
  get remainingMs() { return this.totalMs - this.elapsedMs; }

  /**
   * Claim a slice of the budget or refuse. Returning a refusal instead of throwing keeps the caller
   * in charge of whether that is a skip or a failure.
   * @param {string} name
   * @param {number} neededMs
   * @returns {{ok: true} | {ok: false, reason: string}}
   */
  claim(name, neededMs) {
    if (neededMs > this.remainingMs) {
      return {
        ok: false,
        reason: `budget: "${name}" needs ~${Math.round(neededMs / 1000)}s but only ${Math.round(this.remainingMs / 1000)}s of the ${Math.round(this.totalMs / 60000)}-minute ceiling remains`,
      };
    }
    return { ok: true };
  }

  /** Record a completed step. @param {string} name */
  record(name) { this.steps.push({ name, ms: Date.now() - this.startedAt }); }

  /** @param {string} name @param {() => Promise<any>} fn @param {number} neededMs */
  async run(name, fn, neededMs) {
    const claim = this.claim(name, neededMs);
    if (!claim.ok) throw new Error(`SKIP: ${claim.reason}`);
    const value = await fn();
    this.record(name);
    return value;
  }
}

/** One budget instance for the whole live layer. */
export const sharedBudget = new LiveBudget();

/**
 * Resolve the live environment, or explain why the layer cannot run.
 *
 * A missing route or credential is reported as a SKIP with the precise cause: it is an absent
 * external capability, not a defect in this project, and AGENTS.md section 7 forbids reporting a
 * skip as either a pass or a failure.
 * @returns {{ok: true, route: object, dshBin: string} | {ok: false, reason: string}}
 */
export function liveEnvironment() {
  const dshBin = resolveDshBin();
  if (!dshBin) return { ok: false, reason: 'no installed @deepseek-ai/dsh found' };
  const route = resolveLiveRoute();
  if (!route.ok) return { ok: false, reason: `live route unavailable: ${route.reason}` };
  return { ok: true, route, dshBin };
}

/**
 * Boot a real DSH Host against the operator's real default route, in a single-use home.
 *
 * The confinement policy is NOT a parameter here either, for the same reason it was removed from the
 * isolated-host rig: a `permission` option that could widen the mode to `danger-full-access` is a way
 * for a test to loosen a boundary after the strict policy refuses something, which the review
 * rejected. The operator's own route settings are used verbatim, and the mode is pinned to the
 * operator posture so it cannot drift with the operator's ambient configuration either.
 *
 * @param {{label?: string, route: object, dshBin: string}} options
 */
export async function startLiveHost({ label, route, dshBin }) {
  const scratch = scratchDir(label ?? 'live-host');
  const home = join(scratch.dir, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  // Unconditional: the operator's route settings plus the operator posture, always. There is no
  // branch a caller can reach that produces a wider mode, which is the property being protected.
  const settings = `${route.settings}\nsandbox-policy:\n  mode: ${OPERATOR_SANDBOX_MODE}\npermission:\n  defaultPreset: ${OPERATOR_SANDBOX_MODE}\n`;
  // Written before boot so the Host reads it at startup and cannot fall back to an ambient route.
  writeFileSync(join(home, 'settings.yaml'), settings);

  /** @type {import('node:child_process').ChildProcess|null} */
  let child = null;
  let output = '';
  let exited = false;

  const launch = async () => {
    output = '';
    exited = false;
    child = spawn(process.execPath, [dshBin, 'web', '--port', '0', '--host', '127.0.0.1', '--no-open'], {
      cwd: home,
      env: {
        ...process.env,
        DSH_HOME: home,
        NO_COLOR: '1',
        // The credential is already in process.env under its own name, resolved from the operator's
        // environment by NAME only. Nothing here reads, prints or stores the value.
        ...(route.credentialEnvName && process.env[route.credentialEnvName]
          ? { [route.credentialEnvName]: process.env[route.credentialEnvName] }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => { output += chunk; });
    child.stderr?.on('data', (chunk) => { output += chunk; });
    child.on('close', () => { exited = true; });
    child.on('error', () => { exited = true; });

    // Assigned inside the `waitFor` closure above, so the declared type goes on the initializer:
    // control-flow analysis cannot see that assignment, and without this the check below would
    // compare against a value it believes is still null.
    let hostBase = /** @type {string|null} */ (null);
    await waitFor(() => {
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (!match) return false;
      hostBase = `http://127.0.0.1:${match[1]}`;
      return true;
    }, { timeoutMs: 60_000, what: 'the live Host to report its listening URL', intervalMs: 100 });

    if (!hostBase) throw new Error('the live Host never reported a URL');
    if (hostBase.endsWith(':3080')) throw new Error(`refusing to use port 3080 (${hostBase})`);

    await waitFor(async () => {
      try {
        const response = await fetch(`${hostBase}/api/host.describe`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId: 'live-probe', method: 'host.describe', payload: {} }),
        });
        return response.ok;
      } catch { return false; }
    }, { timeoutMs: 30_000, what: 'the live Host control plane to answer' });
    return hostBase;
  };

  const stop = async () => {
    if (!child || exited) return;
    const stopping = child;
    stopping.kill('SIGTERM');
    await Promise.race([
      new Promise((resolvePromise) => stopping.once('close', resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 5000)),
    ]);
    if (!exited) stopping.kill('SIGKILL');
    await Promise.race([
      new Promise((resolvePromise) => stopping.once('close', resolvePromise)),
      new Promise((resolvePromise) => setTimeout(resolvePromise, 2000)),
    ]);
  };

  const hostBase = await launch();

  return {
    hostBase,
    home,
    scratch,
    dshBin,
    get pid() { return child?.pid; },
    output: () => output,
    isAlive: () => !exited,
    stop,
    cleanup: () => { try { scratch.cleanup(); } catch { /* best effort */ } },
  };
}

/**
 * Start a daemon against a live Host plus an IPC client, and hand back a small session API so the
 * suites read as "open sessions, prompt them, wait" rather than as repeated IPC plumbing.
 *
 * @param {{hostBase: string, stateDir: string, label?: string}} options
 */
export async function startLiveDaemon({ hostBase, stateDir, label = 'live' }) {
  const daemon = await startDaemon({ hostBase, stateDir });
  const ipc = await ipcClient(daemon.socketPath);
  await waitFor(async () => (await ipc.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 30_000, what: 'the bridge to reach the live Host', intervalMs: 100 });

  let counter = 0;
  const key = (prefix) => `${label}-${prefix}-${++counter}`;
  let task = null;

  return {
    daemon,
    ipc,
    key,
    /**
     * Ensure the single task this rig uses.
     * @param {string} [cwd]
     */
    async task(cwd) {
      if (!task) {
        const created = await ipc.request({ op: 'task.ensure', clientKey: key('task'), ...(cwd ? { cwd } : {}) });
        task = created.task;
      }
      return task;
    },
    /**
     * Open one real session on the live Host.
     * @param {{cwd: string}} options
     */
    async session({ cwd }) {
      const ensured = await this.task(cwd);
      const started = await ipc.request({ op: 'session.start', taskId: ensured.taskId, clientKey: key('start'), cwd });
      return started.session;
    },
    /** @param {{taskId: string, sessionId: string, text: string}} options */
    async prompt({ taskId, sessionId, text }) {
      return ipc.request({ op: 'session.prompt', taskId, sessionId, clientKey: key('prompt'), text });
    },
    /** @param {{taskId: string, sessionId: string, timeoutMs?: number}} options */
    async wait({ taskId, sessionId, timeoutMs = 180_000 }) {
      return ipc.request({ op: 'session.wait', taskId, sessionId, clientKey: key('wait'), timeoutMs });
    },
    /** @param {{taskId: string, sessionId: string, limit?: number}} options */
    async events({ taskId, sessionId, limit = 400 }) {
      const page = await ipc.request({ op: 'session.events', taskId, sessionId, clientKey: key('events'), limit });
      return page.events;
    },
    async stop() {
      try { ipc.close(); } catch { /* already closed */ }
      await daemon.stop();
    },
  };
}
