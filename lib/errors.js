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
});

const CODE_SET = new Set(Object.values(ERROR_CODES));

/** Error carrying a stable code plus structured, redaction-safe details. */
export class BridgeError extends Error {
  /**
   * @param {string} code one of ERROR_CODES
   * @param {string} message human-readable, must not contain secrets
   * @param {object} [details] structured details, must be JSON-serializable
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/**
 * Assert a value is a known error code.
 * @param {string} code candidate
 * @returns {string} the code
 */
export function assertKnownCode(code) {
  if (!CODE_SET.has(code)) {
    throw new BridgeError(ERROR_CODES.INTERNAL, `unknown error code: ${code}`);
  }
  return code;
}

/**
 * Fold any thrown value into a BridgeError without leaking a raw stack as the message.
 * @param {unknown} error thrown value
 * @returns {BridgeError}
 */
export function toBridgeError(error) {
  if (error instanceof BridgeError) return error;
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    const code = ERROR_CODES[error.code] ? error.code : ERROR_CODES.INTERNAL;
    return new BridgeError(code, String(error.message ?? error.code), {});
  }
  const message = error instanceof Error ? error.message : String(error);
  return new BridgeError(ERROR_CODES.INTERNAL, message);
}

/** Machine-readable result for a mutating or querying operation. */
export class Result {
  /**
   * @param {'ok'|'refused'|'uncertain'} status outcome class
   * @param {object} [fields] status-specific fields
   */
  constructor(status, fields = {}) {
    this.status = status;
    Object.assign(this, fields);
  }
  get ok() { return this.status === 'ok'; }
  get uncertain() { return this.status === 'uncertain'; }
  get refused() { return this.status === 'refused'; }
  toJSON() {
    const { status, ...rest } = this;
    return { status, ...rest };
  }
}

/** @returns {Result} */
export const ok = (fields) => new Result('ok', fields);
/** @returns {Result} */
export const refused = (error) => new Result('refused', { error: toBridgeError(error).toJSON() });
/** @returns {Result} */
export const uncertain = (reason, details = {}) => new Result('uncertain', { reason, ...details });
