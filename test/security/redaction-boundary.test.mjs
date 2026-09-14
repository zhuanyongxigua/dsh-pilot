/**
 * FR-SEC-3 against replay fidelity — the inbound normalisation and redaction boundary (conflict C-1).
 *
 * Why this file exists: `docs/conflicts.md` C-1 recorded a collision between "a secret never appears
 * in state" and the event archive's faithfulness, and left it OPEN. ADR 0002
 * (`docs/adr/0002-inbound-normalisation-and-redaction-boundary.md`) resolves it with one boundary
 * applied once, so there is exactly one payload per event for live reduction, durable storage and
 * replay alike. This file is the oracle for that boundary: it tests the boundary function directly,
 * because the boundary is a pure module and the property under test ("the sentinel is gone, the
 * control fields are not") is a property of the function rather than of a running daemon. The
 * end-to-end consequences are measured in `security/secret-leakage.test.mjs`, which is the file that
 * currently asserts the archive is verbatim and will need to be updated when the boundary is WIRED
 * into ingest — this change does not touch it.
 *
 * The sentinel is a synthetic value assembled at runtime from parts, never a credential-shaped
 * literal, and it is deliberately shaped like a provider key so that a shape-keyed policy has
 * something to key on. A test whose sentinel did not look like a credential would pass against a
 * redactor that recognises nothing.
 *
 * Three of the cases below exist only to keep the rest from being vacuous: a benign string that
 * survives, a control-field object that is byte-identical before and after, and the same input run
 * with redaction DISABLED showing the sentinel present. If any of those three passed for the wrong
 * reason, the absence assertions above them would be meaningless.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, asRecord, ROOT } from '../helpers.mjs';
import { redactCredentials } from '../../dist/lib/adapter.js';
import {
  CREDENTIAL_PATTERNS,
  CYCLE_MARKER,
  DEPTH_MARKER,
  MAX_DEPTH,
  MAX_NODES,
  NODE_LIMIT_MARKER,
  REDACTION_DISABLED_POLICY,
  REDACTION_MARKER,
  REDACTION_POLICY,
  UNREADABLE_MARKER,
  isSensitiveKeyName,
  redactInbound,
} from '../../dist/lib/redact.js';

/** @typedef {import('../../dist/lib/redact.js').RedactionPolicy} RedactionPolicy */

/**
 * Build the sentinel at runtime. Assembled from parts so no credential-shaped literal is committed
 * anywhere in this repository, and shaped like a provider token so the policy has a shape to match.
 * @param {string} tag
 * @returns {string}
 */
function sentinel(tag) {
  const prefix = ['s', 'k'].join('');
  const body = ['ZZBOUNDARY', tag, 'abcdefghijklmnop'].join('-');
  return `${prefix}-${body}`;
}

/**
 * The credential-shaped key names a replay reads. Named here as the test's own vocabulary, and
 * asserted against the exported policy rather than assumed, because "the boundary does not damage
 * replay-critical data" is a claim about exactly these names.
 */
const REPLAY_CONTROL_KEYS = ['seq', 'sessionId', 'kind', 'type', 'outcome', 'state', 'turn', 'eventId', 'taskId', 'hostSessionId'];

/**
 * Where a needle appears in a serialised value, or `''` when it does not.
 *
 * Why this shape: an absence assertion that fails with "expected false, got true" tells a reader
 * nothing. Returning the surrounding context means the failure names the field the secret survived
 * in, which is the difference between a diagnosable failure and a rerun.
 * @param {unknown} value
 * @param {string} needle
 * @returns {string}
 */
function leakContext(value, needle) {
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  const at = text.indexOf(needle);
  return at === -1 ? '' : text.slice(Math.max(0, at - 80), at + needle.length + 80);
}

export default {
  'the policy the other cases assert against is exported as values, not as magic strings': async () => {
    // Stated once, deliberately: after this case every other assertion names a constant, so a
    // changed marker fails here with a readable message instead of drifting silently everywhere.
    assert.equal(REDACTION_MARKER, '[redacted:credential]', 'the credential marker spelling is part of the contract');
    for (const [name, marker] of Object.entries({ CYCLE_MARKER, DEPTH_MARKER, NODE_LIMIT_MARKER, UNREADABLE_MARKER })) {
      assert.equal(typeof marker, 'string', `${name} must be exported`);
      assert.match(marker, /^\[redacted:/, `${name} must be recognisable as a redaction, not as an empty value`);
    }
    assert.ok(Array.isArray(CREDENTIAL_PATTERNS) && CREDENTIAL_PATTERNS.length > 0, 'the shape set must be exported and non-empty');
    for (const pattern of CREDENTIAL_PATTERNS) assert.ok(pattern instanceof RegExp, 'every shape must be a RegExp');
    assert.equal(REDACTION_POLICY.enabled, true, 'the default policy must redact');
    assert.equal(REDACTION_POLICY.maxDepth, MAX_DEPTH, 'the policy must carry the exported depth bound');
    assert.equal(REDACTION_POLICY.maxNodes, MAX_NODES, 'the policy must carry the exported node bound');
    // The disabled policy is the negative control's input, so it must be the SAME policy with only
    // the substitution switched off — otherwise the control would compare two unrelated things.
    assert.equal(REDACTION_DISABLED_POLICY.enabled, false, 'the control policy must not redact');
    assert.equal(REDACTION_DISABLED_POLICY.maxDepth, REDACTION_POLICY.maxDepth, 'the control keeps the depth bound');
    assert.equal(REDACTION_DISABLED_POLICY.maxNodes, REDACTION_POLICY.maxNodes, 'the control keeps the node bound');
    assert.equal(REDACTION_DISABLED_POLICY.patterns, REDACTION_POLICY.patterns, 'the control keeps the same shape set');
  },

  'the sentinel is absent from a flat string, a log line and a tool-input payload': async () => {
    const secret = sentinel('PLAIN');
    assert.match(secret, /^sk-[A-Za-z0-9-]{16,}$/, 'the sentinel must look like a provider token, or this file tests nothing');

    // 1. A flat string.
    const flat = `provider refused: authorization ${secret}`;
    const flatOut = redactInbound(flat);
    assert.equal(leakContext(flatOut, secret), '', `the sentinel survived a flat string: ${leakContext(flatOut, secret)}`);
    // The redaction must be a redaction, not a deletion: the diagnosis is what an operator reads.
    assert.match(String(flatOut), /provider refused/, 'the diagnosis must survive');
    assert.match(String(flatOut), /redacted/, 'the redaction must be visible in the text it replaced');

    // 2. A log line, which is the same policy applied to text the bridge did not author.
    const line = `2026-01-01T00:00:00.000Z WARN bash: curl -H "Authorization: Bearer ${secret}" -> HTTP 401`;
    const lineOut = redactInbound(line);
    assert.equal(leakContext(lineOut, secret), '', `the sentinel survived a log line: ${leakContext(lineOut, secret)}`);
    assert.match(String(lineOut), /HTTP 401/, 'the line must keep its diagnostic tail');
    assert.match(String(lineOut), /bash/, 'the line must keep its subject');

    // 3. A tool-input-shaped payload, which is where conflict C-1 says a credential really arrives:
    //    a turn naming a shell command that quotes an authorization header.
    const toolInput = {
      name: 'bash',
      callId: 'call-0001',
      input: { command: `curl -H 'Authorization: Bearer ${secret}' https://example.invalid/health`, timeoutMs: 5000 },
    };
    const toolOut = asRecord(redactInbound(toolInput), 'the redacted tool input');
    assert.equal(leakContext(toolOut, secret), '', `the sentinel survived a tool-input payload: ${leakContext(toolOut, secret)}`);
    assert.deepEqual(Object.keys(toolOut), Object.keys(toolInput), 'key ORDER is a structural fact and must not change');
    assert.equal(toolOut['name'], 'bash', 'the tool name is control data and must survive');
    assert.equal(toolOut['callId'], 'call-0001', 'the call id is control data and must survive');
    const inputBag = asRecord(toolOut['input'], 'the redacted tool input body');
    assert.equal(inputBag['timeoutMs'], 5000, 'a number must survive the walk unchanged, not be stringified');
    assert.match(String(inputBag['command']), /example\.invalid/, 'the command must still say what it was aimed at');
  },

  'the sentinel is absent from a deeply nested object, an array element and an error-detail bag': async () => {
    const secret = sentinel('NESTED');

    // Deep nesting with benign siblings at every level: the point is that the walk reaches the leaf
    // AND that the levels above it are not collapsed, truncated or reordered on the way.
    const nested = { level1: { keep: 'a', level2: { keep: 'b', level3: { keep: 'c', level4: { keep: 'd', leak: secret } } } } };
    const nestedOut = redactInbound(nested);
    assert.equal(leakContext(nestedOut, secret), '', `the sentinel survived deep nesting: ${leakContext(nestedOut, secret)}`);
    const l1 = asRecord(asRecord(nestedOut, 'level 1')['level1'], 'level 1 body');
    const l2 = asRecord(l1['level2'], 'level 2 body');
    const l3 = asRecord(l2['level3'], 'level 3 body');
    const l4 = asRecord(l3['level4'], 'level 4 body');
    assert.equal(l1['keep'], 'a', 'a benign sibling at level 1 must survive');
    assert.equal(l2['keep'], 'b', 'a benign sibling at level 2 must survive');
    assert.equal(l3['keep'], 'c', 'a benign sibling at level 3 must survive');
    assert.equal(l4['keep'], 'd', 'a benign sibling at level 4 must survive');
    assert.equal(l4['leak'], REDACTION_MARKER, 'the redacted leaf must be the marker, so the field is visibly redacted');

    // An array element, and a mixed array proving non-string elements are untouched and ORDER holds.
    const list = [1, 'plain', secret, true, null, { note: `token=${secret}` }, ['inner', secret]];
    const listOut = redactInbound(list);
    assert.equal(leakContext(listOut, secret), '', `the sentinel survived inside an array: ${leakContext(listOut, secret)}`);
    assert.ok(Array.isArray(listOut), 'an array must redact to an array');
    assert.equal(listOut.length, list.length, 'array LENGTH is a structural fact and must not change');
    assert.equal(listOut[0], 1, 'a number element must survive unchanged');
    assert.equal(listOut[1], 'plain', 'a benign string element must survive unchanged');
    assert.equal(listOut[3], true, 'a boolean element must survive unchanged');
    assert.equal(listOut[4], null, 'null must survive as null, not become a string');
    assert.ok(Array.isArray(listOut[6]), 'a nested array must stay an array');

    // An error-detail bag: the shape `sanitizeDetails` is fed, where FR-SEC-3's own wording names
    // errors as a leak surface.
    const errorDetail = {
      code: 'agent-busy',
      message: 'provider refused: authorization failed',
      details: { authHeader: `Bearer ${secret}`, harmless: 'kept', retryAfterMs: 250 },
    };
    const errorOut = asRecord(redactInbound(errorDetail), 'the redacted error detail');
    assert.equal(leakContext(errorOut, secret), '', `the sentinel survived an error detail: ${leakContext(errorOut, secret)}`);
    assert.equal(errorOut['code'], 'agent-busy', 'the business code is what a caller matches on and must survive');
    assert.match(String(errorOut['message']), /provider refused/, 'the message must survive');
    const detailBag = asRecord(errorOut['details'], 'the redacted detail bag');
    assert.equal(detailBag['harmless'], 'kept', 'an ordinary detail field must survive');
    assert.equal(detailBag['retryAfterMs'], 250, 'a numeric detail must survive unchanged');
    assert.equal(detailBag['authHeader'], REDACTION_MARKER, 'a value whose NAME is a credential must be replaced wholesale');
  },

  'the sentinel is absent when it is planted in an object KEY, and the sibling fields survive': async () => {
    // A key is the position a values-only redactor cannot see. The coordinator's decision requires
    // the key SLOT to survive (so the object's shape and field count are intact) while the name
    // itself does not.
    const secret = sentinel('KEYNAME');
    const payload = { [secret]: 'value-under-a-credential-shaped-name', plain: 1, nested: { [secret]: secret } };
    const out = asRecord(redactInbound(payload), 'the redacted payload');
    assert.equal(leakContext(out, secret), '', `the sentinel survived as an object key: ${leakContext(out, secret)}`);
    assert.deepEqual(
      Object.keys(out).sort(),
      [REDACTION_MARKER, 'nested', 'plain'].sort(),
      'the credential-shaped key must be replaced, and the other keys must be untouched',
    );
    assert.equal(out['plain'], 1, 'a sibling field must survive a redacted key');
    assert.equal(out[REDACTION_MARKER], 'value-under-a-credential-shaped-name', 'the VALUE under a redacted key must survive: dropping it would damage structure');
    const nestedOut = asRecord(out['nested'], 'the nested object');
    assert.equal(nestedOut[REDACTION_MARKER], REDACTION_MARKER, 'a redacted key nested one level down must be redacted there too');

    // Two credential-shaped keys in ONE object collapse to the same marker. Neither may be dropped:
    // silently losing a field is the structural damage this boundary exists to prevent.
    const first = sentinel('COLLIDE-A');
    const second = sentinel('COLLIDE-B');
    const collided = asRecord(redactInbound({ [first]: 'first-value', [second]: 'second-value' }), 'the redacted collision payload');
    const collidedValues = Object.values(collided).sort();
    assert.deepEqual(collidedValues, ['first-value', 'second-value'], 'both values must survive the collision of two redacted key names');
    assert.equal(Object.keys(collided).length, 2, 'the field count must survive a key-name collision');
    assert.ok(
      Object.keys(collided).every((key) => key.startsWith(REDACTION_MARKER)),
      `both keys must be redacted; got ${JSON.stringify(Object.keys(collided))}`,
    );
  },

  'a benign string that resembles a credential survives, and here is which ones and why': async () => {
    // Without this case, a redactor that replaced every string with the marker would pass every
    // absence assertion in this file. Each entry names the shape element that is missing.
    const benign = [
      {
        text: `${['s', 'k'].join('')}-short`,
        why: 'the provider-token shape requires a body of at least 12 characters; this body is 5',
      },
      {
        text: 'Bearer tokens are accepted; see the docs',
        why: 'the keyword is present but the token-shaped body after it is 6 characters, below the same floor',
      },
      {
        text: 'Authorization is required for this endpoint',
        why: 'a credential NAME in prose has no value attached to it; the name-based rule applies to a property name, not to a sentence',
      },
      {
        text: 'Basic authentication failed',
        why: 'the Basic shape demands a mixed-case body of at least 12 characters; an all-lowercase word is not one',
      },
      {
        text: 'Basic tokens are accepted',
        why: 'the Basic shape demands a body of at least 12 characters; this body is 6',
      },
    ];
    for (const entry of benign) {
      assert.equal(redactInbound(entry.text), entry.text, `a benign string was redacted, which destroys the diagnosis: "${entry.text}" (${entry.why})`);
    }

    // Redaction must be TARGETED, not a blanket scrub of the object it lives in.
    const secret = sentinel('TARGETED');
    const payload = { note: benign[1].text, apiKey: secret, count: 3 };
    const out = asRecord(redactInbound(payload), 'the redacted payload');
    assert.equal(out['note'], benign[1].text, 'the benign sibling must survive in the same object as a real credential');
    assert.equal(out['count'], 3, 'a numeric sibling must survive');
    assert.equal(out['apiKey'], REDACTION_MARKER, 'the credential-valued field must not survive');
  },

  'the fields a replay reads are byte-identical before and after the boundary': async () => {
    // The whole point of the decision: redaction must be a mitigation for confidentiality that
    // costs nothing in replay fidelity. `JSON.stringify` equality is the strongest form of that
    // claim available here — not "deeply similar", byte-identical.
    const secret = sentinel('CONTROL');
    const control = {
      seq: 4102,
      sessionId: 'sess-0001',
      hostSessionId: 'host-0001',
      taskId: 'task-0001',
      kind: 'tool/call',
      type: 'session/event',
      outcome: 'completed',
      state: 'closed',
      turn: 3,
      eventId: 'evt-0001',
      payload: { type: 'tool/call', seq: 4102, input: { command: `echo ${secret}` } },
      queue: [{ itemId: 'item-a', placement: 'queued' }, { itemId: 'item-b', placement: 'steering' }],
    };
    const out = asRecord(redactInbound(control), 'the redacted payload');

    /**
     * The projection a replay actually reads. Typed over `unknown` values rather than `any` so the
     * helper cannot quietly accept a typo in a field name — the projection is the thing being
     * compared, so a name that read `undefined` on both sides would make the comparison vacuous.
     * @param {Record<string, unknown>} source
     * @returns {Record<string, unknown>}
     */
    const controlProjection = (source) => {
      /** @type {Record<string, unknown>} */
      const picked = {};
      for (const key of REPLAY_CONTROL_KEYS) picked[key] = source[key];
      picked['queue'] = source['queue'];
      return picked;
    };
    assert.equal(
      JSON.stringify(controlProjection(out)),
      JSON.stringify(controlProjection(control)),
      'a control field a replay reads changed across the boundary',
    );
    // Every projected name must actually EXIST in the fixture. Otherwise a typo in the list above
    // would read `undefined` on both sides and the comparison would pass while testing nothing.
    for (const key of REPLAY_CONTROL_KEYS) {
      assert.notEqual(control[key], undefined, `the fixture must carry the control field "${key}", or the comparison above is vacuous`);
      assert.notEqual(out[key], undefined, `the boundary dropped the control field "${key}"`);
    }
    assert.equal(leakContext(out, secret), '', `the sentinel survived the payload beside the control fields: ${leakContext(out, secret)}`);

    // And the policy itself must not treat those names as credential-bearing, so the guarantee is
    // visible in the policy rather than only in this instance of it.
    for (const key of REPLAY_CONTROL_KEYS) {
      assert.equal(isSensitiveKeyName(key), false, `the policy treats the replay-critical name "${key}" as a credential, which would rewrite control data`);
    }
    // The queue ORDER is control flow: a replay that reorders pending work is a different bridge.
    const queue = out['queue'];
    assert.ok(Array.isArray(queue), 'the queue must stay an array');
    assert.deepEqual(queue.map((item) => asRecord(item, 'a queue item')['itemId']), ['item-a', 'item-b'], 'queue order must survive');
  },

  'with redaction disabled the sentinel is still present, so a real failure would be observable': async () => {
    // The "gate proves it can fail" control. If the boundary were a no-op, every absence assertion
    // in this file would still pass; this case makes that impossible, because the SAME input run
    // through the SAME function must show the sentinel when the substitution is off.
    const secret = sentinel('DISABLED');
    const payload = { password: secret, nested: { note: `token=${secret}` }, [secret]: secret, seq: 7 };

    const disabled = redactInbound(payload, REDACTION_DISABLED_POLICY);
    const disabledText = JSON.stringify(disabled) ?? '';
    assert.ok(disabledText.includes(secret), 'with redaction disabled the sentinel MUST be present, or the absence assertions prove nothing');
    assert.equal(redactInbound(secret, REDACTION_DISABLED_POLICY), secret, 'a bare string must come back unchanged with redaction disabled');

    const enabled = redactInbound(payload);
    assert.equal(leakContext(enabled, secret), '', `the same payload must lose the sentinel with the default policy: ${leakContext(enabled, secret)}`);
    // The disabled policy switches off SUBSTITUTION only: the walk and its bounds still stand, which
    // is what keeps the control a control rather than a second, unrelated code path.
    const cyclic = { name: 'root' };
    cyclic.self = cyclic;
    const cyclicOut = asRecord(redactInbound(cyclic, REDACTION_DISABLED_POLICY), 'the control-policy redaction of a cycle');
    assert.equal(cyclicOut['self'], CYCLE_MARKER, 'the bounds must still apply with substitution disabled');
  },

  'redaction is deterministic and idempotent': async () => {
    const secret = sentinel('IDEMPOTENT');
    const payload = {
      seq: 12,
      sessionId: 'sess-0009',
      text: `authorization failed for ${secret}`,
      apiKey: secret,
      [secret]: ['a', secret, 5, { deep: secret }],
      plain: 'unchanged',
    };
    const once = redactInbound(payload);
    const again = redactInbound(payload);
    assert.deepEqual(once, again, 'the same input must redact to the same output every time');
    assert.equal(JSON.stringify(once), JSON.stringify(again), 'determinism must hold at the byte level, because replay compares bytes of state');
    // Idempotence: a replayed event that was already redacted on the way in must not change again.
    // This is the property that makes one boundary enough for live, storage and replay at once.
    assert.deepEqual(redactInbound(once), once, 'redacting an already-redacted payload must change nothing');
    assert.equal(leakContext(once, secret), '', 'the sentinel must be gone from the first pass');
    // And the markers themselves must not be treated as credential material anywhere in the walk.
    const markerText = asRecord(once, 'the redacted payload')['text'];
    assert.equal(redactInbound(markerText), markerText, 'text that already contains a marker must be stable under a second pass');
  },

  'a cyclic payload and a very deep payload terminate at the bound, and the bound is visible': async () => {
    const secret = sentinel('BOUNDS');

    // A cycle: the output must be finite and serialisable, because the very next step for a parsed
    // payload is `JSON.stringify` into the event archive.
    const cyclic = { name: 'root', leak: secret };
    cyclic.self = cyclic;
    const cyclicOut = asRecord(redactInbound(cyclic), 'the redacted cycle');
    assert.equal(cyclicOut['self'], CYCLE_MARKER, 'a back-reference to an ancestor must become the cycle marker, not hang or throw');
    assert.doesNotThrow(() => JSON.stringify(cyclicOut), 'the redacted cycle must be JSON-serialisable');
    assert.equal(leakContext(cyclicOut, secret), '', `the sentinel survived beside a cycle: ${leakContext(cyclicOut, secret)}`);

    // Depth: 200 levels of nesting must terminate, must show the marker exactly at the bound, and
    // must keep the levels above the bound intact.
    /** @type {unknown} */
    let deep = { name: 'leaf-level', leak: secret };
    for (let level = 0; level < 200; level += 1) deep = { child: deep };
    let cursor = redactInbound(deep);
    let levels = 0;
    while (cursor !== null && typeof cursor === 'object' && 'child' in cursor) {
      cursor = asRecord(cursor, 'a level of the redacted deep payload')['child'];
      levels += 1;
    }
    assert.equal(levels, MAX_DEPTH, `the depth bound must be observable at exactly maxDepth=${MAX_DEPTH}`);
    assert.equal(cursor, DEPTH_MARKER, 'the value at the bound must be the depth marker, so a truncated payload is visible rather than silent');

    // Nodes: a payload wider than the budget must stop, and the stop must be visible in the output.
    const wide = new Array(MAX_NODES + 64).fill('n');
    const wideOut = redactInbound(wide);
    assert.ok(Array.isArray(wideOut), 'a wide array must redact to an array');
    assert.ok(wideOut.length < wide.length, `the node bound must stop the walk (input ${wide.length}, output ${wideOut.length})`);
    assert.ok(wideOut.includes(NODE_LIMIT_MARKER), 'the node bound must be visible in the output');
    assert.ok(wideOut.length <= MAX_NODES + 1, `the walk must not exceed its budget (visited ${wideOut.length})`);

    // Totality: values this walk cannot even traverse must be reported as unreadable rather than
    // propagated, because it runs on the ingest path where a throw takes the daemon down.
    const hostile = {
      get boom() {
        throw new Error('an accessor that throws');
      },
      ok: 'fine',
    };
    const hostileOut = asRecord(redactInbound(hostile), 'the redacted hostile object');
    assert.equal(hostileOut['boom'], UNREADABLE_MARKER, 'an unreadable property must be marked, not thrown');
    assert.equal(hostileOut['ok'], 'fine', 'one poisoned property must not erase its siblings');
    const hostileProxy = new Proxy({}, {
      ownKeys() {
        throw new Error('a proxy that refuses enumeration');
      },
    });
    assert.equal(redactInbound(hostileProxy), UNREADABLE_MARKER, 'a value that cannot be enumerated at all must collapse to the marker, not throw');
    // Non-JSON leaves a caller might still hand in must pass through rather than become an exception.
    assert.equal(redactInbound(undefined), undefined, 'undefined must survive');
    assert.equal(redactInbound(0), 0, 'zero must survive');
    assert.equal(redactInbound(false), false, 'false must survive');
  },

  'LIMIT: a credential form outside the policy is NOT recognised, and this case states the limit': async () => {
    // This case exists so the file states the boundary's limit instead of implying omniscience. The
    // limit is chosen to be a REALISTIC miss: a 40-character hex blob is what a badly designed token,
    // a signing key fragment or a cookie value can look like, and the policy has no generic
    // high-entropy rule — deliberately, because such a rule cannot be falsified against a corpus and
    // would tear digests, ids and hashes out of the control surface. The ADR records this, and this
    // assertion is the measurement behind that sentence.
    //
    // If a future revision adds a shape that catches this, this case fails, and that failure is the
    // intended prompt to update the ADR rather than to weaken the assertion.
    const hexBlob = 'a1b2c3d4'.repeat(5);
    assert.match(hexBlob, /^[0-9a-f]{40}$/, 'this case is about a prefixed-shape-free hex blob; keep it exactly that');
    assert.equal(redactInbound(hexBlob), hexBlob, 'a bare 40-char hex string is NOT recognised by this policy (a stated limit)');
    const structured = asRecord(redactInbound({ note: hexBlob, list: [hexBlob], hash: { sha: hexBlob } }), 'the redacted payload');
    assert.equal(structured['note'], hexBlob, 'the hex blob must survive under a benign name (a stated limit)');
    assert.deepEqual(structured['list'], [hexBlob], 'the hex blob must survive in an array (a stated limit)');
    assert.equal(asRecord(structured['hash'], 'the hash bag')['sha'], hexBlob, 'the hex blob must survive under a benign key (a stated limit)');

    // The measurement that keeps the limit honest: the SAME positions remove a credential that IS in
    // the policy, so this case documents a gap rather than discovering a broken redactor.
    const secret = sentinel('LIMITCHECK');
    const withSecret = asRecord(redactInbound({ note: secret, list: [secret] }), 'the redacted payload');
    assert.equal(withSecret['note'], REDACTION_MARKER, 'the sentinel under the same benign name must be redacted');
    assert.deepEqual(withSecret['list'], [REDACTION_MARKER], 'the sentinel in the same array position must be redacted');

    // The other half of the limit, and the price this policy pays for closing the Basic-auth hole:
    // a mixed-case word after the word "Basic" satisfies the shape even when it is not a credential.
    // Recorded as a cost, not presented as a feature — a destroyed diagnostic is a real price.
    assert.equal(
      redactInbound('Basic AuthRetryExceeded'),
      REDACTION_MARKER,
      'a mixed-case word after "Basic" is redacted even when it is not a credential: the recorded cost of the Basic shape',
    );
  },

  'the shape set is a behavioural superset of the adapter\'s own, measured on one corpus': async () => {
    // `src/lib/adapter.ts` is the ANTECEDENT of this policy: it keeps its own (module-private)
    // pattern list, and this change may not edit it. So instead of asserting that the two lists are
    // identical — which nothing here can require — this case measures the property that matters:
    // wherever the adapter removes credential material from text, this boundary removes it too, and
    // in one named place it removes material the adapter leaves behind.
    const providerToken = sentinel('SUPERSET-TOKEN');
    const bearerToken = sentinel('SUPERSET-BEARER');
    const nameValueToken = sentinel('SUPERSET-PAIR');
    const gitToken = [['gh', 'p'].join(''), ['ZZBOUNDARY', 'git', 'abcdefghijklmnop'].join('-')].join('-');
    const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'ZZBOUNDARYJWT', 'c2lnbmF0dXJlMTIzNDU2'].join('.');
    // A Basic header built here from a made-up user:pass, so the base64 body in this file is an
    // encoding of synthetic text rather than a copied credential-shaped literal.
    const basicBody = Buffer.from('zzuser:zzpass', 'utf8').toString('base64');
    const corpus = [
      { label: 'provider-token', text: `provider refused: ${providerToken}`, body: providerToken },
      { label: 'bearer-header', text: `Authorization: Bearer ${bearerToken}`, body: bearerToken },
      { label: 'name-value-pair', text: `client_secret: ${nameValueToken}`, body: nameValueToken },
      { label: 'git-token', text: `remote refused: ${gitToken}`, body: gitToken },
      { label: 'jwt', text: `session token ${jwt} is expired`, body: jwt },
      { label: 'basic-header', text: `Authorization: Basic ${basicBody}`, body: basicBody },
    ];

    /** @type {string[]} */
    const adapterMisses = [];
    for (const entry of corpus) {
      // The adapter's own function is the reference for "what the antecedent set recognised".
      const adapterOut = redactCredentials(entry.text);
      const boundaryOut = String(redactInbound(entry.text));
      assert.ok(
        !boundaryOut.includes(entry.body),
        `the boundary left ${entry.label} material in text the adapter removed it from: ${leakContext(boundaryOut, entry.body)}`,
      );
      // Where the adapter does the job, the boundary must agree with it exactly, not merely also
      // remove something: a differing spelling of the marker would make the two redactors
      // indistinguishable from two policies.
      if (!adapterOut.includes(entry.body)) {
        assert.equal(boundaryOut, adapterOut, `on ${entry.label} the boundary must agree with the adapter that it supersedes`);
      } else {
        adapterMisses.push(entry.label);
      }
    }
    assert.ok(corpus.length >= 6, 'the corpus must exercise every shape the antecedent set claims');
    // Strictly stronger, in exactly one measured place. Without this assertion the case would pass
    // for an identical copy of the adapter's set, which would make "superset" an unearned word.
    assert.deepEqual(
      adapterMisses,
      ['basic-header'],
      `the boundary is expected to be strictly stronger than the adapter in exactly the Basic-auth shape; adapter missed ${JSON.stringify(adapterMisses)}`,
    );
    assert.ok(
      redactCredentials(corpus[5].text).includes(basicBody),
      'the premise of this case: the adapter does NOT recognise the Basic-auth shape (if this fails, the premise changed and the ADR needs updating)',
    );
  },

  'the boundary module carries no Node surface, so the contract side may import it': async () => {
    // ADR 0002 claims this module is usable from the contract/protocol surface. That claim has an
    // oracle: `tsconfig.contract.json` compiles with the Node type surface removed, and the module
    // would be a build failure there if it reached for Node — but it is not yet in that gate's
    // include list, so the property is asserted here instead of assumed. The check is on code
    // shapes, not on the words "process" or "Buffer" appearing in a comment that explains this rule.
    // The patterns match CODE shapes rather than the words themselves, and that is not pedantry: the
    // module's own header states this rule in prose ("no node:*, no Buffer, no process"), and a
    // word-matching check would fail on the sentence that documents it. The first version of this
    // case did exactly that, on "it may not lose the process." — which is why the shapes below end in
    // an identifier character.
    const forbidden = [
      { name: 'a node: import specifier', pattern: /from\s+['"]node:/ },
      { name: 'a dynamic node: import', pattern: /import\s*\(\s*['"]node:/ },
      { name: 'a node: require', pattern: /require\(\s*['"]node:/ },
      { name: 'a process property access', pattern: /\bprocess\.[A-Za-z_$]/ },
      { name: 'a Buffer construction', pattern: /\bBuffer\.[A-Za-z_$]|\bBuffer\s*\(/ },
      { name: 'a global process reference', pattern: /globalThis\s*\.\s*process/ },
    ];
    for (const file of ['src/lib/redact.ts', 'dist/lib/redact.js']) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      assert.ok(source.length > 0, `${file} must be readable and non-empty`);
      for (const rule of forbidden) {
        assert.ok(!rule.pattern.test(source), `${file} reaches for ${rule.name}, which the contract gate forbids`);
      }
    }
  },
};
