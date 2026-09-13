/**
 * MCP protocol constants and the JSON-RPC error mapping.
 *
 * Why this file exists as its own module rather than living in `src/lib/gateway.ts`: AGENTS.md section 4
 * requires contract and protocol code to stay free of Node-only APIs, and `npm run typecheck:contract`
 * enforces that by compiling the protocol modules with the Node type surface switched off. The stdio
 * loop in `src/lib/gateway.ts` genuinely needs a readable stream, a writable stream, a pid and signal
 * wiring, so anything defined in that file is unavoidably outside the gate.
 *
 * Splitting the wire shapes out is what makes the rule checkable in practice instead of nominal: this
 * module, `src/lib/errors.ts` and `src/lib/mcp-tools.ts` are the protocol surface, they are the things the
 * contract gate compiles, and a `process`/`Buffer`/`node:*` reference added to any of them fails the
 * build. `src/lib/gateway.ts` is the stdio TRANSPORT and is checked by the ordinary config, where needing
 * streams is not a violation.
 */

import { BridgeError, toBridgeError, type ErrorDetails } from './errors.ts';

/** Protocol revision this server implements. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';

/** Server identity reported during initialize. */
export const SERVER_INFO = Object.freeze({ name: 'dsh-pilot', version: '0.1.0' } satisfies Record<string, string>);

/**
 * A JSON-RPC error object as an MCP client reads it. `data` is always present rather than optional:
 * the client branches on the bridge's own code and the structured details, not on the prose, so a
 * reply without them would be a reply the caller cannot act on.
 */
export interface JsonRpcErrorObject {
  readonly code: number;
  readonly message: string;
  readonly data: { readonly code: string; readonly details: ErrorDetails };
}

/**
 * Map a failure to a JSON-RPC error object.
 *
 * Kept here, not in the transport, because the mapping IS the protocol contract: a client distinguishes
 * failures by `code` and the machine-readable `data`, so the shape must not depend on how the message
 * arrived. Every bridge error code gets its own numeric JSON-RPC code so a caller can branch on it
 * without parsing prose.
 *
 * @param error any thrown value
 * @returns the JSON-RPC error object a client reads
 */
export function jsonRpcErrorFor(error: unknown): JsonRpcErrorObject {
  const bridgeError = error instanceof BridgeError ? error : toBridgeError(error);
  return {
    code: jsonRpcCode(bridgeError.code),
    message: `${bridgeError.code}: ${bridgeError.message}`,
    data: { code: bridgeError.code, details: bridgeError.details ?? {} },
  };
}

/**
 * JSON-RPC numeric code for a bridge error code.
 *
 * `-32602 Invalid params` is used for anything the CALLER got wrong, `-32601 Method not found` for a
 * capability the Host does not expose, and `-32603 Internal error` for our own or storage failures —
 * the three distinctions an MCP client can act on differently.
 *
 * The parameter is `string`, not the closed `ErrorCode` union: the code arrives on `BridgeError`,
 * whose `code` is deliberately read as a plain string because the IPC reply path forwards a code it
 * did not author. An unrecognised code falls to `-32603` here, which is what the original did.
 * @param code a bridge error code
 * @returns the numeric JSON-RPC code
 */
export function jsonRpcCode(code: string): number {
  switch (code) {
    case 'BAD_REQUEST':
    case 'CONFLICT':
    case 'NOT_FOUND':
    case 'ILLEGAL_TRANSITION':
    // The caller passed a workspace this process cannot use. That is an argument error, and a caller can
    // only act on it if it is told so: the default arm would report it as our internal failure.
    case 'WORKSPACE_UNSAFE':
      return -32602;
    case 'UNSUPPORTED':
      return -32601;
    default:
      return -32603;
  }
}
