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
 * @returns {Promise<{child: object, stateDir: string, socketPath: string, ready: object, stop: () => Promise<void>}>}
 */
export async function startDaemon({ hostBase, stateDir, extraEnv = {}, readyFile = null }) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  // A leftover ready file from a previous daemon would make this call return instantly with
  // stale coordinates (a dead socket path). Remove it so "ready" always means THIS process.
  const readyPath = readyFile ?? join(stateDir, 'daemon.ready.json');
  try { rmSync(readyPath, { force: true }); } catch { /* nothing to remove */ }
  const child = spawnNode([
    'bin/dsh-pilot-daemon.mjs',
    '--state-dir', stateDir,
    '--host', hostBase,
    '--ready-file', readyPath,
  ], { env: extraEnv });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let exited = null;
  child.on('close', (code, signal) => { exited = { code, signal }; });

  let ready;
  try {
    ready = await waitForReady(readyPath, () => exited, () => stderr, 20000);
  } catch (error) {
    child.kill('SIGKILL');
    throw new Error(`daemon failed to start: ${error.message}\nstdout: ${stdout}\nstderr: ${stderr}`);
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
 * @param {string} socketPath
 */
export async function ipcClient(socketPath) {
  const { IpcClient } = await import('../lib/ipc.js');
  const client = new IpcClient({ socketPath });
  await client.ready();
  return client;
}
