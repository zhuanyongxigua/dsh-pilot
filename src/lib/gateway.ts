/**
 * MCP face: a real Model Context Protocol server over stdio.
 *
 * Why this file exists: the caller is an MCP client (an agent harness), and DSH is the
 * *controlled system* behind us — not our consumer. The direction is therefore
 *   caller (GPT/Codex/any MCP client) -> THIS bridge -> DSH Host
 * which is why this file talks MCP upward and IPC downward, and never touches the Host's
 * wire format itself.
 *
 * Framing and handshake are implemented directly against the MCP specification
 * (newline-delimited JSON-RPC 2.0 on stdin/stdout, `initialize` -> `tools/list` -> `tools/call`,
 * `notifications/cancelled`), because the protocol here is small, fully specified, and this
 * project runs on zero runtime dependencies. Each declared tool is backed by a daemon IPC op,
 * and its input schema is strict: unknown properties and wrong types are refused before any
 * request can reach the daemon, so a malformed call can never mutate durable state.
 *
 * In particular there is NO approval tool: approving is human authority, reached through a
 * separate operator channel, so a model can never authorize itself.
 */

import { BridgeError, ERROR_CODES } from './errors.ts';
import { IpcClient } from './ipc.ts';
import { MCP_TOOLS, validateToolInput, toolByName } from './mcp-tools.ts';
import { MCP_PROTOCOL_VERSION, SERVER_INFO, jsonRpcCode } from './mcp-protocol.ts';

// Re-exported so existing importers keep working, but DEFINED in `src/lib/mcp-protocol.ts`: that module is
// part of the Node-free contract surface this repository gates, and this file is the stdio transport.
export { MCP_PROTOCOL_VERSION, SERVER_INFO };

/**
 * Structural shapes for the process facilities this loop needs.
 *
 * They are declared here instead of referencing `NodeJS.*` or reading `process` directly because
 * AGENTS.md section 4 forbids Node-only APIs in protocol code, and `tsconfig.contract.json` checks
 * it. The stdio face genuinely needs a readable stream, a writable stream, a pid for its status
 * payload, and a way to learn that the process was asked to stop — but it needs those as VALUES, so
 * the entry point supplies them and this module stays free of the Node global object.
 *
 * `setEncoding` names the encodings inline rather than using Node's `BufferEncoding` type, because that
 * type does not exist once the contract config removes the Node type surface — and importing it would be
 * exactly the dependency this file is required not to have.
 */

/**
 * A readable stream, as a value: `data` listeners receive the decoded string, because the loop calls
 * `setEncoding('utf8')` before subscribing.
 */
export interface ReadableLike {
  on(event: string, listener: (chunk: string) => void): unknown;
  removeListener?(event: string, listener: (chunk: string) => void): unknown;
  setEncoding?(encoding: StreamEncoding): unknown;
}

/** The encodings {@link ReadableLike.setEncoding} accepts, named here rather than imported. */
export type StreamEncoding = 'utf8' | 'utf-8' | 'ascii' | 'latin1' | 'utf16le';

/** A writable stream, as a value. */
export interface WritableLike {
  write(chunk: string): unknown;
}

/** Every process facility the loop needs, supplied by the entry point instead of read from globals. */
export interface GatewayIo {
  readonly input: ReadableLike;
  readonly output: WritableLike;
  readonly pid: number | null;
  readonly onSignal?: (name: 'SIGTERM' | 'SIGINT', handler: () => void) => void;
}

/** Options of {@link runMcpGateway}. */
export interface RunMcpGatewayOptions {
  readonly socketPath: string;
  readonly io: GatewayIo;
}

/** What the loop reports when it ends: why it stopped, and what it served. */
export interface GatewayOutcome {
  readonly reason: string;
  readonly requests: number;
  readonly rejectedToolCalls: number;
}

/** The counters this process adds to the daemon's own status reply. */
export interface GatewayCounters {
  readonly pid: number | null;
  readonly requests: number;
  readonly rejectedToolCalls: number;
}

/**
 * One parsed incoming JSON-RPC message. The line is parsed JSON, so every member is `unknown` and
 * is narrowed at the point of use, exactly as the untyped original did.
 */
interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: JsonRpcParams | null;
}

/** The `params` member of a request or notification, as this loop reads it. */
interface JsonRpcParams {
  readonly name?: unknown;
  readonly arguments?: unknown;
  readonly requestId?: unknown;
}

/**
 * Run the MCP server loop against a daemon socket.
 *
 * `io` carries every process facility the loop needs. A real entry point passes
 * `{input: process.stdin, output: process.stdout, pid: process.pid, onSignal: ...}`; a test passes a
 * pair of in-memory streams, which is what makes the stdio protocol face testable without spawning a
 * process. The loop does not read the Node global object itself — see the types declared above.
 *
 * @param options
 * @param options.socketPath daemon IPC socket
 * @param options.io process facilities, supplied by the entry point
 * @returns resolves when the loop ends
 */
export async function runMcpGateway({ socketPath, io }: RunMcpGatewayOptions): Promise<GatewayOutcome> {
  if (!io || !io.input || !io.output) {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, 'runMcpGateway requires {io:{input,output,pid}}', { socketPath });
  }
  const { input, output } = io;
  let ipc: IpcClient;
  try {
    ipc = new IpcClient({ socketPath });
    await ipc.ready();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BridgeError(ERROR_CODES.HOST_UNREACHABLE, `cannot reach the dsh-pilot daemon: ${detail}`, { socketPath });
  }

  let buffer = '';
  let requests = 0;
  /** Tool calls refused before or instead of reaching the daemon; reported for diagnosis. */
  let rejectedToolCalls = 0;
  const cancelled = new Set<unknown>();
  // `ended` is assigned by the promise executor below, which runs synchronously, so it is set before
  // any listener can fire; the optional calls state that ordering instead of asserting it.
  let ended: ((reason: string) => void) | null = null;
  const done = new Promise<string>((resolve) => { ended = resolve; });

  const send = (message: unknown): void => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  const reply = (id: unknown, result: unknown): void => send({ jsonrpc: '2.0', id, result });
  const fail = (id: unknown, code: number, message: string, data?: unknown): void => send({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

  /**
   * Translate a daemon/BridgeError into a JSON-RPC error without leaking internals.
   * @param id
   * @param error
   */
  const failFromError = (id: unknown, error: unknown): void => {
    const bridgeError = error instanceof BridgeError
      ? error
      : new BridgeError(ERROR_CODES.INTERNAL, error instanceof Error ? error.message : String(error), {});
    // The mapping itself lives in `src/lib/mcp-protocol.ts`, because it is protocol contract rather than
    // transport detail: -32602 invalid params, -32601 method not found, -32603 internal.
    const code = jsonRpcCode(bridgeError.code);
    fail(id, code, bridgeError.message, { bridgeCode: bridgeError.code, details: bridgeError.details });
  };

  /**
   * @param message parsed JSON-RPC request
   */
  const handleRequest = async (message: JsonRpcMessage): Promise<void> => {
    requests += 1;
    const { id, method, params } = message;
    if (typeof method !== 'string') {
      // An id without a method is an invalid request, not a method we do not know.
      fail(id ?? null, -32600, 'invalid request: method must be a string');
      return;
    }
    if (method === 'initialize') {
      reply(id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Durable DSH session control. Approval decisions are NOT available here by design; they require the operator authority channel.',
      });
      return;
    }
    if (method === 'ping') { reply(id, {}); return; }
    if (method === 'tools/list') {
      reply(id, { tools: MCP_TOOLS });
      return;
    }
    if (method === 'tools/call') {
      const name = params?.name;
      // `params` is parsed JSON, so `name` is `unknown` here. `toolByName` compares it against the
      // declared tool names, where a non-string simply matches none — the narrowing says so, and the
      // `!tool` branch below is reached exactly as it was.
      const tool = typeof name === 'string' ? toolByName(name) : null;
      if (!tool) {
        rejectedToolCalls += 1;
        fail(id, -32601, `unknown tool: ${String(name)}`);
        return;
      }
      const validation = validateToolInput(tool, params?.arguments ?? {});
      if (!validation.ok) {
        rejectedToolCalls += 1;
        fail(id, -32602, `invalid arguments for ${tool.name}: ${validation.errors.join('; ')}`, {
          tool: tool.name, errors: validation.errors,
        });
        return;
      }
      try {
        const value = await ipc.request(validation.request);
        // The gateway's own counters ride along with the daemon's status so a caller can see
        // how many calls this process refused without a second channel.
        if (tool.name === 'dsh_daemon_status') {
          // `ipc.request` resolves to parsed JSON written by our own daemon. A non-object reply is
          // not a status this loop can annotate, and the original failed here too (a property write
          // on a non-object throws); the catch below maps either failure to INTERNAL.
          if (!isRecord(value)) throw new TypeError('gateway counters require an object status reply');
          value.gateway = { pid: io.pid ?? null, requests, rejectedToolCalls } satisfies GatewayCounters;
        }
        reply(id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          structuredContent: value,
          // An uncertain outcome is NOT success: it must be flagged so a caller cannot
          // mistake "we do not know" for "it worked".
          isError: isNotSuccess(value),
        });
      } catch (error) {
        rejectedToolCalls += 1;
        failFromError(id, error);
      }
      return;
    }
    if (method === 'notifications/cancelled') {
      const cancelledId = params?.requestId;
      if (cancelledId !== undefined) cancelled.add(cancelledId);
      return;
    }
    fail(id, -32601, `method not supported: ${String(method)}`);
  };

  const onData = (chunk: string): void => {
    buffer += chunk;
    if (buffer.length > 4 * 1024 * 1024) {
      fail(null, -32600, 'input line exceeds the 4MiB limit');
      buffer = '';
      return;
    }
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (line.trim() === '') continue;
      let message: JsonRpcMessage;
      try {
        message = JSON.parse(line);
      } catch {
        fail(null, -32700, 'parse error');
        continue;
      }
      if (message.method && message.id === undefined) {
        // Client notification: handle inline, no reply.
        if (message.method === 'notifications/cancelled') {
          if (message.params?.requestId !== undefined) cancelled.add(message.params.requestId);
        } else if (message.method === 'notifications/initialized') {
          // No state to change; the handshake is complete.
        }
        continue;
      }
      if (cancelled.has(message.id)) {
        cancelled.delete(message.id);
        fail(message.id, -32800, 'request cancelled');
        continue;
      }
      handleRequest(message).catch((error) => failFromError(message.id, error));
    }
  };

  input.setEncoding?.('utf8');
  input.on('data', onData);
  input.on('end', () => ended?.('stdin-closed'));
  input.on('close', () => ended?.('stdin-closed'));
  // The signal wiring is the entry point's job, so this module never touches `process`.
  io.onSignal?.('SIGTERM', () => ended?.('sigterm'));
  io.onSignal?.('SIGINT', () => ended?.('sigint'));

  const reason = await done;
  ipc.close();
  return { reason, requests, rejectedToolCalls };
}

/**
 * Is this parsed JSON a string-keyed bag? The predicate is the check the `unknown` boundary needs:
 * it converts nothing, and a primitive or `null` is simply not one.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * Decide whether a daemon reply means "this did not succeed".
 *
 * The three outcomes a caller must be able to tell apart are NOT SENT, SENT AND CONFIRMED, and
 * SENT WITH UNKNOWN OUTCOME. Only the middle one may be reported as a success, so both
 * refusals and uncertainty are flagged as errors. Guessing either way would be a lie about
 * whether work may have happened.
 * @param value
 */
function isNotSuccess(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.outcome === 'uncertain') return true;
  const operation = value.operation;
  if (isRecord(operation) && (operation.state === 'uncertain' || operation.state === 'refused' || operation.state === 'failed')) return true;
  const result = value.result;
  if (isRecord(result) && (result.status === 'uncertain' || result.status === 'refused')) return true;
  return false;
}
