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
} satisfies Record<string, string>);

/** The id namespaces this bridge mints. */
export type IdKind = keyof typeof ID_KINDS;

const PREFIX: Readonly<Record<string, IdKind>> = Object.freeze(
  Object.fromEntries(
    Object.entries(ID_KINDS).map(([kind, prefix]) => [prefix, kind as IdKind]),
  ),
);

/**
 * Mint an id of a given kind.
 * @param kind id namespace
 * @returns `<prefix>_<uuid>`
 */
export function mintId(kind: IdKind): string {
  const prefix = ID_KINDS[kind];
  if (!prefix) throw new Error(`unknown id kind: ${String(kind)}`);
  return `${prefix}_${randomUUID()}`;
}

/** Result of parsing a candidate id. */
export type ParsedId =
  | { readonly ok: true; readonly kind: IdKind; readonly id: string }
  | { readonly ok: false; readonly reason: string };

/**
 * Validate an id string and report the kind it actually is.
 * @param value candidate id
 */
export function parseId(value: unknown): ParsedId {
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
 * Assert an id is of an expected kind.
 * @param value candidate id
 * @param kind expected kind
 * @returns the id, unchanged
 * @throws {Error} when the id is malformed or belongs to another namespace
 */
export function assertIdKind(value: unknown, kind: IdKind): string {
  const parsed = parseId(value);
  if (!parsed.ok) throw new Error(`invalid id (${parsed.reason}): ${String(value).slice(0, 64)}`);
  if (parsed.kind !== kind) throw new Error(`expected ${kind} id, got ${parsed.kind}`);
  return parsed.id;
}

/** Is this a usable DSH session id? Host ids are opaque strings of this shape. */
export function isHostSessionId(value: unknown): value is string {
  return typeof value === 'string' && /^session-[0-9a-zA-Z-]{8,}$/.test(value);
}

/** Result of validating a caller-supplied idempotency key. */
export type KeyVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * A caller-supplied idempotency key must be a bounded, printable token: it is stored in
 * SQLite and echoed in errors, so control characters and unbounded length are refused.
 * @param key candidate
 */
export function isIdempotencyKey(key: unknown): KeyVerdict {
  if (typeof key !== 'string') return { ok: false, reason: 'not-a-string' };
  if (key.length < 8 || key.length > 200) return { ok: false, reason: 'length' };
  if (!/^[A-Za-z0-9._:/-]+$/.test(key)) return { ok: false, reason: 'charset' };
  return { ok: true };
}

/**
 * Stable digest of a request payload, used to detect "same key, different payload".
 * Canonicalises key order so an equivalent payload does not look like a conflict.
 * @param value payload
 * @returns hex sha256
 */
export function payloadDigest(value: unknown): string {
  return createDigest(canonicalJson(value));
}

/** Canonical JSON: sorted object keys, no undefined, deterministic number formatting. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((k) => record[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

/** Hex sha256 of a UTF-8 string. */
export function createDigest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}
