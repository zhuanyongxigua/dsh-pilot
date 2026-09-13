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

/**
 * Maximum bytes in one IPC REPLY. Enforced on BOTH ends of the socket, from this one number.
 *
 * Why it needs to exist: the server bounded what it ACCEPTED and the client bounded nothing at all, so
 * a peer that never sent a newline made the client's buffer grow without limit — a gateway held an
 * unbounded amount of memory on behalf of the daemon it was talking to. The comment in the client even
 * claimed it bounded what it buffers. A bound that only one side applies is not a bound on the
 * connection.
 *
 * Why both ends use the SAME number: if the client's limit were lower than the largest reply the daemon
 * can legitimately produce, the daemon would emit frames its own gateway rejects, and the failure would
 * appear as a mysterious disconnect on a call that should have worked. So the daemon REFUSES to emit a
 * reply above this size, with a typed error the caller can read, and the client refuses to buffer one.
 * The value is chosen above the largest reply the daemon can construct from its own configured limits —
 * an event page, or a single event delivered alone because it exceeded the page budget — with room for
 * JSON escaping, so the cap is a backstop against a peer that misbehaves rather than a limit on normal
 * traffic. It is configurable (`DSH_PILOT_IPC_REPLY_MAX_BYTES`) and asserted in the tests.
 */
export const MAX_IPC_REPLY_BYTES = 16 * 1024 * 1024;
/** Maximum simultaneous gateway connections. */
export const MAX_IPC_CONNECTIONS = 32;

/** One complete newline-terminated frame, with the BYTES it occupied on the wire. */
interface FramedLine {
  readonly text: string;
  /** The frame's own bytes including its newline: what a per-frame budget is about. */
  readonly bytes: number;
}

/**
 * Assemble newline-delimited frames out of a byte stream, counting each frame in RAW BYTES.
 *
 * This exists because the two things a socket hands you are not the things a protocol is made of. A
 * single `data` event can carry several complete frames, half of one, or the tail of one and the head of
 * the next; the kernel decides, and it is not the peer's framing. Both ends of this socket used to treat
 * a chunk as if it were a frame: they added `chunk.length` to a counter, compared THAT against a per-frame
 * budget, and only then split the chunk on newlines. Two legal replies whose combined size exceeded the
 * budget were therefore refused together, and a request that arrived batched with another was refused for
 * the other's size — the bound rejected traffic it was not about.
 *
 * The other half of the same mistake was the reset: the counter was restored from
 * `Buffer.byteLength(buffer)`, the re-encoded length of the DECODED remainder, so the incomplete trailing
 * integer of a multi-byte character, which a streaming decoder holds OUTSIDE that string, was not counted
 * at all. Framing on the raw bytes removes the question: a frame's size is the distance between the
 * newlines around it, exact by construction, and there is no decoder in the accounting path to lose bytes
 * in.
 *
 * Decoding each frame on its own is correct rather than a compromise, and this is why: a newline byte can
 * never occur inside a UTF-8 sequence (continuation bytes are all >= 0x80), so a frame boundary is always
 * a character boundary, and a frame's bytes always decode to its text in full.
 */
class LineFramer {
  /**
   * The pieces of the frame being received, and their total. Held as a list rather than as one growing
   * Buffer so that each arriving chunk is appended instead of copied: a large frame delivered in many
   * chunks would otherwise re-copy everything received so far on every chunk. Nothing here needs the
   * joined bytes until a newline says the frame is complete, and that join happens once per frame.
   */
  #parts: Buffer[] = [];
  #size = 0;

  /**
   * Bytes buffered for a frame that has not been terminated by a newline yet.
   *
   * The honest remainder: with a per-frame budget, an unterminated frame may hold at most one frame's
   * worth of bytes, and this is the number to compare against it.
   */
  get pendingBytes(): number {
    return this.#size;
  }

  /** Drop everything buffered. Called after a refusal, so nothing is handed to a dead connection. */
  reset(): void {
    this.#parts = [];
    this.#size = 0;
  }

  /**
   * Add bytes and take out every frame they completed.
   * @param chunk the bytes the socket handed over, which may hold any number of frames in any state
   */
  push(chunk: Buffer): FramedLine[] {
    const frames: FramedLine[] = [];
    let rest = chunk;
    for (;;) {
      // A frame boundary cannot be in bytes already scanned: they were split and removed when they
      // arrived, so only the newest bytes ever need searching — which is why this loop starts from the
      // current piece rather than rescanning everything buffered.
      const index = rest.indexOf(0x0a);
      if (index < 0) break;
      const head = rest.subarray(0, index);
      // The pieces of THIS frame, joined once. Kept in a named value so that the decode below is
      // visibly a decode of the whole frame: decoding the pieces separately would be the per-chunk
      // mistake this class exists to remove, and a reader should be able to see that it is not that.
      const pieces = this.#parts.length === 0 ? [head] : [...this.#parts, head];
      const body = pieces.length === 1 ? (pieces[0] ?? head) : Buffer.concat(pieces);
      const text = body.toString('utf8');
      this.#parts = [];
      this.#size = 0;
      // The frame's bytes are the line plus its terminator: the wire cost of the frame, which is what a
      // bound named "bytes per frame" is about.
      frames.push({ text, bytes: body.length + 1 });
      rest = rest.subarray(index + 1);
    }
    if (rest.length > 0) {
      this.#parts.push(rest);
      this.#size += rest.length;
    }
    return frames;
  }
}

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
  /** Cap on one reply frame, in bytes. Defaults to the shared {@link MAX_IPC_REPLY_BYTES}. */
  readonly maxReplyBytes?: number;
  /**
   * Cap on one REQUEST line, in bytes. Defaults to {@link MAX_IPC_LINE_BYTES}.
   *
   * Configurable for the same reason the reply bound is: the property under test is "the budget is spent
   * per frame, not per delivery", and a case that can only be run at 4 MiB is a case nobody runs.
   */
  readonly maxRequestBytes?: number;
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

/**
 * Is this value an object whose fields can be read? Used only to name the op in a too-large-reply
 * refusal, where the value came from our own handler and may be anything.
 * @param {unknown} value
 */
function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
export async function startIpcServer({
  stateDir, handle, maxReplyBytes = MAX_IPC_REPLY_BYTES, maxRequestBytes = MAX_IPC_LINE_BYTES,
}: StartIpcServerOptions): Promise<IpcServer> {
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
    // Frames, not chunks. The budget below is named per REQUEST LINE and is now spent per request line:
    // the previous form compared a counter of everything that had arrived in the current chunk against
    // that budget, so two requests batched into one write were refused together even though each was
    // legal, and the reset afterwards re-measured the DECODED remainder and lost the bytes a streaming
    // decoder was holding on to. `LineFramer` returns each frame with its exact byte length and reports
    // the bytes still waiting for a newline, which is the only quantity a per-frame budget can bound.
    const framer = new LineFramer();
    let chain: Promise<void> = Promise.resolve();
    // The history of this one budget is worth keeping, because it was wrong twice in two different ways.
    //
    // First it called `setEncoding('utf8')` and measured `chunk.length` and `buffer.length` — UTF-16 code
    // units, not bytes, so a peer could deliver a line roughly 3x the configured limit while every
    // comparison stayed under it. That is a security bound that does not bound what it says it bounds, in
    // the one place this project has one. Reading raw Buffers fixed the unit.
    //
    // Then it added the whole CHUNK to a counter before splitting that chunk into lines, and restored the
    // counter from `Buffer.byteLength(remainder)`. The unit was right and the SUBJECT was wrong: a `data`
    // event is a delivery, not a frame, so two legal requests batched into one write were refused for their
    // combined size, and the reset re-encoded the decoded remainder, dropping the bytes a streaming decoder
    // was holding for an incomplete character at the frame's end. `LineFramer` measures each frame's own
    // bytes and reports the bytes still waiting for a newline; see its comment for why per-frame decoding
    // is exact rather than a compromise.
    /** The one refusal for an over-budget frame: destroy rather than wait for a flooding peer to close. */
    const refuseOversizeLine = (): void => {
      const payload = `${JSON.stringify({ ok: false, error: { code: ERROR_CODES.OVERSIZE, message: 'ipc line too large' } })}\n`;
      socket.end(payload, () => socket.destroy());
      setTimeout(() => socket.destroy(), 250).unref?.();
      framer.reset();
    };
    socket.on('data', (chunk: Buffer) => {
      let frames: FramedLine[];
      try {
        frames = framer.push(chunk);
      } catch (error) {
        // `push` cannot fail by design; this keeps a surprise out of an event handler, where an uncaught
        // throw would take the whole daemon down for one bad peer.
        socket.destroy();
        void error;
        return;
      }
      // Every frame is measured on its own bytes. A chunk holding two legal requests is served, because
      // the budget is about a frame and not about how the kernel happened to deliver it.
      for (const frame of frames) {
        if (frame.bytes > maxRequestBytes) {
          refuseOversizeLine();
          return;
        }
      }
      // And the bytes still waiting for a newline are the other half of the same budget: an unterminated
      // frame can never legally hold more than one frame's worth, so this is the point at which a peer
      // that never sends a newline is refused rather than buffered.
      if (framer.pendingBytes > maxRequestBytes) {
        refuseOversizeLine();
        return;
      }
      for (const frame of frames) {
        const line = frame.text;
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
          // The reply is measured before it is written, so the daemon cannot emit a frame its own
          // gateway would refuse to buffer. Measured on the SERIALISED LINE including the envelope and
          // the newline, because that is what the client is asked to hold.
          const replyLine = `${JSON.stringify(response)}\n`;
          if (Buffer.byteLength(replyLine, 'utf8') > maxReplyBytes) {
            // A typed refusal rather than a truncated or dropped frame: the caller must learn that the
            // answer was too large to deliver, not see a broken connection and guess.
            const bare = response.ok === true ? (response.value ?? null) : null;
            const op = isRecordLike(bare) && typeof bare.op === 'string' ? bare.op : null;
            socket.write(`${JSON.stringify({
              ok: false,
              error: {
                code: ERROR_CODES.RESULT_TOO_LARGE,
                message: 'the reply exceeds the IPC reply limit',
                details: { maxReplyBytes, op },
              },
            })}\n`);
            return;
          }
          socket.write(replyLine);
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

/**
 * One gateway-side connection to the daemon.
 *
 * Two things this class says about itself were not true, and both are the kind that only show up under a
 * peer that misbehaves:
 *
 *   - it claimed to bound what it buffers and bounded nothing. The server capped the frames it ACCEPTED;
 *     the client capped the frames it RECEIVED at no number at all, so a daemon — or anything that got
 *     the socket — could make a gateway hold an unbounded buffer by never sending a newline. The bound
 *     is now real, measured in bytes, and shared with the server through {@link MAX_IPC_REPLY_BYTES} so
 *     the two ends cannot disagree about what is deliverable.
 *   - it decoded per chunk with `chunk.toString('utf8')`, which is wrong whenever a chunk boundary falls
 *     inside a character: the partial sequence becomes a replacement character that concatenation cannot
 *     repair. A reply containing multi-byte text was therefore corrupted in proportion to how the
 *     kernel happened to split it. The decoder below holds an incomplete trailing sequence back until
 *     its continuation arrives.
 *
 * A peer over the bound is a failure of THIS connection and nothing else: the socket is destroyed, the
 * pending waiters are settled with a typed error so no caller is left waiting, the buffer is released,
 * and the daemon keeps serving everyone else.
 */
export class IpcClient {
  #socket: Socket;
  #pending: IpcWaiter[] = [];
  #closed = false;
  #maxReplyBytes: number;

  constructor({ socketPath, maxReplyBytes = MAX_IPC_REPLY_BYTES }: {
    readonly socketPath: string;
    /** Cap on one reply frame, in received bytes. Defaults to the shared IPC reply bound. */
    readonly maxReplyBytes?: number;
  }) {
    this.#maxReplyBytes = maxReplyBytes;
    this.#socket = netConnect(socketPath);
    // Frames, not chunks — the same correction as the server side, and for the same reason: a `data` event
    // is a delivery, not a protocol frame. It can carry two complete replies, and this code used to add the
    // whole chunk to one counter before splitting it, so two legal replies whose combined size exceeded the
    // budget were refused together, and a reply batched behind another was refused for the other's size.
    // The counter was also restored from the re-encoded DECODED remainder, which silently dropped the
    // bytes a streaming decoder was holding for an incomplete multi-byte character at the frame's end.
    const framer = new LineFramer();
    this.#socket.on('data', (chunk: Buffer) => {
      const frames = framer.push(chunk);
      for (const frame of frames) {
        if (frame.bytes > this.#maxReplyBytes) {
          this.#refuseOversize(framer, frame.bytes);
          return;
        }
      }
      // An unterminated frame may hold at most one frame's worth of bytes, so this is where a peer that
      // never sends a newline is refused instead of being buffered for ever.
      if (framer.pendingBytes > this.#maxReplyBytes) {
        this.#refuseOversize(framer, framer.pendingBytes);
        return;
      }
      for (const frame of frames) {
        const line = frame.text;
        if (line.trim() === '') continue;
        const waiter = this.#pending.shift();
        if (!waiter) {
          // A reply with no waiter. Previously discarded in silence, which is the right thing to do with
          // it and the wrong thing to do silently: this connection is strictly one reply per request and
          // the daemon serialises its replies per connection, so an unmatched frame means one of the two
          // ends has lost track. The connection is failed rather than continuing with a desynchronised
          // pairing, where every later reply would be handed to the wrong caller.
          //
          // NOT a demonstrated production failure: `request()` has no per-request deadline, so the "late
          // reply to a timed-out waiter" that this guard also protects against cannot happen from this
          // code today. It is here because that deadline is the obvious next change and this is the
          // hazard it would introduce. Stated as a hazard guarded against, not as a bug that occurred.
          this.#socket.destroy();
          this.#failAll(new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'daemon sent a reply this client has no request for', {
            pendingRequests: this.#pending.length,
          }));
          return;
        }
        try {
          waiter.resolve(JSON.parse(line));
        } catch {
          waiter.reject(new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'daemon sent malformed json', {}));
        }
      }
    });
    this.#socket.on('error', (error) => this.#failAll(error));
    this.#socket.on('close', () => this.#failAll(new BridgeError(ERROR_CODES.HOST_UNREACHABLE, 'daemon connection closed', {})));
  }

  /**
   * Refuse one connection for a frame over the receive bound, and settle everything waiting on it.
   *
   * Destroy rather than end: a peer that is flooding is not going to honour a half-close, and the pending
   * callers must not be left waiting for a frame that can never arrive inside the bound. The buffer is
   * released with the connection, and the error names both the bound and the bytes that crossed it.
   * @param framer the framer holding this connection's partial frame
   * @param bytes the frame size that broke the bound
   */
  #refuseOversize(framer: LineFramer, bytes: number): void {
    framer.reset();
    const refusal = new BridgeError(ERROR_CODES.OVERSIZE, 'reply exceeds the IPC reply limit', {
      maxReplyBytes: this.#maxReplyBytes,
      receivedBytes: bytes,
    });
    this.#socket.destroy();
    this.#failAll(refusal);
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

  /**
   * How many requests are waiting for a reply.
   *
   * A read-only view, here because the reliability claim is "a failed connection settles its pending
   * callers rather than leaving them waiting", and a claim needs an observable oracle. The alternative
   * would be a test that reaches into a private field, which would then be testing the field rather than
   * the behaviour.
   */
  get pendingRequests(): number {
    return this.#pending.length;
  }

  /** The receive bound this client applies, in bytes. Read by the test that asserts the two ends agree. */
  get maxReplyBytes(): number {
    return this.#maxReplyBytes;
  }

  /** Close the connection. */
  close(): void {
    this.#closed = true;
    this.#socket.destroy();
  }
}
