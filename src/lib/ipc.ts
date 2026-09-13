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

import { createServer, connect as netConnect, type Socket } from 'node:net';
import {
  chmodSync, closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync,
  openSync, readFileSync, unlinkSync, writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { BridgeError, ERROR_CODES, toBridgeError } from './errors.ts';

/** Maximum bytes in one IPC line. Larger frames are refused, not buffered. */
export const MAX_IPC_LINE_BYTES = 4 * 1024 * 1024;
/** Maximum simultaneous gateway connections. */
export const MAX_IPC_CONNECTIONS = 32;

/** Path of the authority token that gates approval decisions. */
export interface AuthorityToken {
  readonly path: string;
  readonly created: boolean;
}

/** Context handed to the request handler: a gateway on this socket is never an approver. */
export interface IpcRequestContext {
  readonly peerAuthorized: boolean;
}

/**
 * Handle one request frame. The frame is parsed JSON, so its shape is not known here: the
 * handler validates it and is the only place that decides what a well-formed request is.
 */
export type IpcRequestHandler = (request: unknown, context: IpcRequestContext) => Promise<unknown>;

/** A running IPC endpoint: the path it bound, its live connection count, and its closer. */
export interface IpcServer {
  readonly path: string;
  readonly connections: () => number;
  readonly close: () => Promise<void>;
}

/** Options for {@link startIpcServer}. */
export interface StartIpcServerOptions {
  readonly stateDir: string;
  readonly handle: IpcRequestHandler;
}

/**
 * Unix socket paths are length-limited (~104 bytes on macOS). Hash a long state dir into a
 * short, stable name under the OS temp root instead of failing at bind time.
 * @param stateDir absolute state directory
 * @returns socket path
 */
export function socketPathFor(stateDir: string): string {
  const direct = join(stateDir, 'daemon.sock');
  if (Buffer.byteLength(direct) <= 100) return direct;
  const digest = createHash('sha256').update(stateDir).digest('hex').slice(0, 24);
  return join('/tmp', `dshpilot-${digest}.sock`);
}

export function authorityTokenPath(stateDir: string): string {
  return join(stateDir, 'authority.token');
}

/**
 * Create (or reuse) the authority token. Returns the path, never the value: the value is
 * written with 0600 and is only read by the operator-facing CLI.
 */
export function ensureAuthorityToken(stateDir: string): AuthorityToken {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const path = authorityTokenPath(stateDir);
  // Every step below is deliberately concerned with WHAT the path is, not merely that it exists.
  //
  // The previous form was `existsSync(path)` → `chmodSync(path, 0o600)`, with `writeFileSync(path, …)`
  // when it did not exist. Both of those FOLLOW SYMBOLIC LINKS, so a link planted at the token path
  // made this process chmod a file outside the state directory, and a DANGLING link made it create
  // and write the authority token at whatever the link pointed at — outside the directory whose mode
  // is the actual access control here. `readAuthorityToken` followed links too, so the value could be
  // read from anywhere. A symlink is therefore refused outright rather than resolved: this process
  // owns exactly one file at this path, and it authorises approvals.
  const existing = lstatOrNull(path);
  if (existing) {
    if (!existing.isFile()) {
      throw new BridgeError(ERROR_CODES.UNSAFE_STATE_PATH, 'authority token path exists but is not a regular file', {
        path,
        kind: existing.isSymbolicLink() ? 'symlink' : 'other',
      });
    }
    // Opened WITHOUT following links, and the mode is set on the OPEN DESCRIPTOR: `fchmodSync` cannot
    // be redirected by a link swapped in between the check and the change, which is the race the
    // path-based call could not close.
    const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try {
      assertRegularDescriptor(fd, path);
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
    return { path, created: false };
  }
  // `O_CREAT | O_EXCL` refuses an existing path — INCLUDING a dangling symlink, which is precisely the
  // case `existsSync` reports as absent and `writeFileSync` would happily create the target for.
  // `O_NOFOLLOW` is belt and braces for the same race.
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'EEXIST') {
      // Something appeared between the stat above and this call, possibly a link. Re-running the
      // refuse-a-link branch is the point: the answer must not depend on winning a race.
      return ensureAuthorityToken(stateDir);
    }
    throw error;
  }
  try {
    writeSync(fd, `${randomBytes(32).toString('hex')}\n`);
  } finally {
    closeSync(fd);
  }
  return { path, created: true };
}

/** `lstatSync` that answers null for "nothing there", and follows nothing. @param {string} path */
function lstatOrNull(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Confirm an open descriptor is a regular file.
 *
 * `O_NOFOLLOW` already refused a link at the path, but it says nothing about what the descriptor
 * actually is: a FIFO or a device node at this path would be opened successfully and would then make
 * `readFileSync(fd)` block forever or read something that is not a file. `fstat` on the descriptor is
 * the only check that cannot be redirected by a later rename.
 * @param {number} fd @param {string} path
 */
function assertRegularDescriptor(fd: number, path: string): void {
  const stats = fstatSync(fd);
  if (!stats.isFile()) {
    throw new BridgeError(ERROR_CODES.UNSAFE_STATE_PATH, 'authority token is not a regular file', { path, kind: 'not-regular' });
  }
}

/**
 * Read the authority token for comparison. Only the daemon and the operator CLI call this;
 * the gateway never does.
 *
 * Refuses a link rather than following it, and returns null only when there is genuinely nothing at
 * the path. The distinction matters to the caller: `null` means "this state directory has no token",
 * which is a missing setup step, while a refusal means the path is not the file this process owns,
 * which is not something an operator should be able to satisfy by presenting a link and a file.
 * @param stateDir
 * @returns the token, or null when none has been created
 */
export function readAuthorityToken(stateDir: string): string | null {
  const path = authorityTokenPath(stateDir);
  const existing = lstatOrNull(path);
  if (!existing) return null;
  if (!existing.isFile()) {
    throw new BridgeError(ERROR_CODES.UNSAFE_STATE_PATH, 'refusing to read an authority token through a non-regular file', {
      path,
      kind: existing.isSymbolicLink() ? 'symlink' : 'other',
    });
  }
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    assertRegularDescriptor(fd, path);
    return readFileSync(fd, 'utf8').trim();
  } finally {
    closeSync(fd);
  }
}

/** Start the daemon's IPC endpoint. */
export async function startIpcServer({ stateDir, handle }: StartIpcServerOptions): Promise<IpcServer> {
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
    let chain: Promise<void> = Promise.resolve();
    // No `setEncoding` here, on purpose, and this is a FIX rather than a port.
    //
    // The budget below is named MAX_IPC_LINE_BYTES and its comment promises BYTES RECEIVED, but the
    // previous code called `setEncoding('utf8')` and then measured `chunk.length` and `buffer.length`.
    // Those are UTF-16 code units, not bytes: one character can be up to 3 bytes in UTF-8 and a
    // surrogate pair is 2 units for 4 bytes, so a peer could deliver a line roughly 3x the configured
    // limit while every comparison stayed under it. That is a security bound that does not bound what
    // it says it bounds, in the one place — the daemon's local control socket — where the bound is the
    // defence. Reading raw Buffers and decoding explicitly makes `received` true bytes.
    //
    // Decoding per chunk matches what `setEncoding` did: it is the same `StringDecoder`-equivalent
    // path for an already-valid split of the stream, so line splitting is unchanged.
    socket.on('data', (chunk: Buffer) => {
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
      buffer += chunk.toString('utf8');
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
        // A completed line resets the receive budget: the limit is per line, not per lifetime. The
        // remainder is measured in bytes here too, so a partial trailing line is counted honestly.
        received = Buffer.byteLength(buffer, 'utf8');
        index = buffer.indexOf('\n');
        if (line.trim() === '') continue;
        // Serialise per connection: a gateway must not observe interleaved replies.
        chain = chain.then(async () => {
          let request: unknown;
          try {
            request = JSON.parse(line);
          } catch {
            socket.write(`${JSON.stringify({ ok: false, error: { code: ERROR_CODES.BAD_REQUEST, message: 'malformed json' } })}\n`);
            return;
          }
          let response: Record<string, unknown>;
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
    const done = (): void => { live -= 1; };
    socket.on('close', done);
    socket.on('error', done);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      server.off('error', reject);
      resolve(undefined);
    });
  });
  try { chmodSync(path, 0o600); } catch { /* best effort; the parent dir is already 0700 */ }

  return {
    path,
    connections: (): number => live,
    close: (): Promise<void> => new Promise<void>((resolve) => {
      server.close(() => resolve(undefined));
      if (existsSync(path)) {
        try { unlinkSync(path); } catch { /* already gone */ }
      }
    }),
  };
}

/**
 * One parsed reply frame: `{ok: true, value}` or `{ok: false, error}`. The frame is parsed JSON
 * written by our own daemon, so this is the shape it is read as; every field stays optional and
 * is defaulted at the point of use, exactly as the untyped original did.
 */
interface IpcReply {
  readonly ok?: unknown;
  readonly value?: unknown;
  readonly error?: IpcWireError | undefined;
}

/** The error a not-ok reply carries. */
interface IpcWireError {
  readonly code?: string | undefined;
  readonly message?: string | undefined;
  readonly details?: Record<string, unknown> | undefined;
}

/** One pending request, resolved by the next reply frame to arrive on the socket. */
interface IpcWaiter {
  readonly resolve: (reply: IpcReply) => void;
  readonly reject: (reason: unknown) => void;
}

/** One gateway-side connection to the daemon. */
export class IpcClient {
  #socket: Socket;
  #buffer = '';
  #pending: IpcWaiter[] = [];
  #closed = false;

  constructor({ socketPath }: { readonly socketPath: string }) {
    this.#socket = netConnect(socketPath);
    // Raw Buffers, as on the server side: the client bounds what it buffers too, and a bound in bytes
    // must be measured in bytes. Decoding happens explicitly at the same point the server does it.
    this.#socket.on('data', (chunk: Buffer) => {
      this.#buffer += chunk.toString('utf8');
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

  #failAll(error: unknown): void {
    this.#closed = true;
    const waiters = this.#pending;
    this.#pending = [];
    for (const waiter of waiters) waiter.reject(toBridgeError(error));
  }

  /**
   * @returns resolves after the socket is connected
   */
  ready(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#socket.once('connect', () => resolve(undefined));
      this.#socket.once('error', reject);
    });
  }

  /**
   * Send one request and await its reply.
   * @param request newline-free JSON object
   * @returns the `value` of an ok reply; throws a BridgeError otherwise
   */
  async request(request: unknown): Promise<unknown> {
    if (this.#closed) throw new BridgeError(ERROR_CODES.HOST_UNREACHABLE, 'daemon connection is closed', {});
    const reply = await new Promise<IpcReply>((resolve, reject) => {
      this.#pending.push({ resolve, reject });
      this.#socket.write(`${JSON.stringify(request)}\n`);
    });
    if (reply?.ok) return reply.value;
    const error: IpcWireError = reply?.error ?? { code: ERROR_CODES.INTERNAL, message: 'malformed daemon reply' };
    throw new BridgeError(error.code ?? ERROR_CODES.INTERNAL, error.message ?? 'daemon error', error.details ?? {});
  }

  /** Close the connection. */
  close(): void {
    this.#closed = true;
    this.#socket.destroy();
  }
}
