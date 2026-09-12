/**
 * Error taxonomy for dsh-pilot.
 *
 * Why this file exists: every layer must report failure with a stable, machine-readable
 * code, because the MCP face, the CLI and the tests all switch on it. A stringly-typed
 * "something went wrong" would make the uncertain/refused distinction untestable.
 *
 * Codes are deliberately grouped by the layer that owns them, and every code here is
 * asserted by a test in test/unit.
 */

/** All error codes the bridge may emit. Closed set: adding one requires a test. */
export const ERROR_CODES = Object.freeze({
  // Input / usage
  BAD_REQUEST: 'BAD_REQUEST',
  UNSUPPORTED: 'UNSUPPORTED',
  CONFLICT: 'CONFLICT',

  // Identity / state
  NOT_FOUND: 'NOT_FOUND',
  ILLEGAL_TRANSITION: 'ILLEGAL_TRANSITION',

  // Ownership
  OWNER_HELD: 'OWNER_HELD',
  OWNER_LOST: 'OWNER_LOST',

  // Storage
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  STORAGE_CORRUPT: 'STORAGE_CORRUPT',
  STORAGE_FULL: 'STORAGE_FULL',
  STATE_VERSION_UNSUPPORTED: 'STATE_VERSION_UNSUPPORTED',
  BUSY: 'BUSY',

  // Host / carrier
  HOST_UNREACHABLE: 'HOST_UNREACHABLE',
  HOST_REFUSED: 'HOST_REFUSED',
  HOST_PROTOCOL: 'HOST_PROTOCOL',
  ENVELOPE_MISMATCH: 'ENVELOPE_MISMATCH',
  OVERSIZE: 'OVERSIZE',
  FRAME_MALFORMED: 'FRAME_MALFORMED',
  FRAME_GAP: 'FRAME_GAP',
  CURSOR_EXPIRED: 'CURSOR_EXPIRED',

  // Outcome semantics — the load-bearing distinction
  UNCERTAIN: 'UNCERTAIN',
  SESSION_CONFLICT: 'SESSION_CONFLICT',

  // Approvals / cancellation
  APPROVAL_STALE: 'APPROVAL_STALE',
  APPROVAL_REPLAYED: 'APPROVAL_REPLAYED',
  APPROVAL_UNAUTHORIZED: 'APPROVAL_UNAUTHORIZED',
  CANCEL_AMBIGUOUS: 'CANCEL_AMBIGUOUS',
  CANCEL_UNOBSERVED: 'CANCEL_UNOBSERVED',

  // Resource bounds
  RESULT_TOO_LARGE: 'RESULT_TOO_LARGE',
  BUFFER_OVERFLOW: 'BUFFER_OVERFLOW',

  // Internal
  INTERNAL: 'INTERNAL',
} satisfies Record<string, string>);

/** The closed set above, as a type. Only `assertKnownCode` mints one. */
export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Membership of a candidate string against the closed code set. The set holds plain strings
 * because that is what `assertKnownCode` is handed and tests are a runtime membership check.
 */
const CODE_SET: ReadonlySet<string> = new Set(Object.values(ERROR_CODES));

/**
 * The same frozen object, read as a lookup table keyed by an arbitrary string. Membership was
 * originally tested by property lookup (`ERROR_CODES[code]`), which a variable string cannot
 * index without an implicit `any`; this view states the same read — including the prototype
 * chain it walks — so the expression below is unchanged rather than re-implemented.
 */
const CODE_TABLE: Readonly<Record<string, string | undefined>> = ERROR_CODES;

/** Structured, JSON-serializable and redaction-safe details attached to a `BridgeError`. */
export type ErrorDetails = Record<string, unknown>;

/** Narrows a candidate to the closed code set, so the assertion below can return the union. */
function isErrorCode(code: string): code is ErrorCode {
  return CODE_SET.has(code);
}

/** Error carrying a stable code plus structured, redaction-safe details. */
export class BridgeError extends Error {
  /**
   * Read as `string`, not as `ErrorCode`: the code is one of ERROR_CODES by contract, but
   * `toBridgeError` and the IPC reply path forward a `code` they did not author, and a
   * migration must not add validation the original did not perform.
   */
  readonly code: string;
  readonly details: ErrorDetails;

  /**
   * @param code one of ERROR_CODES
   * @param message human-readable, must not contain secrets
   * @param details structured details, must be JSON-serializable
   */
  constructor(code: string, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }

  toJSON(): { readonly code: string; readonly message: string; readonly details: ErrorDetails } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * Assert a value is a known error code.
 * @param code candidate
 * @returns the code
 */
export function assertKnownCode(code: string): ErrorCode {
  if (!isErrorCode(code)) {
    throw new BridgeError(ERROR_CODES.INTERNAL, `unknown error code: ${code}`);
  }
  return code;
}

/**
 * Fold any thrown value into a BridgeError without leaking a raw stack as the message.
 * @param error thrown value
 */
export function toBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) return error;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    // `CODE_SET.has` rather than a table lookup, and this is a FIX, not a port.
    //
    // A plain `ERROR_CODES[error.code]` walks the prototype chain, so a peer-supplied
    // `{code: 'toString'}` (or `'constructor'`, `'hasOwnProperty'`) reads as a known code and mints a
    // BridgeError whose `code` is outside the closed set this module's header asserts. That set is
    // load-bearing: `PINNED_ERROR_CODES`, the JSON-RPC mapping and the capability reporting all treat
    // an unrecognised code as a capability signal, so a prototype name leaking through silently
    // mislabels a defect as a known outcome. The value was already reachable wherever a foreign error
    // object is folded — which is every IPC and MCP client boundary.
    const code = CODE_SET.has(error.code) ? error.code : ERROR_CODES.INTERNAL;
    // A `code`-bearing object is not necessarily an Error, so `message` is read structurally. The
    // nullish check is `== null` rather than `'message' in error` alone, because an explicit
    // `{message: null, code: 'ENOENT'}` must still report the CODE: testing only for the property's
    // presence turned that into the string "null", which is a worse message than the one it replaced.
    const raw = 'message' in error ? error.message : error.code;
    const message = raw == null ? error.code : raw;
    return new BridgeError(code, String(message), {});
  }
  const message = error instanceof Error ? error.message : String(error);
  return new BridgeError(ERROR_CODES.INTERNAL, message);
}

/** Outcome class of a result: the distinction between "refused" and "we do not know". */
export type ResultStatus = 'ok' | 'refused' | 'uncertain';

/** Machine-readable result for a mutating or querying operation. */
export class Result {
  /**
   * The constructor merges status-specific fields onto the instance (`value` on ok, `error` on
   * refused, `reason` plus details on uncertain), so the instance is structurally a record with
   * those fields at runtime. The index signature states exactly that, with `unknown` values:
   * a reader must narrow a field before using it, which is what the untyped original did not.
   */
  [field: string]: unknown;
  readonly status: ResultStatus;

  /**
   * @param status outcome class
   * @param fields status-specific fields
   */
  constructor(status: ResultStatus, fields: Record<string, unknown> = {}) {
    this.status = status;
    Object.assign(this, fields);
  }
  get ok(): boolean { return this.status === 'ok'; }
  get uncertain(): boolean { return this.status === 'uncertain'; }
  get refused(): boolean { return this.status === 'refused'; }
  toJSON(): Record<string, unknown> {
    const { status, ...rest } = this;
    return { status, ...rest };
  }
}

export const ok = (fields?: Record<string, unknown>): Result => new Result('ok', fields);
export const refused = (error: unknown): Result => new Result('refused', { error: toBridgeError(error).toJSON() });
export const uncertain = (reason: string, details: Record<string, unknown> = {}): Result => new Result('uncertain', { reason, ...details });
