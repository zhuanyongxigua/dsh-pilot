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

import { existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
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

// Preflight: the implementation is TypeScript SOURCE, and every layer here — including a test that
// spawns the real MCP binary over stdio — runs the BUILT artifact under `dist/`. Without this check a
// fresh clone produces a wall of module-resolution failures that read like broken code rather than
// like a missing build step, which is how a build problem gets mistaken for a product defect.
if (!existsSync(resolve('dist/lib/ids.js'))) {
  process.stderr.write(
    'the built implementation is missing (dist/lib/ids.js not found).\n'
    + 'The sources are TypeScript; run `npm run build` first, or `npm run build && node test/run.mjs`.\n',
  );
  process.exit(2);
}

/**
 * Register every case this run WILL execute, before executing any of them.
 *
 * Why a pre-pass: the matrix gate has to check that the set of names its own static collection finds
 * equals the set the runner actually registers. A hand-maintained total in the gate could only be
 * kept honest by remembering to bump it, which is a check that rots; handing the gate the runner's
 * own count makes disagreement impossible to hide. Modules are imported here and again in the main
 * loop, and Node's module cache makes the second import free.
 */
let registeredCases = 0;
for (const layer of layers) {
  const dir = resolve(layer);
  let names;
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.test.mjs')).sort();
  } catch { continue; }
  for (const name of names) {
    const id = `${layer.replace(/^test\//, '')}/${name.replace(/\.test\.mjs$/, '')}`;
    if (args.filter && !id.includes(args.filter)) continue;
    try {
      const mod = await import(pathToFileURL(join(dir, name)).href);
      const suites = mod.default ?? {};
      if (typeof suites !== 'object') continue;
      for (const key of Object.keys(suites)) {
        // The same rule the runner applies below, and the ONLY rule: a `$`-prefixed key is metadata,
        // not a case. `$names` deliberately does not add to this count — it declares the sub-cases a
        // generated suite will report INSIDE the suite keys it already exports, so counting both
        // inflated this total by exactly the number of declared names. The matrix gate keeps its own
        // collection that counts both forms, because a document may cite either; this is the number
        // the runner registers and executes, which is what the gate compares against.
        if (key.startsWith('$')) continue;
        registeredCases += 1;
      }
    } catch { /* a module that cannot be imported is reported by the main loop */ }
  }
}

/** @type {{id: string, layer: string, status: string, ms: number, detail?: string, stack?: string}[]} */
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
      // What this run registered, and whether it was narrowed: the matrix gate compares its own
      // static collection against these rather than against a constant nobody would remember to
      // update. A filtered run registers a subset while the gate still collects every name, so the
      // total check is only meaningful when nothing was filtered out.
      registeredCases,
      filtered: Boolean(args.filter),
      // Which layers this run selected, so a check that compares the runner's count against a static
      // collection of the tree can restrict itself to the same layers. `node test/run.mjs test/unit`
      // legitimately registers a fraction of the tree; that is not a disagreement.
      layers: layers.map((layer) => layer.replace(/^test\//, '')),
    };
    for (const [suiteName, run] of Object.entries(suites)) {
      // A suite may declare metadata instead of a case. `$names` is the one such key today: a suite
      // whose cases are generated at runtime lists the names it will register, so that a document
      // citing one of them can be checked against a declared name rather than against a guess at how
      // the suite builds it. Skipping is explicit and keyed on the `$` prefix, so a real case whose
      // name happens to start with `$` is impossible to write by accident.
      if (suiteName.startsWith('$')) continue;
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
        // A timeout is reported by a DOMException (`TimeoutError`), not by an Error subclass in
        // every runtime, so the name is read structurally rather than through `instanceof`.
        // Objects and functions are the only values that can carry `name`, so this is exactly
        // the `error?.name` read it replaces.
        const thrownName = error && (typeof error === 'object' || typeof error === 'function') && 'name' in error
          ? error.name
          : undefined;
        if (message.startsWith(SKIP_MARKER)) {
          results.push({ id: caseId, layer, status: 'skipped', ms, detail: message.slice(SKIP_MARKER.length).trim() });
        } else if (thrownName === 'TimeoutError' || /timed out|timeout/i.test(message)) {
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
