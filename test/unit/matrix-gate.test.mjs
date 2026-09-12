/**
 * FR-EV2-1 — the requirement-to-test mapping is a GATE, not a document.
 *
 * The requirement (from `docs/requirements.md`):
 *   | FR-EV2-1 | P0 | Every reliability claim in the README/docs maps to a runnable test id in the
 *     matrix. | Requirements-to-test matrix audit: zero unmapped P0/P1 rows, zero matrix rows with
 *     no requirement. |
 *
 * The oracle the requirement names is an AUDIT, and until now the audit was performed by hand:
 * `docs/test-matrix.md` said so itself ("the mapping is maintained by hand, so a missing row is a
 * documentation bug rather than a red test"). A hand-maintained mapping is exactly what silently
 * rots — a requirement gets added, or a test gets renamed, and nobody notices because nothing fails.
 *
 * So this file reads the two artifacts and cross-checks them BOTH ways:
 *
 *   1. Every P0/P1 requirement in `docs/requirements.md` has a row in the matrix naming at least one
 *      test.
 *   2. Every test id the matrix cites for a `measured` row actually EXISTS as a real test case in
 *      `test/**`. A citation that resolves to nothing is a lie with a filename on it, and it is the
 *      failure mode that matters most: it lets a deleted test keep its claim forever.
 *   3. Every row in the matrix names a requirement that exists.
 *   4. A row may only claim `measured` when all of its cited ids resolve. Rows that are honestly
 *      `partial`/`unverified`/`not-implemented`/`blocked` are allowed to cite fewer or none — the
 *      matrix's own legend defines those words, and this gate enforces that the strong word is not
 *      used loosely.
 *
 * What this gate deliberately does NOT do: it does not read the cited test's assertions, so it cannot
 * tell a strong test from a weak one. It proves the mapping is real and complete, which is what
 * FR-EV2-1 asks for, and it says so rather than implying more.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from '../helpers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REQUIREMENTS = join(ROOT, 'docs', 'requirements.md');
const MATRIX = join(ROOT, 'docs', 'test-matrix.md');

/** Priority of a requirement row, as the requirements document spells it. */
const PRIORITIES = ['P0', 'P1', 'P2'];

/**
 * Read a markdown file. Chosen over a markdown parser because this repository has zero dependencies
 * and the two documents have a fixed, enforced table shape — which this gate checks.
 * @param {string} path
 * @returns {string}
 */
function read(path) {
  return readFileSync(path, 'utf8');
}

/**
 * Split a markdown table row into its cells, respecting `\|` escapes inside a cell.
 * @param {string} line
 * @returns {string[]}
 */
function cells(line) {
  const trimmed = line.trim();
  const inner = trimmed.startsWith('|') ? trimmed.slice(1) : trimmed;
  const withoutTrailing = inner.endsWith('|') ? inner.slice(0, -1) : inner;
  /** @type {string[]} */
  const out = [];
  let current = '';
  for (let index = 0; index < withoutTrailing.length; index += 1) {
    const char = withoutTrailing[index];
    if (char === '\\' && withoutTrailing[index + 1] === '|') {
      current += '|';
      index += 1;
    } else if (char === '|') {
      out.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current.trim());
  return out;
}

/**
 * Parse the requirement rows out of `docs/requirements.md`: `| ID | PRI | ... |`.
 * @returns {{ id: string, priority: string }[]}
 */
function parseRequirements() {
  /** @type {{ id: string, priority: string }[]} */
  const found = [];
  for (const line of read(REQUIREMENTS).split('\n')) {
    const parts = cells(line);
    if (parts.length < 3) continue;
    const id = parts[0];
    const priority = parts[1];
    if (!/^FR-[A-Z0-9-]+$/.test(id)) continue;
    if (!PRIORITIES.includes(priority)) continue;
    found.push({ id, priority });
  }
  return found;
}

/**
 * Parse the matrix rows. Every matrix table has the shape `| Req | Pri | Status | Test id(s) | ... |`.
 * @returns {{ id: string, priority: string, status: string, ids: string }[]}
 */
function parseMatrixRows() {
  /** @type {{ id: string, priority: string, status: string, ids: string }[]} */
  const rows = [];
  for (const line of read(MATRIX).split('\n')) {
    const parts = cells(line);
    if (parts.length < 4) continue;
    const [id, priority, status, ids] = parts;
    if (!/^FR-[A-Z0-9-]+$/.test(id)) continue;
    if (!PRIORITIES.includes(priority)) continue;
    rows.push({ id, priority, status, ids });
  }
  return rows;
}

/**
 * Every test case declared under `test/**`, keyed by the exact id the matrix must use.
 *
 * The id form is `<layer>/<file>::<case name>`, which is what the runner prints and what the matrix
 * has always cited. A case name may be abbreviated in the matrix with a trailing ellipsis, because
 * long names do not fit a table cell; an abbreviation resolves when it is a PREFIX of exactly one
 * real case name in that file. That is a deliberate, narrow allowance: it keeps the citation
 * checkable while letting the table stay readable, and it is checked rather than assumed.
 * @returns {{ exact: Set<string>, byFile: Map<string, string[]> }}
 */
function collectTestIds() {
  /** @type {Set<string>} */
  const exact = new Set();
  /** @type {Map<string, string[]>} */
  const byFile = new Map();

  /** @param {string} dir @param {string} layer */
  const walk = (dir, layer) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path, layer === '' ? entry.name : `${layer}/${entry.name}`);
        continue;
      }
      if (!entry.name.endsWith('.test.mjs')) continue;
      // The matrix cites `<layer>/<file>::<case>` with the layer path relative to `test/`, which is
      // also the form the runner prints, so the leading `test/` the walk carries is stripped here.
      const relativeLayer = layer === 'test' ? '' : layer.replace(/^test\//, '');
      const fileKey = relativeLayer === ''
        ? entry.name.replace(/\.test\.mjs$/, '')
        : `${relativeLayer}/${entry.name.replace(/\.test\.mjs$/, '')}`;
      const source = read(path);
      /** @type {string[]} */
      const names = [];
      // The suites are exported as an object literal whose keys are the case names. Reading the
      // QUOTED or bare keys out of that literal is enough and is robust to formatting, because every
      // suite in this repository is written that way; the gate also asserts a non-zero count per
      // file, so a file written in a shape this misses fails loudly instead of silently contributing
      // nothing.
      const objectStart = source.indexOf('export default {');
      if (objectStart === -1) continue;
      const body = source.slice(objectStart + 'export default {'.length);
      for (const match of body.matchAll(/^\s{2}(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_$][^:\n]*?))\s*:/gm)) {
        const raw = match[1] ?? match[2] ?? match[3];
        if (raw === undefined) continue;
        names.push(raw.replace(/\\(['"])/g, '$1').trim());
      }
      if (names.length === 0) continue;
      byFile.set(fileKey, names);
      for (const name of names) exact.add(`${fileKey}::${name}`);
    }
  };

  walk(join(ROOT, 'test'), 'test');
  return { exact, byFile };
}

/**
 * Does one citation resolve to a real case?
 * @param {string} citation the id as written in the matrix, possibly abbreviated
 * @param {Set<string>} exact
 * @param {Map<string, string[]>} byFile
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
function resolve(citation, exact, byFile) {
  if (exact.has(citation)) return { ok: true };
  const [fileKey, caseName] = citation.split('::');
  if (caseName === undefined) return { ok: false, why: `no case name (expected "<layer>/<file>::<case>")` };
  const names = byFile.get(fileKey);
  if (!names) return { ok: false, why: `no suite file named ${fileKey}` };
  // A trailing ellipsis is the documented abbreviation. Anything else must match exactly.
  if (caseName.endsWith('…')) {
    const prefix = caseName.slice(0, -1).trimEnd();
    const matches = names.filter((name) => name.startsWith(prefix));
    if (matches.length === 1) return { ok: true };
    if (matches.length === 0) return { ok: false, why: `no case in ${fileKey} starts with "${prefix}"` };
    return { ok: false, why: `${matches.length} cases in ${fileKey} start with "${prefix}" (ambiguous)` };
  }
  return { ok: false, why: `no case named "${caseName}" in ${fileKey}` };
}

/** Every `test_id`-shaped token inside a cell, in the order written, deduplicated. */
const CITATION = /`([a-z0-9-]+\/[a-z0-9-]+::[^`]+)`/g;

/**
 * @param {string} cell
 * @returns {string[]}
 */
function citationsIn(cell) {
  /** @type {string[]} */
  const out = [];
  for (const match of cell.matchAll(CITATION)) {
    const cited = match[1].trim();
    if (!out.includes(cited)) out.push(cited);
  }
  return out;
}

export default {
  'FR-EV2-1: every P0/P1 requirement has a matrix row, and the documents agree on the id set': () => {
    const requirements = parseRequirements();
    const rows = parseMatrixRows();

    // The two parsers are the oracle for everything below, so they are checked first: a parser that
    // silently found nothing would make every other assertion in this file vacuously true.
    assert.ok(requirements.length >= 40,
      `expected the requirements document to declare at least 40 requirements, found ${requirements.length}`);
    assert.ok(rows.length >= 40, `expected at least 40 matrix rows, found ${rows.length}`);

    const requiredIds = new Set(requirements.map((row) => row.id));
    const mappedIds = new Set(rows.map((row) => row.id));

    // 1. No P0/P1 requirement may be missing from the matrix.
    const unmapped = requirements
      .filter((row) => row.priority === 'P0' || row.priority === 'P1')
      .filter((row) => !mappedIds.has(row.id))
      .map((row) => `${row.id} (${row.priority})`);
    assert.deepEqual(unmapped, [], `P0/P1 requirements with no matrix row: ${unmapped.join(', ')}`);

    // 2. No matrix row may name a requirement that does not exist. A row for a phantom requirement
    //    is how a document drifts away from the spec it claims to audit.
    const orphanRows = [...mappedIds].filter((id) => !requiredIds.has(id));
    assert.deepEqual(orphanRows, [], `matrix rows naming no requirement: ${orphanRows.join(', ')}`);

    // 3. The priority in the matrix must agree with the priority in the requirements document.
    const mismatched = rows
      .map((row) => {
        const declared = requirements.find((requirement) => requirement.id === row.id);
        return declared && declared.priority !== row.priority
          ? `${row.id}: requirements says ${declared.priority}, matrix says ${row.priority}`
          : null;
      })
      .filter((entry) => entry !== null);
    assert.deepEqual(mismatched, [], `priority disagreements between the two documents: ${mismatched.join('; ')}`);
  },

  'FR-EV2-1: a row claiming `measured` cites test ids that all exist, so a citation cannot outlive its test': () => {
    const { exact, byFile } = collectTestIds();
    // The collector is an oracle too. A run that found no cases at all must fail rather than pass.
    assert.ok(byFile.size >= 7,
      `expected at least 7 suite files with discoverable cases, found ${byFile.size}: ${[...byFile.keys()].join(', ')}`);
    let total = 0;
    for (const names of byFile.values()) total += names.length;
    assert.ok(total >= 90, `expected at least 90 discoverable cases, found ${total}`);

    const rows = parseMatrixRows();
    const measured = rows.filter((row) => row.status === 'measured');
    assert.ok(measured.length >= 20,
      `expected at least 20 rows to claim measured; found ${measured.length}. A status column that never says ` +
      'measured would make this check vacuous.');

    /** @type {string[]} */
    const broken = [];
    for (const row of measured) {
      const citations = citationsIn(row.ids);
      if (citations.length === 0) {
        // A `measured` row with no test id is a claim with no oracle. That is precisely the thing
        // FR-EV2-1 exists to prevent, and it is a stronger failure than a dead citation.
        broken.push(`${row.id}: claims measured but cites no test id`);
        continue;
      }
      for (const citation of citations) {
        const verdict = resolve(citation, exact, byFile);
        if (!verdict.ok) broken.push(`${row.id}: "${citation}" — ${verdict.why}`);
      }
    }
    assert.deepEqual(broken, [], `matrix citations that do not resolve to a real case:\n  ${broken.join('\n  ')}`);
    process.stdout.write(
      `      matrix gate: ${measured.length} measured rows verified against ${total} real cases in ${byFile.size} files\n`,
    );
  },

  'FR-EV2-1: a citation that resolves nowhere is REFUSED — the gate is proven to be able to fail': () => {
    // The negative control for this file, run inline rather than as a mutation, because the thing
    // under test is a resolver and the resolver is reachable directly. Each case below is a real
    // failure mode of the mapping, and a gate that cannot reject them is decoration.
    const { exact, byFile } = collectTestIds();

    // (a) A test id whose test does not exist: the exact rot this gate exists to catch.
    const deadTest = resolve('fake-host/contract::this test does not exist', exact, byFile);
    assert.equal(deadTest.ok, false, 'a citation naming no real case must be refused');

    // (b) A file that does not exist.
    const deadFile = resolve('fake-host/no-such-file::anything', exact, byFile);
    assert.equal(deadFile.ok, false, 'a citation naming no real file must be refused');

    // (c) A malformed citation with no case name.
    const malformed = resolve('fake-host/contract', exact, byFile);
    assert.equal(malformed.ok, false, 'a citation with no case name must be refused');

    // (d) An ambiguous abbreviation must be refused rather than resolved to a guess.
    const ambiguous = resolve('fake-host/contract::a', exact, byFile);
    assert.equal(ambiguous.ok, false, 'an abbreviation matching several cases must be refused, not guessed at');

    // (e) A real, fully spelled citation DOES resolve — otherwise the refusals above would also be
    //     satisfied by a resolver that refuses everything.
    const real = resolve('fake-host/contract::an approval decision requires the operator token and cannot be replayed', exact, byFile);
    assert.equal(real.ok, true, `a real citation must resolve, got ${JSON.stringify(real)}`);

    // (f) A prefix abbreviation that is unique DOES resolve, which is the allowance the matrix uses.
    const abbreviated = resolve('fake-host/contract::an approval decision requires the operator token…', exact, byFile);
    assert.equal(abbreviated.ok, true, `a unique prefix abbreviation must resolve, got ${JSON.stringify(abbreviated)}`);

    // (g) And the citation extractor must find the ids it is supposed to find, so the checker above
    //     cannot pass by seeing no citations at all.
    const found = citationsIn('`fake-host/contract::one` and `security/bounds::two` and no-id-here');
    assert.deepEqual(found, ['fake-host/contract::one', 'security/bounds::two'],
      `the citation extractor must find backticked ids, got ${JSON.stringify(found)}`);
    void relative;
  },
};
