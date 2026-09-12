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

import { BridgeError, ERROR_CODES } from './errors.js';
import { IpcClient } from './ipc.js';
import { MCP_TOOLS, validateToolInput, toolByName } from './mcp-tools.js';

/** Protocol revision this server implements. */
export const MCP_PROTOCOL_VERSION = '2024-11-05';
/** Server identity reported during initialize. */
export const SERVER_INFO = Object.freeze({ name: 'dsh-pilot', version: '0.1.0' });

/**
 * Run the MCP server loop against a daemon socket.
 * @param {object} options
 * @param {string} options.socketPath daemon IPC socket
 * @param {NodeJS.ReadableStream} [options.input]
 * @param {NodeJS.WritableStream} [options.output]
 * @returns {Promise<{reason: string, requests: number}>} resolves when the loop ends
 */
export async function runMcpGateway({ socketPath, input = process.stdin, output = process.stdout }) {
  let ipc;
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
  const cancelled = new Set();
  let ended = null;
  const done = new Promise((resolve) => { ended = resolve; });

  const send = (message) => {
    output.write(`${JSON.stringify(message)}\n`);
  };

  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message, data) => send({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });

  /**
   * Translate a daemon/BridgeError into a JSON-RPC error without leaking internals.
   * @param {string|number|null} id
   * @param {unknown} error
   */
  const failFromError = (id, error) => {
    const bridgeError = error instanceof BridgeError
      ? error
      : new BridgeError(ERROR_CODES.INTERNAL, error instanceof Error ? error.message : String(error), {});
    // -32602 invalid params, -32601 method not found, -32603 internal, -32000 application
    const code = bridgeError.code === ERROR_CODES.BAD_REQUEST ? -32602
      : bridgeError.code === ERROR_CODES.UNSUPPORTED ? -32601
        : bridgeError.code === ERROR_CODES.INTERNAL ? -32603
          : -32000;
    fail(id, code, bridgeError.message, { bridgeCode: bridgeError.code, details: bridgeError.details });
  };

  /**
   * @param {object} message parsed JSON-RPC request
   */
  const handleRequest = async (message) => {
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
      const tool = toolByName(name);
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
          value.gateway = { pid: process.pid, requests, rejectedToolCalls };
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

  const onData = (chunk) => {
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
      let message;
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
  input.on('end', () => ended('stdin-closed'));
  input.on('close', () => ended('stdin-closed'));
  process.on('SIGTERM', () => ended('sigterm'));
  process.on('SIGINT', () => ended('sigint'));

  const reason = await done;
  ipc.close();
  return { reason, requests, rejectedToolCalls };
}

/**
 * Decide whether a daemon reply means "this did not succeed".
 *
 * The three outcomes a caller must be able to tell apart are NOT SENT, SENT AND CONFIRMED, and
 * SENT WITH UNKNOWN OUTCOME. Only the middle one may be reported as a success, so both
 * refusals and uncertainty are flagged as errors. Guessing either way would be a lie about
 * whether work may have happened.
 * @param {unknown} value
 */
function isNotSuccess(value) {
  if (value === null || typeof value !== 'object') return false;
  const record = /** @type {Record<string, unknown>} */ (value);
  if (record.outcome === 'uncertain') return true;
  const operation = /** @type {Record<string, unknown>|undefined} */ (record.operation);
  if (operation && (operation.state === 'uncertain' || operation.state === 'refused' || operation.state === 'failed')) return true;
  const result = /** @type {Record<string, unknown>|undefined} */ (record.result);
  if (result && (result.status === 'uncertain' || result.status === 'refused')) return true;
  return false;
}
