#!/usr/bin/env node
/**
 * Mutation / negative-control runner.
 *
 * Why this file exists: a green test suite proves nothing on its own — it may simply be unable
 * to fail. This script introduces ONE known defect at a time into a throwaway copy of the
 * source and requires the tests that claim to protect that behaviour to go RED. A mutation that
 * survives means the corresponding test is decorative, and that is reported as a failure of
 * this runner.
 *
 * Rules it follows:
 *   - it never mutates the working tree; every mutation is applied to a copy under the OS temp
 *     root, so a crashed run cannot leave the real source modified;
 *   - each mutation declares the test target and the file it edits, and the edit is verified to
 *     have applied (a pattern that no longer matches is an error, not a silent no-op);
 *   - the report states, per mutation, which control caught it.
 *
 * Usage: node test/mutation/run.mjs [--only NAME] [--json FILE]
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(new URL('../..', import.meta.url).pathname);

/**
 * Each mutation pairs a deliberate defect with the negative control that must notice it.
 * @type {{name: string, why: string, file: string, find: string, replace: string, target: string, expectFailure: string}[]}
 */
const MUTATIONS = [
  {
    name: 'durable-intent-after-send',
    why: 'Persisting the intent AFTER the network write would make a crash mid-send invisible, so "sent, outcome unknown" would silently disappear.',
    file: 'lib/daemon.js',
    find: `    if (fresh.state === 'pending') {
      this.#store.markDispatching({
        operationId: fresh.operation_id,
        method,
        endpoint: \`/api/\${method}\`,
        payload,
      });
    }`,
    replace: `    // MUTATION: the dispatch intent is never committed before the send.
    void fresh;`,
    target: 'test/persistence',
    expectFailure: 'crash',
  },
  {
    name: 'ack-loss-reported-as-success',
    why: 'Treating a lost acknowledgement as success converts "we do not know" into a false confirmation.',
    file: 'lib/daemon.js',
    find: `      this.#store.markUncertain({
        operationId: fresh.operation_id,
        reason: result.reason ?? 'unproven-outcome',
        evidence: { method, at: Date.now() },
      });`,
    keepTail: true,
    replace: `      // MUTATION: an unprovable outcome is recorded as a success.
      this.#store.markAcknowledged({ operationId: fresh.operation_id, ok: true, value: { assumed: true } });`,
    target: 'test/fake-host',
    expectFailure: 'uncertain',
  },
  {
    name: 'duplicate-rows-written',
    why: 'Losing the store-side sequence check lets a redelivered frame become a second row whenever the caller has not already cached that sequence, which corrupts every count and page derived from the log.',
    file: 'lib/store.js',
    find: `      const before = this.get(
        'select 1 as present from events where task_id = ? and session_id = ? and seq = ?',
        taskId, sessionId, seq,
      );
      if (before) return false;`,
    replace: `      // MUTATION: no sequence check, so only the primary key stands between us and a
      // duplicate row — and a row id collision is silently absorbed by the ignore clause.
      const before = null;
      if (before) return false;`,
    target: 'test/unit',
    expectFailure: 'store dedupe',
  },
  {
    name: 'stale-terminal-event-closes-turn',
    why: 'Closing a turn on any terminal event reports live work as finished, which is the exact failure the "authoritative turn/end" rule exists to prevent.',
    file: 'lib/daemon.js',
    find: `      if (Number.isFinite(endTurn)) {
        if (!Number.isFinite(openHostTurn) || endTurn !== openHostTurn) return;`,
    replace: `      if (false) { // MUTATION: accept any terminal event
        if (!Number.isFinite(openHostTurn) || endTurn !== openHostTurn) return;`,
    target: 'test/fake-host',
    expectFailure: 'stale or foreign',
  },
  {
    name: 'approval-authority-not-checked',
    why: 'Accepting a decision without the operator token would let any local caller — including a model-driven one — authorize its own approvals.',
    file: 'lib/daemon.js',
    find: `    if (typeof authorityToken !== 'string' || createDigest(authorityToken) !== createDigest(expected)) {`,
    replace: `    if (false) { // MUTATION: authority token is not verified`,
    target: 'test/security',
    expectFailure: 'unauthenticated',
  },
  {
    name: 'gap-smoothed-over',
    why: 'Reporting a stream with a hole as complete destroys the caller’s ability to tell a full log from a partial one.',
    file: 'lib/daemon.js',
    find: `      completeness: hasGap ? 'incomplete' : 'complete',`,
    replace: `      completeness: 'complete', // MUTATION: gaps always reported as complete`,
    target: 'test/property',
    expectFailure: 'property',
  },
  {
    name: 'session-create-id-not-reused',
    why: 'A Host that discards the caller preallocated session id makes a retry ask for a SECOND Host session, so one logical session silently becomes two.',
    file: 'test/fixtures/fake-host.mjs',
    find: `  createSession(sessionId) {
    const id = sessionId ?? \`session-\${randomUUID()}\`;`,
    replace: `  createSession(sessionId) {
    // MUTATION: the caller preallocated id is ignored, so a retry always creates a new session.
    sessionId = undefined;
    const id = sessionId ?? \`session-\${randomUUID()}\`;`,
    target: 'test/fake-host',
    expectFailure: 'idempotently',
  },
  {
    name: 'mcp-unknown-arguments-accepted',
    why: 'Accepting unknown tool arguments turns a caller typo into a silently different operation.',
    file: 'lib/mcp-tools.js',
    find: `        if (schema.additionalProperties === false) errors.push(\`\${where}.\${key}: unexpected property\`);`,
    replace: `        void 0; // MUTATION: unknown properties ignored`,
    target: 'test/mcp-e2e',
    expectFailure: 'invalid arguments',
  },
];

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  let only = null;
  let jsonPath = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--only') only = argv[++i];
    else if (argv[i] === '--json') jsonPath = argv[++i];
  }
  return { only, jsonPath };
}

const { only, jsonPath } = parseArgs(process.argv.slice(2));
const selected = only ? MUTATIONS.filter((m) => m.name === only) : MUTATIONS;
if (!selected.length) {
  process.stderr.write(`no mutation matches ${only}\n`);
  process.exit(2);
}

/** Copy the source tree without VCS metadata into a scratch root. */
function makeSandbox() {
  const sandbox = mkdtempSync(join(tmpdir(), 'dshpilot-mutation-'));
  for (const entry of ['bin', 'lib', 'test', 'docs', 'package.json', 'README.md', 'LICENSE']) {
    const from = join(ROOT, entry);
    if (!existsSync(from)) continue;
    cpSync(from, join(sandbox, entry), { recursive: true });
  }
  return sandbox;
}

/** @type {{name: string, caught: boolean, failed: number, passed: number, timedOut: number, skipped: number, detail: string}[]} */
const results = [];

for (const mutation of selected) {
  const sandbox = makeSandbox();
  try {
    const path = join(sandbox, mutation.file);
    const original = readFileSync(path, 'utf8');
    if (!original.includes(mutation.find)) {
      results.push({
        name: mutation.name, caught: false, failed: 0, passed: 0, timedOut: 0, skipped: 0,
        detail: `mutation did not apply: the expected anchor is gone from ${mutation.file} (the code changed; update the mutation)`,
      });
      continue;
    }
    writeFileSync(path, original.replace(mutation.find, mutation.replace));

    const run = spawnSync(process.execPath, ['test/run.mjs', mutation.target], {
      cwd: sandbox,
      encoding: 'utf8',
      timeout: 600_000,
      env: { ...process.env, DSH_PILOT_PROPERTY_ROUNDS: '4' },
    });
    const stdout = `${run.stdout ?? ''}`;
    const summary = stdout.match(/passed=(\d+) failed=(\d+) skipped=(\d+) timedOut=(\d+)/);
    const counts = summary
      ? { passed: Number(summary[1]), failed: Number(summary[2]), skipped: Number(summary[3]), timedOut: Number(summary[4]) }
      : { passed: 0, failed: 0, skipped: 0, timedOut: 0 };
    const caughtWith = stdout.split('\n').filter((line) => /^(FAIL|TIME) /.test(line)).map((line) => line.trim()).slice(0, 3);
    const detections = counts.failed + counts.timedOut;
    results.push({
      name: mutation.name,
      caught: detections > 0,
      ...counts,
      detail: detections > 0
        ? `caught by ${detections} test(s): ${caughtWith.join(' | ')}`
        : `SURVIVED: ${mutation.target} stayed green with the mutation applied (${counts.passed} passed) — the control for this behaviour is not real`,
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

process.stdout.write('\nmutation / negative controls\n');
for (const result of results) {
  process.stdout.write(`${result.caught ? 'caught  ' : 'SURVIVED'} ${result.name}\n`);
  process.stdout.write(`    ${result.detail}\n`);
}
const survived = results.filter((result) => !result.caught).length;
process.stdout.write(`\nmutations=${results.length} caught=${results.length - survived} survived=${survived}\n`);

if (jsonPath) {
  writeFileSync(jsonPath, `${JSON.stringify({
    at: new Date().toISOString(),
    root: ROOT,
    results,
    mutations: results.length,
    caught: results.length - survived,
    survived,
  }, null, 2)}\n`);
  process.stdout.write(`machine-readable report: ${jsonPath}\n`);
}

process.exit(survived > 0 ? 1 : 0);
