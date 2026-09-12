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
 * Frames larger than maxFrameBytes are refused as a typed error rather than buffered — the
 * design requires bounds to be enforced, not hoped for.
 */

import { connect as netConnect } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { BridgeError, ERROR_CODES } from './errors.js';

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Open a WebSocket to a loopback HTTP URL and yield text frames.
 * @param {object} options
 * @param {string} options.url like `ws://127.0.0.1:3080/api/events.mux`
 * @param {number} [options.maxFrameBytes] refuse frames beyond this size
 * @param {number} [options.connectTimeoutMs]
 * @param {AbortSignal} [options.signal] close the socket when aborted
 * @returns {Promise<{frames: AsyncIterable<string>, send: (text: string) => void, close: () => void, closed: Promise<void>}>}
 */
export async function connectWebSocket({ url, maxFrameBytes = 1024 * 1024, connectTimeoutMs = 10_000, signal }) {
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
  const queue = [];
  let notify = null;
  let finished = false;
  let finishReason = null;

  const push = (item) => {
    queue.push(item);
    if (notify) { const n = notify; notify = null; n(); }
  };

  // ---- frame parser (server->client frames are never masked) -------------------------
  let frameBuffer = Buffer.alloc(0);
  let fragmentOpcode = null;
  let fragments = [];

  /** @param {Buffer} chunk */
  const consumeFrames = (chunk) => {
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
          push({ error: new BridgeError(ERROR_CODES.OVERSIZE, 'websocket frame exceeds maxFrameBytes', { size: Number(big), maxFrameBytes }) });
          socket.destroy();
          return;
        }
        length = Number(big);
        offset += 8;
      }
      if (length > maxFrameBytes) {
        push({ error: new BridgeError(ERROR_CODES.OVERSIZE, 'websocket frame exceeds maxFrameBytes', { size: length, maxFrameBytes }) });
        socket.destroy();
        return;
      }
      let maskKey = null;
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
        if (!fin) continue;
        const full = Buffer.concat(fragments);
        fragments = [];
        const op = fragmentOpcode;
        fragmentOpcode = null;
        if (op === OPCODE.text) push({ text: full.toString('utf8') });
        continue;
      }
      if (fin) {
        if (opcode === OPCODE.text) push({ text: payload.toString('utf8') });
      } else {
        fragmentOpcode = opcode;
        fragments = [payload];
      }
    }
  };

  // ---- writers -----------------------------------------------------------------------
  /** @param {number} opcode @param {Buffer} payload */
  const writeFrame = (opcode, payload) => {
    const mask = randomBytes(4);
    const length = payload.length;
    let header;
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

  const closedPromise = new Promise((resolve) => {
    socket.on('close', () => {
      finished = true;
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

  const close = () => {
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
   * @returns {Promise<void>}
   */
  const ready = async () => {
    for (;;) {
      if (queue.length) {
        const item = queue[0];
        if (item.error) { queue.shift(); throw item.error; }
        if (item.open) { queue.shift(); return; }
        if (item.done) { queue.shift(); throw new BridgeError(ERROR_CODES.HOST_UNREACHABLE, 'websocket closed during handshake', {}); }
        queue.shift();
        continue;
      }
      await new Promise((resolve) => { notify = resolve; });
    }
  };

  await ready();

  const frames = {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        if (queue.length === 0) {
          if (finished) return;
          await new Promise((resolve) => { notify = resolve; });
          continue;
        }
        const item = queue.shift();
        if (item.error) throw item.error;
        if (item.done) return;
        if (item.text !== undefined) yield item.text;
      }
    },
  };

  return {
    frames,
    send: (text) => writeFrame(OPCODE.text, Buffer.from(text, 'utf8')),
    close,
    closed: closedPromise,
    get handshakeDone() { return headerDone; },
    get upgradeState() { return finishReason; },
  };
}

/**
 * Upgrade an inbound HTTP request on a raw socket — the server side used by the fake host
 * and by tests, so the client above is exercised against a real peer rather than a mock.
 * @param {import('node:http').IncomingMessage} request
 * @param {import('node:stream').Duplex} socket
 * @param {(text: string) => void} [onMessage]
 * @returns {{send: (text: string) => void, close: () => void, onClose: (fn: () => void) => void}}
 */
export function acceptWebSocket(request, socket, onMessage) {
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
  let closeHandler = () => {};

  const send = (text) => {
    const payload = Buffer.from(text, 'utf8');
    let header;
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

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) { if (buffer.length < 4) return; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) return; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      let maskKey = null;
      if (masked) { if (buffer.length < offset + 4) return; maskKey = buffer.subarray(offset, offset + 4); offset += 4; }
      if (buffer.length < offset + length) return;
      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i] ^= maskKey[i % 4];
      buffer = buffer.subarray(offset + length);
      if (opcode === OPCODE.close) { socket.end(); return; }
      if (opcode === OPCODE.ping) {
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
