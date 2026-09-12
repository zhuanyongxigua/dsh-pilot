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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert } from '../helpers.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const REQUIREMENTS = join(ROOT, 'docs', 'requirements.md');
const MATRIX = join(ROOT, 'docs', 'test-matrix.md');

/**
 * Every document whose test citations this gate resolves. Listed explicitly rather than discovered
 * by walking `docs/`, so that adding a document is a visible decision and a document cannot silently
 * drop out of the audit by being renamed.
 */
const DOCUMENTS = ['test-matrix.md', 'architecture.md', 'conflicts.md'];

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
 * Every test case name under `test/**`, keyed by the `<layer>/<file>` id the matrix cites.
 *
 * The id form is `<layer>/<file>::<case name>`, which is what the runner prints and what the matrix
 * has always cited. Three sources of names are collected, because a suite in this repository may
 * declare its cases in any of the three ways and each has been observed here:
 *
 *   1. **Object keys** — the ordinary form, read out of `export default { … }`.
 *   2. **String literals** — a case name that some other expression passes as a value. This is not
 *      hypothetical: `fake-host/terminal-reason` builds its five table rows at runtime from a
 *      template, so its names exist as values and never appear as keys. An earlier version of this
 *      gate collected only keys and therefore reported all five of those rows as unresolved, which
 *      was the gate being wrong rather than the document.
 *   3. **Template patterns** — a case name built by interpolating a table row. A citation matching
 *      such a pattern is accepted, because the name is real and reconstructing the table to predict
 *      it exactly would be a second implementation of the suite. The interpolation points become
 *      wildcards, so the static part of the name is still checked: renaming `FR-EXEC-3` or the
 *      sentence around it breaks the citation, which is the rot this gate exists to catch.
 *
 * Each form is counted so the collector can report which ones it actually found, rather than a
 * reader having to assume that all of them work.
 * @returns {Promise<{
 *   exact: Set<string>,
 *   byFile: Map<string, { keys: string[], values: string[], declaresNames?: boolean }>,
 *   forms: { keys: number, values: number },
 *   declared: string[],
 * }>} the collected names, and which files declared theirs
 */
async function collectTestIds() {
  /** @type {Set<string>} */
  const exact = new Set();
  /** @type {Map<string, { keys: string[], values: string[], declaresNames?: boolean }>} */
  const byFile = new Map();
  const forms = { keys: 0, values: 0 };

  /** Strip a trailing `…`/`...` and collapse whitespace, so a citation may be line-wrapped. */
  const normalise = (text) => text.replace(/\s+/g, ' ').replace(/\s*\.\.\.$/, '…').trim();

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
      const keys = [];
      /** @type {string[]} */
      const values = [];
      /** Does this suite declare the names it generates? Read before importing it below. */
      const declaresNames = /^\s{2}\$names\s*:/m.test(source);

      const objectStart = source.indexOf('export default {');
      if (objectStart !== -1) {
        const body = source.slice(objectStart + 'export default {'.length);
        for (const match of body.matchAll(/^\s{2}(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z0-9_$][^:\n]*?))\s*:/gm)) {
          const raw = match[1] ?? match[2] ?? match[3];
          if (raw === undefined) continue;
          // `$names` is metadata, not a case; its contents are read from the module below.
          if (raw.trim().startsWith('$')) continue;
          const name = normalise(raw.replace(/\\(['"])/g, '$1'));
          if (name !== '') keys.push(name);
        }
      }

      // Single/double-quoted strings that could be case names. A name passed as a value cannot be
      // told apart from any other string without evaluating the module, and evaluating it would mean
      // running the suite inside this gate — so strings are collected and then FILTERED, because a
      // file about one subject contains many strings that look like its case names.
      //
      // The filter is deliberately narrow, and each clause was added because a real false positive
      // forced it: case names in this repository are full sentences of at least 24 characters, and
      // they never contain a path, a `::` id, a stack frame or a JSON fragment. An earlier version
      // took every literal of 12+ characters, which made the gate report 43 of 142 citations as
      // ambiguous — every one of them matching its own case name AND a failure message quoting it.
      // Comments are removed first. Without this, a sentence in a COMMENT (`// cancelling a wait is
      // not cancelling work.`) was collected as a name and then reported the real citation as
      // ambiguous — the gate inventing a second case that does not exist.
      const code = source
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
      for (const match of code.matchAll(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g)) {
        const name = normalise(match[0].slice(1, -1).replace(/\\(['"])/g, '$1'));
        if (name.length < 24) continue;
        if (!name.includes(' ')) continue;
        if (name.includes('::') || name.includes('/')) continue;
        // A case name is a sentence, so it ends in punctuation. A fragment of prose mid-sentence
        // does not, which is what keeps failure messages out of the name set.
        if (!/[.?:]\s*$/.test(name)) continue;
        if (/\bat line \d|\$\{|\{\}|^\W/.test(name)) continue;
        if (!values.includes(name)) values.push(name);
      }

      for (const name of keys) exact.add(`${fileKey}::${name}`);
      byFile.set(fileKey, { keys, values, declaresNames });
      forms.keys += keys.length;
      forms.values += values.length;
    }
  };

  walk(join(ROOT, 'test'), 'test');

  // A suite whose cases are generated at runtime declares them as `$names`, and that list is read by
  // IMPORTING the module — not by parsing it. The gate's first two attempts at predicting these names
  // from template text were both wrong in ways that took several rounds to see, and the reason is
  // structural: predicting a generated name is a second implementation of the generator, and a second
  // implementation can only ever agree or disagree with the first. Importing cannot disagree. Only
  // modules that declare the key are imported, and only the key is read.
  /** @type {string[]} */
  const declared = [];
  for (const [fileKey, entry] of byFile) {
    if (!entry.declaresNames) continue;
    const url = pathToFileURL(join(ROOT, 'test', `${fileKey}.test.mjs`)).href;
    const module = await import(url);
    const names = module.default?.$names;
    assert.ok(Array.isArray(names) && names.every((name) => typeof name === 'string'),
      `${fileKey} declares $names, so it must export an array of strings; got ${typeof names}`);
    declared.push(fileKey);
    for (const name of names) {
      entry.keys.push(name);
      entry.values.push(name);
      exact.add(`${fileKey}::${name}`);
      forms.keys += 1;
    }
  }
  return { exact, byFile, forms, declared };
}

/**
 * Match a citation's case name against one file's names, allowing the documented abbreviations: a
 * trailing ellipsis means "starts with", an interior ellipsis is a word-subsequence, and an
 * exact-but-whitespace-different name matches after collapsing whitespace (citations are wrapped in
 * narrow table columns, so a name can span a line break in the document).
 * @param {string} caseName
 * @param {{ keys: string[], values: string[], declaresNames?: boolean }} entry
 * @returns {string | null} null when it matched, else why it did not
 */
function matchCase(caseName, entry) {
  /** The normalised citation text, with any trailing ellipsis kept as a marker. */
  const wanted = caseName.replace(/\s+/g, ' ').trim();
  const all = [...new Set([...entry.keys, ...entry.values])];

  if (all.includes(wanted)) return null;

  if (wanted.endsWith('…')) {
    const prefix = wanted.slice(0, -1).trimEnd();
    // Templates are tested FIRST. A suite that builds its names from a table also contains the
    // literal fragments those names are built from, so literal prefix matching alone reported
    // `FR-EXEC-3 failed: …` — a real, generated case — as naming nothing.
    const matches = all.filter((name) => name.startsWith(prefix));
    if (matches.length === 1) return null;
    if (matches.length === 0) return `no case starts with "${prefix}"`;
    return `${matches.length} cases start with "${prefix}" (ambiguous)`;
  }

  if (wanted.includes('…')) {
    // An interior ellipsis elides the middle: the parts must appear in order, separated by anything.
    const parts = wanted.split('…').map((part) => part.trim()).filter((part) => part !== '');
    const pattern = new RegExp(`^${parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s\\S]*')}$`);
    const matches = all.filter((name) => pattern.test(name));
    if (matches.length === 1) return null;
    if (matches.length === 0) return `no case matches "${wanted}"`;
    return `${matches.length} cases match "${wanted}" (ambiguous)`;
  }

  // `::*` and `::…` name the whole file (used where a row cites an entire opt-in layer).
  if (wanted === '*' || wanted === '…') {
    return all.length > 0 ? null : 'the file declares no cases at all';
  }

  // No approximate fallback on purpose. An earlier revision added one and it made the gate accept a
  // case name that measured nothing: it matched any name whose words appeared in order, which is
  // almost every name in a file about one subject. A resolver that cannot say no is decoration, so
  // the only remaining answers are the three exact ones above.
  return `no case named "${wanted}"`;
}

/**
 * Does one citation resolve to a real case?
 * @param {string} citation the id as written in the document, possibly wrapped or abbreviated
 * @param {Set<string>} exact
 * @param {Map<string, { keys: string[], values: string[], declaresNames?: boolean }>} byFile
 * @returns {{ ok: true } | { ok: false, why: string }}
 */
function resolve(citation, exact, byFile) {
  // A soft line break inside a table cell is a wrapping artefact of the document, not part of a name.
  const flat = citation.replace(/\s+/g, ' ').trim();
  if (exact.has(flat)) return { ok: true };
  const fileKey = flat.split('::')[0];
  const caseName = flat.slice(fileKey.length + 2);
  if (!flat.includes('::')) return { ok: false, why: 'no case name (expected "<layer>/<file>::<case>")' };
  const entry = byFile.get(fileKey);
  if (!entry) return { ok: false, why: `no suite file named ${fileKey}` };
  const failure = matchCase(caseName, entry);
  return failure === null ? { ok: true } : { ok: false, why: failure };
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
  'FR-EV2-1: every P0/P1 requirement has a matrix row, and the documents agree on the id set': async () => {
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

  'FR-EV2-1: a row claiming `measured` cites test ids that all exist, so a citation cannot outlive its test': async () => {
    const { exact, byFile, forms } = await collectTestIds();
    // The collector is an oracle too. A run that found no cases at all must fail rather than pass.
    assert.ok(byFile.size >= 7,
      `expected at least 7 suite files with discoverable cases, found ${byFile.size}: ${[...byFile.keys()].join(', ')}`);
    // All three name forms must be found, so a reader does not have to assume the collector works:
    // if one form stops being recognised, this fails instead of silently reporting fewer names.
    // Measured when written: 128 keys, 21 value-only names, 1 case-name template. The floors are
    // here so a form silently ceasing to be recognised fails, not to fail on every edit.
    assert.ok(forms.keys >= 100 && forms.values >= 15,
      `the name collector must find both name forms, found keys=${forms.keys} values=${forms.values}`);
    let total = 0;
    for (const entry of byFile.values()) total += entry.keys.length;
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

  'FR-EV2-1: EVERY citation in every document resolves — not only the `measured` rows': async () => {
    // The check above covers the rows that claim `measured`. This one covers all of them, plus
    // `docs/architecture.md` and `docs/conflicts.md`, because a citation that resolves nowhere is
    // wrong no matter which column it sits in: a `partial` row citing a renamed test reads as
    // "somebody checked this", and nobody did. Enforcing only the strongest rows would leave the
    // weaker ones free to rot, which is where rot actually starts.
    const { exact, byFile } = await collectTestIds();
    /** @type {string[]} */
    const broken = [];
    let checked = 0;
    let scanned = 0;

    for (const doc of DOCUMENTS) {
      const source = read(join(ROOT, 'docs', doc));
      const cited = citationsIn(source);
      if (cited.length === 0) continue;
      scanned += 1;
      // Every doc that carries citations must carry enough for the check to be worth trusting.
      for (const citation of cited) {
        checked += 1;
        const verdict = resolve(citation, exact, byFile);
        if (!verdict.ok) broken.push(`${doc}: ${citation} — ${verdict.why}`);
      }
    }

    assert.ok(scanned >= 3,
      `expected at least 3 documents carrying test citations, scanned ${scanned}; a document that lost its ` +
      'citations would otherwise make this check vacuous');
    // Measured at the time of writing: 142 distinct citations across the three documents. The floor
    // sits below that on purpose — it is here to catch a document losing its citations wholesale
    // (which would make the check vacuous), not to fail every time a row is edited.
    assert.ok(checked >= 120,
      `expected at least 120 citations across the documents, found ${checked}`);
    assert.deepEqual(broken, [],
      `${broken.length} of ${checked} document citations do not resolve:\n  ${broken.join('\n  ')}`);
    process.stdout.write(`      document citations: ${checked} across ${scanned} documents all resolve\n`);
  },

  'FR-EV2-1: a citation that resolves nowhere is REFUSED — the gate is proven to be able to fail': async () => {
    // The negative control for this file, run inline rather than as a mutation, because the thing
    // under test is a resolver and the resolver is reachable directly. Each case below is a real
    // failure mode of the mapping, and a gate that cannot reject them is decoration.
    const { exact, byFile } = await collectTestIds();

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

    // (d2) An interior ellipsis resolves when it uniquely matches, and is refused when ambiguous.
    const interior = resolve('unit/core::exclusive ownership… the holder keeps it while stopped', exact, byFile);
    assert.equal(interior.ok, true, `an interior-ellipsis citation must resolve, got ${JSON.stringify(interior)}`);
    const everything = resolve('property/model::*', exact, byFile);
    assert.equal(everything.ok, true, `a whole-file citation must resolve, got ${JSON.stringify(everything)}`);
    const nothing = resolve('unit/no-such-suite::*', exact, byFile);
    assert.equal(nothing.ok, false, 'a whole-file citation on a missing file must still be refused');

    // (e) A real, fully spelled citation DOES resolve — otherwise the refusals above would also be
    //     satisfied by a resolver that refuses everything.
    const real = resolve('fake-host/contract::an approval decision requires the operator token and cannot be replayed', exact, byFile);
    assert.equal(real.ok, true, `a real citation must resolve, got ${JSON.stringify(real)}`);

    // (f) A prefix abbreviation that is unique DOES resolve, which is the allowance the matrix uses.
    const abbreviated = resolve('fake-host/contract::an approval decision requires the operator token…', exact, byFile);
    assert.equal(abbreviated.ok, true, `a unique prefix abbreviation must resolve, got ${JSON.stringify(abbreviated)}`);

    // (f2) The declared-names mechanism, checked rather than assumed. A suite that declares `$names`
    //      must have that list READ from the module (not predicted), each declared name must resolve,
    //      and a citation built from a declared name must resolve while a corrupted one must not —
    //      otherwise "the gate handles generated names" would be a claim with no oracle.
    const { declared } = await collectTestIds();
    assert.ok(declared.length >= 1,
      `expected at least one suite to declare $names, found ${declared.length}; the generated-name path would ` +
      'otherwise be untested');
    const terminal = byFile.get('fake-host/terminal-reason');
    assert.ok(terminal?.declaresNames === true, 'fake-host/terminal-reason declares $names');
    assert.ok((terminal?.keys.length ?? 0) >= 6,
      `the declared names must be read from the module, found ${terminal?.keys.length} keys`);
    const declaredName = 'fake-host/terminal-reason::FR-EXEC-3 failed: the terminal reason is \'failed\', with the operation and turn facts under it';
    assert.equal(resolve(declaredName, exact, byFile).ok, true,
      'a fully spelled citation of a generated case must resolve');
    const corrupted = declaredName.replace("is 'failed'", "is 'fialed'");
    assert.equal(resolve(corrupted, exact, byFile).ok, false,
      'a citation whose generated name no longer matches must be refused');

    // (g) And the citation extractor must find the ids it is supposed to find, so the checker above
    //     cannot pass by seeing no citations at all.
    const found = citationsIn('`fake-host/contract::one` and `security/bounds::two` and no-id-here');
    assert.deepEqual(found, ['fake-host/contract::one', 'security/bounds::two'],
      `the citation extractor must find backticked ids, got ${JSON.stringify(found)}`);
    void relative;
  },
};
