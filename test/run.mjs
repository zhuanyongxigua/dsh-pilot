/**
 * Test harness.
 *
 * Why this file exists: the contract requires failed, skipped and timed-out counts to be
 * reported DISTINCTLY, with machine-readable per-layer results and a loud statement when a
 * layer did not run. A generic runner would collapse those into one number, so the harness is
 * deliberately small and explicit.
 *
 * Usage:
 *   node test/run.mjs                        # default layers (deterministic, no network, no secrets)
 *   node test/run.mjs test/unit              # one directory
 *   node test/run.mjs test/live --live       # opt-in live layer
 *   DSH_PILOT_JSON=out.json node test/run.mjs
 */

import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_LAYERS = [
  'test/unit',
  'test/property',
  'test/fake-host',
  'test/persistence',
  'test/mcp-e2e',
  'test/isolated-host',
  'test/security',
];

const SKIP_MARKER = 'SKIP:';

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const targets = [];
  let live = false;
  let isolated = false;
  let filter = null;
  for (const arg of argv) {
    if (arg === '--live') live = true;
    else if (arg === '--isolated') isolated = true;
    else if (arg.startsWith('--filter=')) filter = arg.slice('--filter='.length);
    else targets.push(arg);
  }
  return { targets, live, isolated, filter };
}

const args = parseArgs(process.argv.slice(2));
const layers = args.targets.length ? args.targets : DEFAULT_LAYERS;

/** @type {{id: string, layer: string, status: string, ms: number, detail?: string}[]} */
const results = [];
const startedAt = new Date();
/** @type {string[]} */
const layerNotes = [];

for (const layer of layers) {
  const dir = resolve(layer);
  let files;
  try {
    files = readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).sort();
  } catch {
    layerNotes.push(`${layer}: NOT PRESENT (layer not implemented yet)`);
    continue;
  }
  for (const file of files) {
    const full = join(dir, file);
    const id = `${layer.replace(/^test\//, '')}/${file.replace(/\.test\.mjs$/, '')}`;
    if (args.filter && !id.includes(args.filter)) continue;
    const code = await import(pathToFileURL(full).href);
    const suites = code.default ?? {};
    if (typeof suites !== 'object') {
      results.push({ id, layer, status: 'failed', ms: 0, detail: 'test file must default-export an object of suites' });
      continue;
    }
    const context = {
      live: args.live,
      isolated: args.isolated,
      layer,
      file,
      root: resolve('.'),
    };
    for (const [suiteName, run] of Object.entries(suites)) {
      const caseId = `${id}::${suiteName}`;
      const started = Date.now();
      try {
        const outcome = await run(context);
        const ms = Date.now() - started;
        if (outcome && outcome.skip) {
          results.push({ id: caseId, layer, status: 'skipped', ms, detail: String(outcome.skip) });
        } else {
          results.push({ id: caseId, layer, status: 'passed', ms });
        }
      } catch (error) {
        const ms = Date.now() - started;
        const message = error instanceof Error ? `${error.message}` : String(error);
        if (message.startsWith(SKIP_MARKER)) {
          results.push({ id: caseId, layer, status: 'skipped', ms, detail: message.slice(SKIP_MARKER.length).trim() });
        } else if (error?.name === 'TimeoutError' || /timed out|timeout/i.test(message)) {
          results.push({ id: caseId, layer, status: 'timed-out', ms, detail: message });
        } else {
          results.push({
            id: caseId,
            layer,
            status: 'failed',
            ms,
            detail: message,
            stack: error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : undefined,
          });
        }
      }
    }
  }
}

const counts = {
  passed: results.filter((r) => r.status === 'passed').length,
  failed: results.filter((r) => r.status === 'failed').length,
  skipped: results.filter((r) => r.status === 'skipped').length,
  timedOut: results.filter((r) => r.status === 'timed-out').length,
};

const report = {
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  durationMs: Date.now() - startedAt.getTime(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  liveSelected: args.live,
  isolatedSelected: args.isolated,
  counts,
  layers: summarizeLayers(results),
  layerNotes,
  results,
  liveSuite: args.live ? 'selected' : 'SKIPPED (opt-in; not selected on this run)',
};

process.stdout.write('\n');
for (const result of results) {
  const mark = { passed: 'ok  ', failed: 'FAIL', skipped: 'SKIP', 'timed-out': 'TIME' }[result.status];
  process.stdout.write(`${mark} ${result.id}${result.detail ? `  -- ${result.detail}` : ''}\n`);
  if (result.status === 'failed' && result.stack) process.stdout.write(`${indent(result.stack)}\n`);
}
for (const note of layerNotes) process.stdout.write(`note ${note}\n`);
process.stdout.write(`\npassed=${counts.passed} failed=${counts.failed} skipped=${counts.skipped} timedOut=${counts.timedOut}\n`);
process.stdout.write(`live suite: ${report.liveSuite}\n`);
process.stdout.write(`layer report: ${JSON.stringify(report.layers)}\n`);

if (process.env.DSH_PILOT_JSON) {
  mkdirSync(resolve(process.env.DSH_PILOT_JSON, '..'), { recursive: true });
  writeFileSync(process.env.DSH_PILOT_JSON, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`machine-readable report: ${process.env.DSH_PILOT_JSON}\n`);
}

process.exit(counts.failed > 0 || counts.timedOut > 0 ? 1 : 0);

/**
 * @param {object[]} rows
 * @returns {object}
 */
function summarizeLayers(rows) {
  const out = {};
  for (const row of rows) {
    out[row.layer] ??= { passed: 0, failed: 0, skipped: 0, 'timed-out': 0 };
    out[row.layer][row.status] += 1;
  }
  return out;
}

/** @param {string} text */
function indent(text) {
  return text.split('\n').map((line) => `     ${line}`).join('\n');
}
