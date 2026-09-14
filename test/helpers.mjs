/**
 * Shared test helpers.
 *
 * Why this file exists: every suite needs the same three things — an isolated state directory
 * that is never a real one, a way to start and reap child processes without leaking them, and
 * an assertion style whose failures print enough to diagnose without a debugger. Keeping them
 * here is what stops each suite from inventing its own (and drifting from the filesystem
 * boundaries the contract requires).
 */

import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';

export { assert };

export const ROOT = resolve(new URL('..', import.meta.url).pathname);

/** Throw the harness's SKIP marker so a layer can report a skip honestly. */
export function skip(reason) {
  throw new Error(`SKIP: ${reason}`);
}

/**
 * Assert a value the daemon/store contract guarantees, failing loudly instead of silently.
 *
 * Why this helper exists: the store's row reads are honestly typed `TaskRow | null` — "the lookup
 * found nothing" is a real outcome the implementation is allowed to report — and the test layer
 * sees that type through the emitted declaration files under `dist/`, which is the point of the
 * migration. Most read sites in a suite are NOT exercising the absent case: the test created the
 * row a line earlier and then
 * reads its id. At those sites the value must be there, so the test states that as an assertion.
 * The alternative — `!` or `as` at the site — would delete exactly the check the migration bought,
 * and would let a genuinely absent row flow on until it surfaced as `TypeError: cannot read
 * properties of null` several lines away from the cause.
 *
 * Deliberately NOT for reads where the test ASSERTS absence: `assert.equal(reply.session, null)`
 * is the oracle for the absent case and must stay a plain comparison.
 * @template T
 * @param {T|null|undefined} value
 * @param {string} what
 * @returns {T}
 */
export function must(value, what) {
  if (value === null || value === undefined) throw new Error(`expected ${what} to exist, got ${String(value)}`);
  return value;
}

/**
 * Assert a value is a string, and narrow it to `string`.
 *
 * Why this helper exists: `sanitizeDetails` returns `Record<string, unknown>`, correctly — the
 * details of a host error are whatever arrived on the wire. A test that then calls `.length` or
 * `assert.match` on one field is making a claim about the sanitiser ("this field is a string
 * here"). An assertion fails by name and by type; a cast would quietly accept a number or an
 * object and let the claim go untested.
 * @param {unknown} value
 * @param {string} what
 * @returns {string}
 */
export function mustString(value, what) {
  if (typeof value !== 'string') throw new Error(`expected ${what} to be a string, got ${typeof value}`);
  return value;
}

/**
 * Narrow an untyped JSON payload to a record so its fields can be read.
 *
 * Why this helper exists: a frame that was parsed from JSON — an IPC request frame arriving at a
 * test's own server, a reply decoded from the wire — is honestly `unknown`, because nothing has
 * yet decided what it contains. The test IS the thing that decides. This is the single stated
 * narrowing step at that boundary: the caller asserts "this is an object" once, as a real runtime
 * check, and then reads fields from it, instead of scattering `as` casts or `any` annotations over
 * each property. The check is what makes it honest — a non-object fails here, by name, rather than
 * becoming `undefined` reads later — so the helper needs no cast of its own.
 *
 * It is not a licence to skip narrowing where a declaration exists: values that reach the suites
 * through the typed surface (`AdapterCallResult.value`, store rows, `Result` fields) are narrowed
 * with `must`/`mustString`, which check the thing the test actually claims about them.
 * @param {unknown} value
 * @param {string} what
 * @returns {Record<string, any>}
 */
export function asRecord(value, what) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`expected ${what} to be a JSON object, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`);
  }
  return value;
}

/**
 * Create a scratch directory under the OS temp root. Never inside a real state directory.
 * @param {string} label
 * @returns {{dir: string, cleanup: () => void}}
 */
export function scratchDir(label = 'case') {
  const dir = mkdtempSync(join(tmpdir(), `dshpilot-${label}-`));
  return {
    dir,
    cleanup: () => {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    },
  };
}

/** Registered for cleanup at process exit so a failing test cannot leak children. */
const children = new Set();
process.on('exit', () => {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
});

/**
 * Spawn a node process and track it for reaping.
 * @param {string[]} args
 * @param {object} [options]
 * @returns {import('node:child_process').ChildProcess}
 */
export function spawnNode(args, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...(options.env ?? {}) },
    // stdin is piped by default: any suite that drives a child over stdio (the MCP layer)
    // needs a writable pipe, and 'ignore' would hand it a null stream instead.
    stdio: options.stdio ?? ['pipe', 'pipe', 'pipe'],
  });
  children.add(child);
  child.on('exit', () => children.delete(child));
  return child;
}

/**
 * Wait for a predicate with a bounded timeout. Never sleeps as a pass criterion: the caller
 * asserts on an observable condition and a timeout is reported as a timeout.
 * @param {() => boolean | Promise<boolean>} predicate
 * @param {object} [options]
 * @returns {Promise<void>}
 */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 20, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timeout waiting for ${what} after ${timeoutMs}ms`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
}

/**
 * Wait for a child process to exit, resolving with code and captured output.
 * @param {import('node:child_process').ChildProcess} child
 * @returns {Promise<{code: number|null, signal: string|null, stdout: string, stderr: string}>}
 */
export function collect(child) {
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  return new Promise((resolvePromise) => {
    child.on('close', (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

/**
 * Read a newline-delimited JSON stream into a helper that can await the next message.
 * @param {NodeJS.ReadableStream} stream
 */
export function jsonLines(stream) {
  let buffer = '';
  const queue = [];
  const waiters = [];
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!line) continue;
      let parsed;
      try { parsed = JSON.parse(line); } catch { parsed = { parseError: line.slice(0, 200) }; }
      const waiter = waiters.shift();
      if (waiter) waiter(parsed);
      else queue.push(parsed);
    }
  });
  return {
    /** @param {number} [timeoutMs] */
    next(timeoutMs = 15000) {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => rejectPromise(new Error(`timed out after ${timeoutMs}ms waiting for a json line`)), timeoutMs);
        waiters.push((value) => { clearTimeout(timer); resolvePromise(value); });
      });
    },
    /** @param {(msg: object) => boolean} predicate @param {number} [timeoutMs] */
    async nextMatching(predicate, timeoutMs = 15000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out waiting for matching json line after ${timeoutMs}ms`);
        const message = await this.next(remaining);
        if (predicate(message)) return message;
      }
    },
  };
}

/**
 * Start the daemon as a child process against a scratch state directory.
 * @param {object} options
 * @returns {Promise<{child: object, stateDir: string, socketPath: string, ready: object, output: () => {stdout: string, stderr: string}, stop: () => Promise<void>}>}
 */
export async function startDaemon({ hostBase, stateDir, extraEnv = {}, readyFile = null }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // A leftover ready file from a previous daemon would make this call return instantly with
  // stale coordinates (a dead socket path). Remove it so "ready" always means THIS process.
  const readyPath = readyFile ?? join(stateDir, 'daemon.ready.json');
  try { rmSync(readyPath, { force: true }); } catch { /* nothing to remove */ }
  const child = spawnNode([
    'dist/bin/dsh-pilot-daemon.js',
    '--state-dir', stateDir,
    '--host', hostBase,
    '--ready-file', readyPath,
  ], { env: extraEnv });
  let stdout = '';
  let stderr = '';
  // `spawnNode` pipes both streams by default; the optional access mirrors `collect` below and
  // keeps the capture total rather than throwing if a caller ever spawns without pipes.
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  let exited = null;
  child.on('close', (code, signal) => { exited = { code, signal }; });

  let ready;
  try {
    ready = await waitForReady(readyPath, () => exited, () => stderr, 20000);
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`daemon failed to start: ${error instanceof Error ? error.message : String(error)}\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
  return {
    child,
    stateDir,
    socketPath: ready.socketPath,
    ready,
    output: () => ({ stdout, stderr }),
    stop: async () => {
      if (exited) return exited;
      child.kill('SIGTERM');
      const done = collect(child);
      const timeout = new Promise((resolvePromise) => setTimeout(() => resolvePromise({ code: null, signal: 'timeout' }), 5000));
      return Promise.race([done, timeout]);
    },
  };
}

/**
 * @param {string} readyPath
 * @param {() => object|null} exited
 * @param {() => string} stderr
 * @param {number} timeoutMs
 */
async function waitForReady(readyPath, exited, stderr, timeoutMs) {
  const { existsSync, readFileSync } = await import('node:fs');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(readyPath)) {
      const text = readFileSync(readyPath, 'utf8');
      if (text.trim()) return JSON.parse(text);
    }
    if (exited()) throw new Error(`daemon exited early: ${JSON.stringify(exited())} stderr=${stderr()}`);
    if (Date.now() >= deadline) throw new Error(`ready file ${readyPath} not written within ${timeoutMs}ms; stderr=${stderr()}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
}

/**
 * Open an IPC client to a daemon started by startDaemon.
 *
 * The cast on `request` is a deliberate, single-point opt-out, and the reasoning matters more than
 * the line. `IpcClient.request()` is typed `Promise<unknown>` in `src/lib/ipc.ts`, which is correct
 * there: the reply is a JSON frame from another process, so a reader must narrow it rather than the
 * type system asserting a shape the daemon never promised. The tests, however, are the oracle that
 * decides what those frames actually contain, and an oracle that must first be told the answer is
 * not an oracle. So the untyped view is admitted here, once, where the test layer meets the wire,
 * instead of as ~270 unchecked property reads scattered through the suites — and it is admitted as
 * `any` on a fixture boundary rather than by weakening `src/`, which stays fully narrowed.
 * @param {string} socketPath
 */
export async function ipcClient(socketPath) {
  const { IpcClient } = await import('../dist/lib/ipc.js');
  const client = new IpcClient({ socketPath });
  await client.ready();
  return /** @type {Omit<typeof client, 'request'> & { request: (request: unknown) => Promise<any> }} */ (client);
}
