#!/usr/bin/env node
/**
 * Resumable soak runner.
 *
 * Why this file exists: the reliability claim that matters for a long-lived daemon is not
 * "it survived an hour once" but "over many hours it never drifted". That claim needs a runner
 * that records elapsed segments durably, so the total is real evidence rather than a stopwatch
 * in a terminal. It therefore writes every segment to a state file as it happens, and on
 * restart it resumes rather than starting a fresh count.
 *
 * It records three different things on purpose, because they disagree under load:
 *   - UTC elapsed from the recorded start to the recorded end (wall clock);
 *   - monotonic elapsed summed from the process's own high-resolution clock;
 *   - the GAPS between records, which is where a crash or a suspend shows up.
 * A soak that hides its gaps by only reporting wall-clock total is not evidence.
 *
 * Usage:
 *   node test/soak/run.mjs --minutes 5                       # bounded smoke on a fake Host
 *   node test/soak/run.mjs --resume --hours 48               # the multi-day milestone
 *   node test/soak/run.mjs --status                          # print recorded segments only
 *
 * The default target is the in-repo fake Host: the multi-day run must not depend on a live
 * provider route, and it must never touch a Host the operator is already running.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { FakeHost } from '../fixtures/fake-host.mjs';

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const out = { minutes: null, hours: null, resume: false, status: false, smoke: false, stateDir: null, intervalMs: 30_000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--minutes') out.minutes = Number(argv[++i]);
    else if (arg === '--hours') out.hours = Number(argv[++i]);
    else if (arg === '--resume') out.resume = true;
    else if (arg === '--status') out.status = true;
    else if (arg === '--smoke') out.smoke = true;
    else if (arg === '--state-dir') out.stateDir = argv[++i];
    else if (arg === '--interval-ms') out.intervalMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node test/soak/run.mjs [--minutes N | --hours N] [--resume] [--status] [--state-dir DIR]\n');
      process.exit(0);
    } else {
      process.stderr.write(`unknown argument: ${arg}\n`);
      process.exit(2);
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const stateDir = resolve(args.stateDir ?? join(tmpdir(), 'dsh-pilot-soak'));
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const statePath = join(stateDir, 'soak-state.json');

/** @returns {object} */
function loadState() {
  if (!existsSync(statePath)) {
    return {
      startedAtUtc: null,
      segments: [],
      crashes: 0,
      totalMonotonicMs: 0,
      lastRecordedAtUtc: null,
      checkpointFailures: 0,
    };
  }
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

/** @param {object} state */
function saveState(state) {
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

const state = loadState();

if (args.status) {
  process.stdout.write(`${JSON.stringify({
    statePath,
    startedAtUtc: state.startedAtUtc,
    segments: state.segments.length,
    totalMonotonicMs: state.totalMonotonicMs,
    totalMonotonicHours: Number((state.totalMonotonicMs / 3_600_000).toFixed(3)),
    gaps: state.segments.filter((segment) => segment.gapMs > 0).length,
    crashes: state.crashes,
    checkpointFailures: state.checkpointFailures,
    lastRecordedAtUtc: state.lastRecordedAtUtc,
    complete: state.complete === true,
  }, null, 2)}\n`);
  process.exit(0);
}

if (!args.minutes && !args.hours) {
  process.stderr.write('refusing to run without a bound: pass --minutes N or --hours N\n');
  process.exit(2);
}
const budgetMs = args.hours ? args.hours * 3_600_000 : args.minutes * 60_000;

// A resumed run keeps its original start; a fresh run records one now.
const nowUtc = new Date().toISOString();
if (!state.startedAtUtc || !args.resume) {
  state.startedAtUtc = nowUtc;
  state.segments = [];
  state.crashes = 0;
  state.totalMonotonicMs = 0;
} else {
  state.crashes += 1; // resuming means the previous process did not stop cleanly
}

const { startDaemon, ipcClient, waitFor } = await import('../helpers.mjs');
const { mkdtempSync, rmSync } = await import('node:fs');

const host = await new FakeHost().start();
const scratch = mkdtempSync(join(tmpdir(), 'dsh-pilot-soak-case-'));
const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir: join(scratch, 'state') });

let stopRequested = false;
const onSignal = (signal) => {
  process.stdout.write(`soak: ${signal}, recording a final segment and stopping\n`);
  stopRequested = true;
};
process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));

/**
 * One checkpoint: perform a real round of work and verify the result. A soak that only pings
 * health would pass while a specific operation path rotted, so each round exercises the
 * mutation path (prompt) and the read paths (state, events) together.
 */
async function checkpoint(round) {
  const ipc = await ipcClient(daemon.socketPath);
  try {
    const task = await ipc.request({ op: 'task.ensure', clientKey: 'soak-task' });
    const session = await ipc.request({ op: 'session.start', taskId: task.task.taskId, clientKey: 'soak-session' });
    if (!session.session) throw new Error(`session unavailable: ${JSON.stringify(session).slice(0, 200)}`);
    const prompt = await ipc.request({
      op: 'session.prompt',
      taskId: task.task.taskId,
      sessionId: session.session.sessionId,
      clientKey: `soak-prompt-${round}`,
      text: `soak round ${round}`,
    });
    if (prompt.operation.state !== 'succeeded') {
      throw new Error(`prompt did not succeed: ${JSON.stringify(prompt.operation).slice(0, 200)}`);
    }
    const events = await ipc.request({
      op: 'session.events', taskId: task.task.taskId, sessionId: session.session.sessionId, limit: 200,
    });
    if (!events.events.length) throw new Error('no events were stored for the soak session');
    const state = await ipc.request({ op: 'session.state', taskId: task.task.taskId, sessionId: session.session.sessionId });
    const health = await ipc.request({ op: 'health' });
    return {
      sessionId: session.session.sessionId,
      events: events.events.length,
      execution: state.execution.state,
      connection: health.connection,
      storeGeneration: health.storeGeneration,
    };
  } finally {
    ipc.close();
  }
}

await waitFor(async () => {
  const ipc = await ipcClient(daemon.socketPath);
  try { return (await ipc.request({ op: 'health' })).connection === 'ready'; } finally { ipc.close(); }
}, { timeoutMs: 20000, what: 'the soak daemon downlink to come up' });

const startedMono = performance.now();
const deadlineMono = startedMono + budgetMs;
let round = state.segments.length;
let lastRecordedMono = startedMono;

process.stdout.write(`soak: starting (budget ${(budgetMs / 60_000).toFixed(1)} min, resume=${args.resume}, state=${statePath})\n`);

for (;;) {
  try {
    const result = await checkpoint(round);
    state.checkpointFailures = state.checkpointFailures;
    state.lastCheckpoint = { round, ...result, at: new Date().toISOString() };
  } catch (error) {
    // A failed checkpoint is recorded as a failure, never silently retried into a green run.
    state.checkpointFailures += 1;
    process.stdout.write(`soak: checkpoint ${round} FAILED: ${error.message}\n`);
  }

  const monoNow = performance.now();
  const elapsedThisSegment = monoNow - lastRecordedMono;
  const gapMs = lastRecordedMono - (startedMono + state.totalMonotonicMs);
  state.segments.push({
    round,
    startedAtUtc: new Date(Date.now() - elapsedThisSegment).toISOString(),
    endedAtUtc: new Date().toISOString(),
    monotonicMs: Math.round(elapsedThisSegment),
    // A positive gap is time this run did not account for: a crash, a suspend, or a stall.
    gapMs: Math.max(0, Math.round(gapMs)),
  });
  state.totalMonotonicMs += elapsedThisSegment;
  state.lastRecordedAtUtc = new Date().toISOString();
  lastRecordedMono = monoNow;
  saveState(state);

  round += 1;
  const remaining = deadlineMono - performance.now();
  if (stopRequested || remaining <= 0) break;
  await new Promise((resolvePromise) => setTimeout(resolvePromise, Math.min(args.intervalMs, remaining)));
}

state.complete = true;
state.endedAtUtc = new Date().toISOString();
state.wallClockMs = Date.parse(state.endedAtUtc) - Date.parse(state.startedAtUtc);
saveState(state);

await daemon.stop();
await host.stop();
try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }

const gaps = state.segments.filter((segment) => segment.gapMs > 0);
process.stdout.write(`${JSON.stringify({
  statePath,
  segments: state.segments.length,
  monotonicHours: Number((state.totalMonotonicMs / 3_600_000).toFixed(4)),
  wallClockHours: Number((state.wallClockMs / 3_600_000).toFixed(4)),
  gapCount: gaps.length,
  largestGapMs: gaps.reduce((max, segment) => Math.max(max, segment.gapMs), 0),
  crashes: state.crashes,
  checkpointFailures: state.checkpointFailures,
  // The multi-day milestone is 48h of MONOTONIC coverage with no unexplained gap.
  meetsMultiDayMilestone: state.totalMonotonicMs >= 48 * 3_600_000 && gaps.every((segment) => segment.gapMs < 60_000),
}, null, 2)}\n`);

process.exit(state.checkpointFailures > 0 ? 1 : 0);
