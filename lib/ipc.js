/**
 * Local IPC transport between thin MCP gateways and the single owner daemon.
 *
 * Why this file exists: the design keeps the daemon's lifetime independent of any one MCP
 * caller and separates authority. A gateway may drive sessions; it may NOT decide approvals.
 * So the transport carries two different things with two different rights:
 *
 *   - a socket at <state>/daemon.sock, connected to by gateways, for session/queue/event work;
 *   - an authority token file at <state>/authority.token (mode 0600) that only a human
 *     operator's tool reads. Approval decisions must present it. Because the token is a
 *     file on the daemon's private state directory, it is never reachable through an MCP
 *     tool result and never enters model context.
 *
 * Framing: newline-delimited JSON. Bounded line length, bounded concurrent sockets, and a
 * per-connection request cap so a misbehaving caller cannot exhaust the daemon. The socket is
 * unlinked on orderly shutdown and a stale socket file at startup is not authority: the owner
 * lock is taken first, and only then is an orphan endpoint reclaimed.
 */

import { createServer, connect as netConnect } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { BridgeError, ERROR_CODES, toBridgeError } from './errors.js';

/** Maximum bytes in one IPC line. Larger frames are refused, not buffered. */
export const MAX_IPC_LINE_BYTES = 4 * 1024 * 1024;
/** Maximum simultaneous gateway connections. */
export const MAX_IPC_CONNECTIONS = 32;

/**
 * Unix socket paths are length-limited (~104 bytes on macOS). Hash a long state dir into a
 * short, stable name under the OS temp root instead of failing at bind time.
 * @param {string} stateDir absolute state directory
 * @returns {string} socket path
 */
export function socketPathFor(stateDir) {
  const direct = join(stateDir, 'daemon.sock');
  if (Buffer.byteLength(direct) <= 100) return direct;
  const digest = createHash('sha256').update(stateDir).digest('hex').slice(0, 24);
  return join('/tmp', `dshpilot-${digest}.sock`);
}

/** @param {string} stateDir */
export function authorityTokenPath(stateDir) {
  return join(stateDir, 'authority.token');
}

/**
 * Create (or reuse) the authority token. Returns the path, never the value: the value is
 * written with 0600 and is only read by the operator-facing CLI.
 * @param {string} stateDir
 * @returns {{path: string, created: boolean}}
 */
export function ensureAuthorityToken(stateDir) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = authorityTokenPath(stateDir);
  if (existsSync(path)) {
    chmodSync(path, 0o600);
    return { path, created: false };
  }
  writeFileSync(path, `${randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
  return { path, created: true };
}

/**
 * Read the authority token for comparison. Only the daemon and the operator CLI call this;
 * the gateway never does.
 * @param {string} stateDir
 * @returns {string|null}
 */
export function readAuthorityToken(stateDir) {
  const path = authorityTokenPath(stateDir);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8').trim();
}

/**
 * Start the daemon's IPC endpoint.
 * @param {object} options
 * @param {string} options.stateDir
 * @param {(request: object, context: {peerAuthorized: boolean}) => Promise<object>} options.handle
 * @returns {Promise<{close: () => Promise<void>, path: string, connections: () => number}>}
 */
export async function startIpcServer({ stateDir, handle }) {
  const path = socketPathFor(stateDir);
  if (existsSync(path)) {
    // Reaching here means the owner lock is already held, so the endpoint is an orphan from a
    // dead daemon. Reclaiming it is safe precisely because ownership was decided first.
    try { unlinkSync(path); } catch { /* a racing unlink is harmless */ }
  }

  let live = 0;
  const server = createServer({ allowHalfOpen: false }, (socket) => {
    live += 1;
    if (live > MAX_IPC_CONNECTIONS) {
      socket.end(`${JSON.stringify({ ok: false, error: { code: ERROR_CODES.BUSY, message: 'too many connections' } })}\n`);
      live -= 1;
      return;
    }
    let buffer = '';
    let received = 0;
    let chain = Promise.resolve();
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      // Bound the connection by BYTES RECEIVED, not by buffered length: a peer that never
      // sends a newline would otherwise make the buffer grow without limit, since the stale
      // bytes are only dropped when a line is found.
      received += chunk.length;
      if (received > MAX_IPC_LINE_BYTES) {
        const payload = `${JSON.stringify({ ok: false, error: { code: ERROR_CODES.OVERSIZE, message: 'ipc line too large' } })}\n`;
        // Destroy rather than half-close: `end()` waits for the peer, and a peer that is
        // deliberately flooding is not going to close its side.
        socket.end(payload, () => socket.destroy());
        setTimeout(() => socket.destroy(), 250).unref?.();
        buffer = '';
        return;
      }
      buffer += chunk;
      if (buffer.length > MAX_IPC_LINE_BYTES) {
        socket.end(`${JSON.stringify({ ok: false, error: { code: ERROR_CODES.OVERSIZE, message: 'ipc line too large' } })}\n`, () => socket.destroy());
        setTimeout(() => socket.destroy(), 250).unref?.();
        buffer = '';
        return;
      }
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        // A completed line resets the receive budget: the limit is per line, not per lifetime.
        received = buffer.length;
        index = buffer.indexOf('\n');
        if (line.trim() === '') continue;
        // Serialise per connection: a gateway must not observe interleaved replies.
        chain = chain.then(async () => {
          let request;
          try {
            request = JSON.parse(line);
          } catch {
            socket.write(`${JSON.stringify({ ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: 'malformed json' } })}\n`);
            return;
          }
          let response;
          try {
            const value = await handle(request, { peerAuthorized: false });
            response = { ok: true, value };
          } catch (error) {
            response = { ok: false, error: toBridgeError(error).toJSON() };
          }
          socket.write(`${JSON.stringify(response)}\n`);
        }).catch(() => { /* a failed write means the socket is gone; the close handler cleans up */ });
      }
    });
    const done = () => { live -= 1; };
    socket.on('close', done);
    socket.on('error', done);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  try { chmodSync(path, 0o600); } catch { /* best effort; the parent dir is already 0700 */ }

  return {
    path,
    connections: () => live,
    close: () => new Promise((resolve) => {
      server.close(() => resolve(undefined));
      if (existsSync(path)) {
        try { unlinkSync(path); } catch { /* already gone */ }
      }
    }),
  };
}

/** One gateway-side connection to the daemon. */
export class IpcClient {
  #socket;
  #buffer = '';
  #pending = [];
  #closed = false;

  /**
   * @param {object} options
   * @param {string} options.socketPath
   */
  constructor({ socketPath }) {
    this.#socket = netConnect(socketPath);
    this.#socket.setEncoding('utf8');
    this.#socket.on('data', (chunk) => {
      this.#buffer += chunk;
      let index = this.#buffer.indexOf('\n');
      while (index >= 0) {
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        index = this.#buffer.indexOf('\n');
        if (line.trim() === '') continue;
        const waiter = this.#pending.shift();
        if (!waiter) continue;
        try {
          waiter.resolve(JSON.parse(line));
        } catch (error) {
          waiter.reject(new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'daemon sent malformed json', {}));
        }
      }
    });
    this.#socket.on('error', (error) => this.#failAll(error));
    this.#socket.on('close', () => this.#failAll(new BridgeError(ERROR_CODES.HOST_UNREACHABLE, 'daemon connection closed', {})));
  }

  /** @param {unknown} error */
  #failAll(error) {
    this.#closed = true;
    const waiters = this.#pending;
    this.#pending = [];
    for (const waiter of waiters) waiter.reject(toBridgeError(error));
  }

  /** @returns {Promise<void>} resolves after the socket is connected */
  ready() {
    return new Promise((resolve, reject) => {
      this.#socket.once('connect', () => resolve(undefined));
      this.#socket.once('error', reject);
    });
  }

  /**
   * Send one request and await its reply.
   * @param {object} request newline-free JSON object
   * @returns {Promise<any>} the `value` of an ok reply; throws a BridgeError otherwise
   */
  async request(request) {
    if (this.#closed) throw new BridgeError(ERROR_CODES.HOST_UNREACHABLE, 'daemon connection is closed', {});
    const reply = await new Promise((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      this.#socket.write(`${JSON.stringify(request)}\n`);
    });
    if (reply?.ok) return reply.value;
    const error = reply?.error ?? { code: ERROR_CODES.INTERNAL, message: 'malformed daemon reply' };
    throw new BridgeError(error.code ?? ERROR_CODES.INTERNAL, error.message ?? 'daemon error', error.details ?? {});
  }

  /** Close the connection. */
  close() {
    this.#closed = true;
    this.#socket.destroy();
  }
}
