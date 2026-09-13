/**
 * Minimal RFC 6455 WebSocket client, built to prove the bridge works with the real thing.
 *
 * Why this file exists: the DSH Host's two event streams are WebSocket-only (a plain
 * `GET /api/events.mux` answers `426 upgrade required`), and this project runs on zero
 * runtime dependencies. A fake host that spoke a bespoke protocol, or a WS shim that
 * bypassed framing, would leave the actual event path untested. So the handshake, the frame
 * parser and the writers below are real, and the fake host exercises them over a real socket.
 *
 * Scope: client role only, text frames plus ping/pong/close, no extensions, no compression.
 *
 * Three bounds, because one was not enough. `maxFrameBytes` caps a single frame, which is the
 * wrong unit for a peer that sends a legal-sized frame forever: a fragmented message is assembled
 * across many frames, so a per-frame cap alone lets an unbounded message accumulate in `fragments`
 * and then hands `Buffer.concat` an unbounded total. `maxMessageBytes` therefore caps the
 * ASSEMBLED message cumulatively, checked against the declared length as soon as a frame header is
 * parsed — before the payload is buffered, so a peer cannot make this process hold the bytes it is
 * trying to make us hold. `maxQueueBytes` caps the frames parsed but not yet consumed, which is the
 * other way to grow without limit: a fast peer and a slow consumer. Exceeding any of them is a
 * typed error, the connection is torn down, and the parser's buffers are released.
 *
 * A frame that is illegal rather than merely large (a continuation with no message started, a new
 * data frame inside a fragmented message, a reserved opcode) is a protocol error too, not something
 * to skip. Silently ignoring such a frame while still reporting the stream as complete is the one
 * outcome this file refuses: a dropped frame is a gap in a session's history, and a caller reading
 * `complete` would have no way to learn about it.
 */

import { connect as netConnect } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { BridgeError, ERROR_CODES } from './errors.ts';

const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} satisfies Record<string, number>;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * The opcodes this client understands. `binary` is in the set so that a binary frame is a KNOWN
 * frame that this client deliberately refuses, rather than an unknown one — the two produce
 * different errors, and only one of them is a statement about the peer's protocol version.
 * @param opcode
 */
/** The three control opcodes of RFC 6455, which carry their own length and fragmentation rules.
 * @param {number} opcode
 */
function isControlOpcode(opcode: number): boolean {
  return opcode === OPCODE.close || opcode === OPCODE.ping || opcode === OPCODE.pong;
}

function isKnownOpcode(opcode: number): boolean {
  return opcode === OPCODE.continuation || opcode === OPCODE.text || opcode === OPCODE.binary
    || opcode === OPCODE.close || opcode === OPCODE.ping || opcode === OPCODE.pong;
}

/** Connection parameters for `connectWebSocket`. */
export interface ConnectWebSocketOptions {
  /** like `ws://127.0.0.1:3080/api/events.mux` */
  readonly url: string;
  /** refuse frames beyond this size */
  readonly maxFrameBytes?: number;
  /**
   * Refuse a message whose assembled size exceeds this. A message is one frame, or every frame
   * between an initial data frame and its FIN — so this is the bound the per-frame one cannot be.
   */
  readonly maxMessageBytes?: number;
  /** Refuse to hold more than this many parsed-but-unconsumed bytes for a slow reader. */
  readonly maxQueueBytes?: number;
  readonly connectTimeoutMs?: number;
  /** close the socket when aborted */
  readonly signal?: AbortSignal;
}

/**
 * What `upgradeState` reports: the close frame's status code once one has been parsed, or null
 * while the stream is still open.
 */
export interface UpgradeState {
  readonly code: number | null;
}

/** The client connection `connectWebSocket` resolves to. */
export interface WebSocketConnection {
  readonly frames: AsyncIterable<string>;
  readonly send: (text: string) => void;
  readonly close: () => void;
  readonly closed: Promise<void>;
  readonly handshakeDone: boolean;
  readonly upgradeState: UpgradeState | null;
  /**
   * Live bound observability. A test can assert that a budget held by reading these instead of by
   * measuring the process's memory, which would be measuring the machine.
   */
  readonly stats: WebSocketStats;
}

/** The observable bounds of one connection, current at read time. */
export interface WebSocketStats {
  /** Bytes parsed and handed to the consumer but not consumed yet. */
  readonly queueBytes: number;
  /** Bytes buffered for the message currently being assembled. */
  readonly pendingMessageBytes: number;
  /** Bytes of a partially received frame header/payload still in the parse buffer. */
  readonly parseBufferBytes: number;
  /** Frames accepted and delivered as text. */
  readonly messagesDelivered: number;
  /** The configured bounds, echoed so an assertion can name what it checked. */
  readonly maxFrameBytes: number;
  readonly maxMessageBytes: number;
  readonly maxQueueBytes: number;
  /**
   * Set once a bound was exceeded or the peer broke the protocol: the connection is finished and
   * the consumer will observe this error. Null while the connection is usable.
   */
  readonly failed: { code: string; message: string } | null;
}

/** The server-side peer `acceptWebSocket` returns. */
export interface AcceptedWebSocket {
  readonly send: (text: string) => void;
  readonly close: () => void;
  readonly onClose: (fn: () => void) => void;
}

/**
 * One item handed from the socket to the consumer loop. At most one member is ever set, and the
 * consumers test them by truthiness — expressed as one shape with optional members rather than a
 * union the readers would have to narrow with `in`.
 */
interface QueueItem {
  readonly error?: BridgeError;
  readonly open?: true;
  readonly done?: true;
  readonly text?: string;
}

/**
 * Open a WebSocket to a loopback HTTP URL and yield text frames.
 * @param options url, frame bound, handshake timeout and abort signal
 * @returns the frame stream, the writers, and the handshake result
 */
export async function connectWebSocket({
  url,
  maxFrameBytes = 1024 * 1024,
  maxMessageBytes = 4 * 1024 * 1024,
  maxQueueBytes = 8 * 1024 * 1024,
  connectTimeoutMs = 10_000,
  signal,
}: ConnectWebSocketOptions): Promise<WebSocketConnection> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'ws:') {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, `unsupported websocket scheme: ${parsed.protocol}`, {});
  }
  const port = Number(parsed.port || 80);
  const key = randomBytes(16).toString('base64');
  let handshakeBuffer = Buffer.alloc(0);
  let headerDone = false;
  let upgraded = false;

  const socket = netConnect({ host: parsed.hostname, port });
  socket.setNoDelay(true);
  // The upgrade request is written on connect; without this the peer waits forever and the
  // only symptom is a handshake timeout.
  socket.on('connect', () => {
    socket.write([
      `GET ${parsed.pathname}${parsed.search} HTTP/1.1`,
      `Host: ${parsed.host}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ].join('\r\n'));
  });

  /** Frames and errors are delivered through this queue. */
  const queue: QueueItem[] = [];
  let queueBytes = 0;
  let notify: (() => void) | null = null;
  let finished = false;
  let finishReason: UpgradeState | null = null;
  let messagesDelivered = 0;
  /**
   * The first bound violation or protocol error, kept so a later frame cannot overwrite the reason
   * the connection actually died, and so `stats.failed` reports the real cause.
   */
  let failed: BridgeError | null = null;

  /** Wake a waiting consumer. */
  const wake = (): void => { if (notify) { const n = notify; notify = null; n(); } };

  const push = (item: QueueItem): void => {
    // Once the connection has failed, no further text is admitted: the error the consumer will see
    // must be the FIRST one, and a peer streaming after a violation must not keep growing the queue.
    if (failed && item.text !== undefined) return;
    queue.push(item);
    if (item.text !== undefined) queueBytes += Buffer.byteLength(item.text, 'utf8');
    wake();
  };

  /**
   * Fail the connection: record the cause once, stop the peer, release the parser's buffers, and
   * make the error the consumer's next observation. `releaseParserBuffers` is separate because the
   * close path needs it too — a half-assembled message must not outlive the socket that carried it.
   */
  const fail = (error: BridgeError): void => {
    if (failed) return;
    failed = error;
    push({ error });
    releaseParserBuffers();
    if (!socket.destroyed) socket.destroy();
  };

  const releaseParserBuffers = (): void => {
    frameBuffer = Buffer.alloc(0);
    fragments = [];
    fragmentBytes = 0;
    fragmentOpcode = null;
  };

  // ---- frame parser (server->client frames are never masked) -------------------------
  let frameBuffer = Buffer.alloc(0);
  /**
   * The message being assembled: `fragmentOpcode` is null when no message is in progress, and
   * `fragmentBytes` is the running total of the fragments taken so far. The total is what the
   * per-frame check cannot see, and it is tracked rather than derived from `fragments` because the
   * decision to refuse must be made from the declared length BEFORE the bytes are held.
   */
  let fragmentOpcode: number | null = null;
  let fragments: Buffer[] = [];
  let fragmentBytes = 0;

  /** @param chunk */
  const consumeFrames = (chunk: Buffer): void => {
    frameBuffer = Buffer.concat([frameBuffer, chunk]);
    for (;;) {
      if (frameBuffer.length < 2) return;
      const first = frameBuffer[0];
      const second = frameBuffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (frameBuffer.length < offset + 2) return;
        length = frameBuffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (frameBuffer.length < offset + 8) return;
        const big = frameBuffer.readBigUInt64BE(offset);
        if (big > BigInt(maxFrameBytes)) {
          fail(new BridgeError(ERROR_CODES.OVERSIZE, 'websocket frame exceeds maxFrameBytes', { size: Number(big), maxFrameBytes }));
          return;
        }
        length = Number(big);
        offset += 8;
      }
      if (length > maxFrameBytes) {
        fail(new BridgeError(ERROR_CODES.OVERSIZE, 'websocket frame exceeds maxFrameBytes', { size: length, maxFrameBytes }));
        return;
      }
      // The MESSAGE budget, decided from the declared length before a byte of it is buffered. For a
      // continuation this is the running total of the message, which is the quantity a per-frame
      // limit cannot bound: every fragment here may be individually legal.
      const messageBytes = opcode === OPCODE.continuation ? fragmentBytes + length : length;
      if (messageBytes > maxMessageBytes) {
        fail(new BridgeError(ERROR_CODES.OVERSIZE, 'websocket message exceeds maxMessageBytes', {
          size: messageBytes,
          fragmentBytes,
          frameLength: length,
          maxMessageBytes,
          maxFrameBytes,
          // Named so a reader cannot mistake this for the per-frame bound being too small.
          exceeded: opcode === OPCODE.continuation ? 'assembled message' : 'single frame message',
        }));
        return;
      }
      // Legality, before the payload is buffered: these are protocol violations, not sizes.
      //
      // CONTROL FRAMES HAVE THEIR OWN RULES, and they are the two this parser used to skip. RFC 6455
      // section 5.5: a control frame's payload MUST be 125 bytes or less, and it MUST NOT be fragmented.
      // Both matter here rather than being pedantry about a peer we do not control: a 126-byte ping was
      // accepted and answered with a pong whose length byte was written as `payload.length` — a value
      // above 125 in the 7-bit field is not a length, it is the EXTENDED-LENGTH marker, so the reply was
      // a frame header that says `read two more bytes` with none to read. The peer would desynchronise on
      // our reply, which is a worse outcome than refusing, and it is a `1002`-class protocol error in
      // both directions. A fragmented control frame is worse still: the ping would be treated as the
      // start of a fragmented message, and the next data frame would look like a violation of the peer's.
      if (isControlOpcode(opcode) && length > 125) {
        fail(new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'websocket control frame payload exceeds 125 bytes', {
          opcode, length, limit: 125,
        }));
        return;
      }
      if (isControlOpcode(opcode) && !fin) {
        fail(new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'websocket control frame must not be fragmented', { opcode }));
        return;
      }
      if (opcode === OPCODE.continuation && fragmentOpcode === null) {
        fail(new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'websocket continuation frame with no message in progress', {
          opcode,
        }));
        return;
      }
      if (opcode !== OPCODE.continuation && fragmentOpcode !== null) {
        fail(new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'websocket data frame received inside a fragmented message', {
          opcode,
          inProgressOpcode: fragmentOpcode,
        }));
        return;
      }
      if (!isKnownOpcode(opcode)) {
        fail(new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'websocket frame uses a reserved or unknown opcode', { opcode }));
        return;
      }
      // Both DSH downlinks are JSON text. A binary frame is refused rather than skipped: skipping it
      // would drop data while the stream still reported itself complete, which is a gap a caller
      // could not detect. Refusing it here also means a fragmented message can never be binary, so
      // the assembly path has one kind of payload to deliver.
      if (opcode === OPCODE.binary) {
        fail(new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'websocket binary frame on a text-only downlink', { opcode }));
        return;
      }
      let maskKey: Buffer | null = null;
      if (masked) {
        if (frameBuffer.length < offset + 4) return;
        maskKey = frameBuffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (frameBuffer.length < offset + length) return;
      let payload = Buffer.from(frameBuffer.subarray(offset, offset + length));
      if (maskKey) {
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
      }
      frameBuffer = frameBuffer.subarray(offset + length);

      if (opcode === OPCODE.ping) { writeFrame(OPCODE.pong, payload); continue; }
      if (opcode === OPCODE.pong) continue;
      if (opcode === OPCODE.close) {
        finished = true;
        finishReason = { code: payload.length >= 2 ? payload.readUInt16BE(0) : null };
        push({ done: true });
        socket.end();
        return;
      }
      if (opcode === OPCODE.continuation) {
        fragments.push(payload);
        fragmentBytes += payload.length;
        if (!fin) continue;
        const full = Buffer.concat(fragments);
        fragments = [];
        fragmentBytes = 0;
        fragmentOpcode = null;
        deliver(full);
        continue;
      }
      if (fin) {
        deliver(payload);
      } else {
        fragmentOpcode = opcode;
        fragments = [payload];
        fragmentBytes = payload.length;
      }
    }
  };

  /**
   * Hand one complete message to the consumer, under the queue budget.
   *
   * The budget is checked here rather than before the send, because dropping a frame to stay inside
   * it would be the silent loss this file exists to avoid: a caller would keep reading a stream it
   * believes is complete while an event is missing. So an over-budget frame is a typed error and the
   * connection ends, which the consumer cannot miss.
   * @param full the assembled message payload
   */
  const deliver = (full: Buffer): void => {
    const size = full.length;
    if (queueBytes + size > maxQueueBytes) {
      fail(new BridgeError(ERROR_CODES.OVERSIZE, 'websocket consumer is too far behind: queued frames exceed maxQueueBytes', {
        queuedBytes: queueBytes,
        incomingBytes: size,
        maxQueueBytes,
        deliveredMessages: messagesDelivered,
      }));
      return;
    }
    messagesDelivered += 1;
    push({ text: full.toString('utf8') });
  };

  // ---- writers -----------------------------------------------------------------------
  /** @param opcode @param payload */
  const writeFrame = (opcode: number, payload: Buffer): void => {
    const mask = randomBytes(4);
    const length = payload.length;
    let header: Buffer;
    if (length < 126) {
      header = Buffer.alloc(2);
      header[1] = 0x80 | length;
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 0x80 | 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    header[0] = 0x80 | opcode;
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i += 1) masked[i] ^= mask[i % 4];
    try {
      socket.write(Buffer.concat([header, mask, masked]));
    } catch {
      // The socket is gone; the close path reports it.
    }
  };

  const closedPromise = new Promise<void>((resolve) => {
    socket.on('close', () => {
      finished = true;
      // A half-assembled message cannot outlive the socket that was carrying it. The already-parsed
      // frames are kept, deliberately: they are bounded by maxQueueBytes, and dropping them would
      // lose events the peer had already delivered, which is the silent gap this file refuses.
      releaseParserBuffers();
      handshakeBuffer = Buffer.alloc(0);
      push({ done: true });
      resolve(undefined);
    });
  });

  socket.on('data', (chunk) => {
    if (!upgraded) {
      handshakeBuffer = Buffer.concat([handshakeBuffer, chunk]);
      const markerIndex = handshakeBuffer.indexOf('\r\n\r\n');
      if (markerIndex < 0) {
        if (handshakeBuffer.length > 64 * 1024) {
          push({ error: new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'handshake response too large', {}) });
          socket.destroy();
        }
        return;
      }
      const headerText = handshakeBuffer.subarray(0, markerIndex).toString('latin1');
      const rest = handshakeBuffer.subarray(markerIndex + 4);
      headerDone = true;
      const lines = headerText.split('\r\n');
      const status = lines[0] ?? '';
      if (!/^HTTP\/1\.1 101/.test(status)) {
        const expected = createHash('sha1').update(`${key}${GUID}`).digest('base64');
        const acceptLine = lines.find((l) => /^sec-websocket-accept:/i.test(l));
        push({
          error: new BridgeError(ERROR_CODES.HOST_PROTOCOL, `websocket upgrade refused: ${status}`, {
            expectedAcceptPresent: Boolean(expected) && Boolean(acceptLine),
          }),
        });
        socket.destroy();
        return;
      }
      const acceptLine = lines.find((l) => /^sec-websocket-accept:/i.test(l));
      const expected = createHash('sha1').update(`${key}${GUID}`).digest('base64');
      if (!acceptLine || acceptLine.split(':').slice(1).join(':').trim() !== expected) {
        push({ error: new BridgeError(ERROR_CODES.HOST_PROTOCOL, 'websocket accept header mismatch', {}) });
        socket.destroy();
        return;
      }
      upgraded = true;
      push({ open: true });
      if (rest.length) consumeFrames(rest);
      return;
    }
    consumeFrames(chunk);
  });

  socket.on('error', (error) => {
    push({ error: new BridgeError(ERROR_CODES.HOST_UNREACHABLE, `websocket error: ${error.message}`, {}) });
  });

  const timeout = setTimeout(() => {
    if (!upgraded) {
      push({ error: new BridgeError(ERROR_CODES.HOST_UNREACHABLE, 'websocket handshake timed out', { connectTimeoutMs }) });
      socket.destroy();
    }
  }, connectTimeoutMs);
  timeout.unref?.();

  const close = (): void => {
    clearTimeout(timeout);
    if (!socket.destroyed) {
      try { writeFrame(OPCODE.close, Buffer.alloc(0)); } catch { /* best effort */ }
      socket.destroy();
    }
  };

  if (signal) {
    if (signal.aborted) close();
    else signal.addEventListener('abort', close, { once: true });
  }

  /**
   * Await the upgrade so callers know the stream is established before iterating.
   * @returns nothing, once the upgrade has been observed
   */
  const ready = async (): Promise<void> => {
    for (;;) {
      if (queue.length) {
        const item = queue[0];
        if (item.error) { queue.shift(); throw item.error; }
        if (item.open) { queue.shift(); return; }
        if (item.done) { queue.shift(); throw new BridgeError(ERROR_CODES.HOST_UNREACHABLE, 'websocket closed during handshake', {}); }
        queue.shift();
        continue;
      }
      await new Promise<void>((resolve) => { notify = resolve; });
    }
  };

  await ready();

  const frames: AsyncIterable<string> = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length === 0) {
          if (finished) return;
          await new Promise<void>((resolve) => { notify = resolve; });
          continue;
        }
        // The queue length was just checked, so this shift cannot come back empty.
        const item = queue.shift() as QueueItem;
        // Released as the consumer takes it: the budget is about bytes HELD, so a reader that keeps
        // up frees the budget for the frames behind it.
        if (item.text !== undefined) queueBytes -= Buffer.byteLength(item.text, 'utf8');
        if (item.error) throw item.error;
        if (item.done) return;
        if (item.text !== undefined) yield item.text;
      }
    },
  };

  return {
    frames,
    send: (text: string) => writeFrame(OPCODE.text, Buffer.from(text, 'utf8')),
    close,
    closed: closedPromise,
    get handshakeDone() { return headerDone; },
    get upgradeState() { return finishReason; },
    get stats(): WebSocketStats {
      return {
        queueBytes,
        pendingMessageBytes: fragmentBytes,
        parseBufferBytes: frameBuffer.length,
        messagesDelivered,
        maxFrameBytes,
        maxMessageBytes,
        maxQueueBytes,
        failed: failed === null ? null : { code: failed.code, message: failed.message },
      };
    },
  };
}

/**
 * Upgrade an inbound HTTP request on a raw socket — the server side used by the fake host
 * and by tests, so the client above is exercised against a real peer rather than a mock.
 * @param request
 * @param socket
 * @param onMessage
 * @returns the peer's writers and its single close handler slot
 */
export function acceptWebSocket(request: IncomingMessage, socket: Duplex, onMessage?: (text: string) => void): AcceptedWebSocket {
  const key = request.headers['sec-websocket-key'];
  const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));

  let buffer = Buffer.alloc(0);
  let closeHandler: () => void = () => {};

  const send = (text: string): void => {
    const payload = Buffer.from(text, 'utf8');
    let header: Buffer;
    if (payload.length < 126) {
      header = Buffer.alloc(2);
      header[1] = payload.length;
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    header[0] = 0x80 | OPCODE.text;
    socket.write(Buffer.concat([header, payload]));
  };

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      let maskKey: Buffer | null = null;
      if (masked) { if (buffer.length < offset + 4) return; maskKey = buffer.subarray(offset, offset + 4); offset += 4; }
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
      buffer = buffer.subarray(offset + length);
      if (opcode === OPCODE.close) { socket.end(); return; }
      if (opcode === OPCODE.ping) {
        // A ping with more than 125 bytes of payload is invalid (RFC 6455 section 5.5), and this used to
        // answer it anyway: `pong[1] = payload.length` writes a number above 125 into the 7-bit length
        // field, where 126 and 127 mean "read more bytes for the length" rather than being a length. The
        // reply was therefore a frame a correct client MUST reject, produced by our own test fixture —
        // which is exactly the kind of fixture that hides a parser bug instead of finding one. The peer
        // is torn down instead.
        if (payload.length > 125 || (buffer[0] & 0x80) === 0) {
          socket.destroy();
          return;
        }
        const pong = Buffer.alloc(2);
        pong[0] = 0x80 | OPCODE.pong;
        pong[1] = payload.length;
        socket.write(Buffer.concat([pong, payload]));
        continue;
      }
      if (opcode === OPCODE.text && onMessage) onMessage(payload.toString('utf8'));
    }
  });
  // A peer that vanishes mid-frame surfaces as a socket error. It is an expected end of life
  // for a downlink, not a crash: the close handler is the single place that reports it.
  socket.on('error', () => {
    try { socket.destroy(); } catch { /* already gone */ }
    closeHandler();
  });
  socket.on('end', () => closeHandler());
  socket.on('close', () => closeHandler());

  return {
    send,
    close: () => { try { socket.end(); } catch { /* already closed */ } },
    onClose: (fn) => { closeHandler = fn; },
  };
}
