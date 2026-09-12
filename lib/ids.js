/**
 * Identifier minting and validation.
 *
 * Why this file exists: the design requires *separate* namespaces for task, session, turn,
 * operation, interaction and event ids, plus a stable Host namespace carrying native DSH ids.
 * Mixing those spaces is how a bridge ends up answering the wrong turn, so each kind has its
 * own prefix, its own validator, and a test that rejects cross-kind use.
 *
 * Ids are collision-resistant (crypto.randomUUID) and carry no secret and no absolute path.
 */

import { createHash, randomUUID } from 'node:crypto';

/** Id kinds, each with its own prefix. */
export const ID_KINDS = Object.freeze({
  task: 'task',
  session: 'sess',
  turn: 'turn',
  operation: 'op',
  interaction: 'int',
  event: 'evt',
  host: 'host',
  gateway: 'gw',
});

const PREFIX = Object.freeze(Object.fromEntries(
  Object.entries(ID_KINDS).map(([kind, prefix]) => [prefix, kind]),
));

/**
 * Mint an id of a given kind.
 * @param {keyof ID_KINDS} kind id namespace
 * @returns {string} `<prefix>_<uuid>`
 */
export function mintId(kind) {
  const prefix = ID_KINDS[kind];
  if (!prefix) throw new Error(`unknown id kind: ${kind}`);
  return `${prefix}_${randomUUID()}`;
}

/**
 * Validate an id string and report the kind it actually is.
 * @param {string} value candidate id
 * @returns {{ok: true, kind: string, id: string} | {ok: false, reason: string}}
 */
export function parseId(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'not-a-string' };
  const separator = value.indexOf('_');
  if (separator <= 0) return { ok: false, reason: 'missing-prefix' };
  const prefix = value.slice(0, separator);
  const kind = PREFIX[prefix];
  if (!kind) return { ok: false, reason: 'unknown-prefix' };
  const body = value.slice(separator + 1);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body)) {
    return { ok: false, reason: 'malformed-uuid' };
  }
  return { ok: true, kind, id: value };
}

/**
 * Assert an id is of an expected kind; throws a typed error otherwise.
 * @param {string} value candidate id
 * @param {keyof ID_KINDS} kind expected kind
 * @returns {string} the id
 */
export function assertIdKind(value, kind) {
  const parsed = parseId(value);
  if (!parsed.ok) throw new Error(`invalid id (${parsed.reason}): ${String(value).slice(0, 64)}`);
  if (parsed.kind !== kind) throw new Error(`expected ${kind} id, got ${parsed.kind}`);
  return value;
}

/** Is this a usable DSH session id? Host ids are opaque strings of this shape. */
export function isHostSessionId(value) {
  return typeof value === 'string' && /^session-[0-9a-zA-Z-]{8,}$/.test(value);
}

/**
 * A caller-supplied idempotency key must be a bounded, printable token: it is stored in
 * SQLite and echoed in errors, so control characters and unbounded length are refused.
 * @param {string} key candidate
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function isIdempotencyKey(key) {
  if (typeof key !== 'string') return { ok: false, reason: 'not-a-string' };
  if (key.length < 8 || key.length > 200) return { ok: false, reason: 'length' };
  if (!/^[A-Za-z0-9._:/-]+$/.test(key)) return { ok: false, reason: 'charset' };
  return { ok: true };
}

/**
 * Stable digest of a request payload, used to detect "same key, different payload".
 * Canonicalises key order so an equivalent payload does not look like a conflict.
 * @param {unknown} value payload
 * @returns {string} hex sha256
 */
export function payloadDigest(value) {
  return createDigest(canonicalJson(value));
}

/** Canonical JSON: sorted object keys, no undefined, deterministic number formatting. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

/**
 * @param {string} text input
 * @returns {string} hex sha256 digest
 */
export function createDigest(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
