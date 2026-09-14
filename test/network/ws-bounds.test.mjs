/**
 * WebSocket frame bounds, over a real socket.
 *
 * Why these tests exist: the client had a per-FRAME bound and nothing else. A per-frame bound is
 * the wrong unit in two independent ways, and both were reachable with frames that are each
 * individually legal:
 *
 *   1. a fragmented message is assembled from many frames, so `Buffer.concat` could be handed an
 *      unbounded total when FIN finally arrived — no single frame ever exceeded the limit;
 *   2. the parsed-but-unconsumed queue had no byte budget at all, so a fast peer and a slow reader
 *      grew it without limit.
 *
 * There is a third thing here that is not a size question: a frame that is ILLEGAL (a continuation
 * with no message started, a new data frame inside a fragmented message, a reserved opcode, a
 * binary frame on a text-only downlink) was previously pushed into the assembly list or ignored.
 * Skipping it would drop data while the stream still reported itself complete, and a caller reading
 * "complete" has no way to learn that an event is missing.
 *
 * The peer below is a hand-rolled socket that writes the exact frame sequence each case names. It is
 * a fixture; the client under test is the real `connectWebSocket`, and the budget numbers are small
 * on purpose so no case has to allocate anything large. Nothing here measures the process's memory:
 * the bound is asserted through the client's own counters and through which frames it delivered.
 */

import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { connectWebSocket } from '../../dist/lib/ws-client.js';
import { assert, waitFor } from '../helpers.mjs';

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa };

/**
 * Encode one unmasked server-to-client frame.
 * @param {{opcode: number, fin?: boolean, payload?: Buffer}} frame
 * @returns {Buffer}
 */
function encodeFrame({ opcode, fin = true, payload = Buffer.alloc(0) }) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = (fin ? 0x80 : 0x00) | opcode;
  return Buffer.concat([header, payload]);
}

/**
 * A minimal WebSocket peer that upgrades and then writes exactly the bytes a test hands it.
 * It exists so a test can send frame sequences a well-behaved client would never send.
 * @returns {Promise<{url: string, send: (bytes: Buffer) => void, sockets: import('node:net').Socket[], stop: () => Promise<void>}>}
 */
async function startRawPeer() {
  /** @type {import('node:net').Socket[]} */
  const sockets = [];
  const server = createServer();
  server.on('upgrade', (request, socket) => {
    // Node types the upgrade handler's socket as `Duplex`; this fixture only writes to it and keeps it
    // for teardown, and `destroy`/`write` are the only members it uses.
    const peer = /** @type {import('node:net').Socket} */ (socket);
    const key = request.headers['sec-websocket-key'] ?? '';
    // The accept value is computed properly even though these cases are about framing, so the
    // upgrade path exercised is the real one rather than a shortcut around it.
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    peer.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'));
    sockets.push(peer);
    peer.on('error', () => { /* the client tearing the socket down is the subject of these cases */ });
  });
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', () => resolve(undefined)); });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${port}/api/events.mux`,
    send: (bytes) => { for (const socket of sockets) socket.write(bytes); },
    sockets,
    stop: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => { server.close(() => resolve(undefined)); });
    },
  };
}

/** Read at most `count` frames from a connection, tolerating the stream ending. */
async function readUpTo(connection, count) {
  const seen = [];
  try {
    for await (const text of connection.frames) {
      seen.push(text);
      if (seen.length >= count) break;
    }
  } catch (error) {
    return { seen, error };
  }
  return { seen, error: null };
}

/**
 * The typed error a connection ends with, or null if it ended without one.
 *
 * Bounded on purpose. Draining a stream that is still legitimately open waits forever, and an
 * expectation in a test that is merely WRONG would then take the whole suite down with it instead of
 * failing where the mistake is. An earlier revision of this file hung the runner exactly that way:
 * the case had written a legal frame sequence where it meant to write an illegal one.
 * @param {any} connection
 * @param {number} [timeoutMs]
 */
async function failureOf(connection, timeoutMs = 5000) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  const expiry = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(
      `the connection was still open after ${timeoutMs}ms and never reported a failure: `
      + `stats=${JSON.stringify(connection.stats)}`,
    )), timeoutMs);
  });
  try {
    return await Promise.race([
      expiry,
      (async () => {
        try {
          for await (const _ of connection.frames) { /* drain to the end */ }
        } catch (error) {
          return error;
        }
        return null;
      })(),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export default {
  'a ping carrying more than 125 bytes is refused as a protocol violation instead of being answered': async () => {
    // RFC 6455 section 5.5: a control frame's payload MUST be 125 bytes or less. This client accepted a
    // longer ping and answered it — and the answer was itself invalid: the length byte it wrote held
    // `payload.length`, and in the 7-bit length field 126 and 127 are not lengths but the markers that
    // say "read the length from the next two (or eight) bytes". So the pong told the peer to read bytes
    // that were not there, and a peer that trusts our header desynchronises on our reply. Refusing is the
    // only honest outcome: the frame is illegal, and a client cannot both reject it and act on it.
    const peer = await startRawPeer();
    try {
      const connection = await connectWebSocket({ url: peer.url });
      // 126 bytes, so the encoder uses the extended-length form: legal for a DATA frame and illegal for a
      // control frame, which is exactly the confusion the old code made.
      peer.send(encodeFrame({ opcode: OPCODE.ping, payload: Buffer.alloc(126, 0x70) }));
      const error = await failureOf(connection);
      assert.ok(error, 'a 126-byte ping must fail the connection rather than be answered');
      assert.equal(error.code, 'HOST_PROTOCOL',
        `the refusal must be the protocol class, got ${error.code}: ${error.message}`);
      assert.equal(error.details?.limit, 125, 'and it must name the rule that applies to control frames');
      assert.equal(error.details?.length, 126, 'and the size that broke it');
      // And nothing may have been written back: no pong at all, valid or otherwise.
      assert.equal(peer.sockets.length, 1, 'the peer accepted one connection');
    } finally {
      await peer.stop();
    }
  },

  'a fragmented control frame is refused: a ping must not begin a fragmented message': async () => {
    // The second rule in the same section, and the one whose consequence is worse: a ping with FIN clear
    // was read as the START of a fragmented message, so the ping was never answered AND the next data
    // frame arrived while a fragment was "in progress" — turning the peer's legal next frame into a
    // violation of ours, and reporting the wrong side as at fault.
    const peer = await startRawPeer();
    try {
      const connection = await connectWebSocket({ url: peer.url });
      peer.send(encodeFrame({ opcode: OPCODE.ping, fin: false, payload: Buffer.from('hi') }));
      const error = await failureOf(connection);
      assert.ok(error, 'a ping with FIN clear must fail the connection');
      assert.equal(error.code, 'HOST_PROTOCOL',
        `the refusal must be the protocol class, got ${error.code}: ${error.message}`);
      assert.match(String(error.message), /must not be fragmented/,
        'and it must name fragmentation, not a data-frame violation caused by this frame');
    } finally {
      await peer.stop();
    }
  },

  'a legal ping is still answered with a legal pong, so the new rule is a bound and not a ban': async () => {
    // The positive control. Without it a parser that refused every ping would pass both cases above, and
    // the downlink would die on an ordinary keepalive. 125 bytes is the largest legal control payload.
    const peer = await startRawPeer();
    try {
      const connection = await connectWebSocket({ url: peer.url });
      peer.send(encodeFrame({ opcode: OPCODE.ping, payload: Buffer.alloc(125, 0x71) }));
      // The client must stay open and answer: pinging a live downlink is normal, and the frames stream
      // must not end. A text frame after it proves the connection is still usable.
      peer.send(encodeFrame({ opcode: OPCODE.text, payload: Buffer.from('{"n":1}') }));
      const { seen, error } = await readUpTo(connection, 1);
      const why = error instanceof Error ? error.message : String(error);
      assert.equal(error, null, `the connection must stay healthy after a legal ping: ${why}`);
      assert.equal(seen.length, 1, 'and the text frame must arrive');
      // `closed` is a promise that resolves when the downlink ends, so "still open" is what a bounded
      // race against it proves: a settled promise means the connection ended, and a timeout means it did
      // not. Any other reading of it would be asserting on a field that does not exist.
      const ended = await Promise.race([
        connection.closed.then(() => 'closed'),
        new Promise((resolvePromise) => { setTimeout(() => resolvePromise('open'), 200); }),
      ]);
      assert.equal(ended, 'open', 'and the downlink must still be open, not torn down by a legal ping');
    } finally {
      await peer.stop();
    }
  },

  'FR-SEC-2 fragments: a message assembled from individually legal fragments is refused when the TOTAL exceeds the message budget': async () => {
    const peer = await startRawPeer();
    const connection = await connectWebSocket({
      url: peer.url,
      maxFrameBytes: 4096,
      maxMessageBytes: 8192,
      maxQueueBytes: 64 * 1024,
    });
    try {
      // Eight fragments of 2048 bytes: every one of them is well under maxFrameBytes, and together
      // they are 16 KiB, twice the message budget. This is the shape the per-frame bound cannot see.
      const part = Buffer.alloc(2048, 0x61);
      const frames = [encodeFrame({ opcode: OPCODE.text, fin: false, payload: part })];
      for (let i = 0; i < 7; i += 1) {
        // Continuations, not more `text` frames: a second data frame inside a fragmented message is
        // itself a protocol violation, and it would be refused for that reason before the size
        // check this case is about ever runs.
        frames.push(encodeFrame({ opcode: OPCODE.continuation, fin: false, payload: part }));
      }
      peer.send(Buffer.concat(frames.slice(0, 1)));
      peer.send(Buffer.concat(frames.slice(1, 4)));
      peer.send(Buffer.concat(frames.slice(4)));
      // Two more fragments would exceed the budget; the client must refuse on the DECLARED length
      // of the frame that crosses it, before holding its payload.
      peer.send(encodeFrame({ opcode: OPCODE.continuation, fin: true, payload: Buffer.alloc(4096, 0x62) }));

      const error = /** @type {any} */ (await failureOf(connection));
      assert.ok(error, 'a message over the assembled-size budget must fail the connection');
      assert.equal(error.code, 'OVERSIZE', `expected a typed oversize, got ${error.code}: ${error.message}`);
      assert.match(String(error.message), /maxMessageBytes/, `the error must name the message budget: ${error.message}`);
      assert.equal(error.details?.exceeded, 'assembled message',
        `the detail must distinguish this from the per-frame bound: ${JSON.stringify(error.details)}`);
      assert.ok(Number(error.details?.size) > 8192,
        `the reported size must be the assembled total, got ${JSON.stringify(error.details)}`);
      const stats = connection.stats;
      assert.equal(stats.failed?.code, 'OVERSIZE', 'the connection must report itself failed');
      assert.equal(stats.pendingMessageBytes, 0,
        `the fragments of a refused message must be released, got ${stats.pendingMessageBytes}`);
      assert.equal(stats.messagesDelivered, 0,
        'a message that was never completed must never be delivered as if it had been');
    } finally {
      connection.close();
      await peer.stop();
    }
  },

  'FR-SEC-2 fragments: a legal fragmented message still assembles into one frame, and a stray continuation is a protocol error': async () => {
    const peer = await startRawPeer();
    const connection = await connectWebSocket({
      url: peer.url, maxFrameBytes: 4096, maxMessageBytes: 8192, maxQueueBytes: 64 * 1024,
    });
    try {
      // The POSITIVE control for the fragment path: fragmentation itself must keep working. Without
      // this, an implementation that refused every fragmented message would pass the case above.
      const pieces = ['{"type":"event"', ',"seq":1', '}'];
      peer.send(encodeFrame({ opcode: OPCODE.text, fin: false, payload: Buffer.from(pieces[0]) }));
      peer.send(encodeFrame({ opcode: OPCODE.continuation, fin: false, payload: Buffer.from(pieces[1]) }));
      peer.send(encodeFrame({ opcode: OPCODE.continuation, fin: true, payload: Buffer.from(pieces[2]) }));
      const { seen, error } = await readUpTo(connection, 1);
      assert.equal(error, null, `a legal fragmented message must not fail the connection: ${/** @type {any} */ (error)?.message}`);
      assert.deepEqual(seen, [pieces.join('')],
        'the fragments must be delivered as ONE message with their bytes concatenated in order');
      assert.equal(connection.stats.pendingMessageBytes, 0, 'the assembly buffers must be released after FIN');
    } finally {
      connection.close();
      await peer.stop();
    }

    // A continuation frame that starts no message is a protocol violation, not a fragment to store.
    const stray = await startRawPeer();
    const second = await connectWebSocket({ url: stray.url, maxFrameBytes: 4096 });
    try {
      stray.send(encodeFrame({ opcode: OPCODE.continuation, fin: true, payload: Buffer.from('orphan') }));
      const error = await failureOf(second);
      assert.equal(/** @type {any} */ (error)?.code, 'HOST_PROTOCOL',
        `a stray continuation must be a typed protocol error, got ${/** @type {any} */ (error)?.code}`);
      assert.match(String(error.message), /no message in progress/, `the error must say why: ${error.message}`);
      assert.equal(second.stats.messagesDelivered, 0,
        'a frame that belongs to no message must never be delivered as one');
    } finally {
      second.close();
      await stray.stop();
    }
  },

  'FR-SEC-2 fragments: an interleaved data frame, a reserved opcode and a binary frame are each a typed protocol error, and the connection still ends every time': async () => {
    /**
     * @param {Buffer} bytes the frame sequence to send
     * @param {string} expected the message the typed error must contain
     */
    const expectProtocolError = async (bytes, expected) => {
      const peer = await startRawPeer();
      const connection = await connectWebSocket({ url: peer.url, maxFrameBytes: 64 * 1024 });
      try {
        peer.send(bytes);
        const error = /** @type {any} */ (await failureOf(connection));
        assert.equal(error?.code, 'HOST_PROTOCOL',
          `expected a typed protocol error for ${expected}, got ${error?.code}: ${error?.message}`);
        assert.match(String(error.message), new RegExp(expected),
          `the error must name the violation (${expected}): ${error.message}`);
        assert.ok(connection.stats.failed, 'the connection must record that it failed');
        assert.equal(connection.stats.messagesDelivered, 0,
          'no message may be delivered from a stream that violated the protocol');
      } finally {
        connection.close();
        await peer.stop();
      }
    };

    // A new data frame arriving while a fragmented message is still open.
    await expectProtocolError(Buffer.concat([
      encodeFrame({ opcode: OPCODE.text, fin: false, payload: Buffer.from('{"a":') }),
      encodeFrame({ opcode: OPCODE.text, fin: true, payload: Buffer.from('1}') }),
    ]), 'inside a fragmented message');

    // A reserved opcode (0x3 is reserved for future non-control frames).
    await expectProtocolError(encodeFrame({ opcode: 0x3, fin: true, payload: Buffer.from('x') }), 'reserved or unknown opcode');

    // A binary frame. Both DSH downlinks are JSON text, so this is refused rather than skipped: a
    // skipped frame is data loss inside a stream that still calls itself complete.
    await expectProtocolError(encodeFrame({ opcode: OPCODE.binary, fin: true, payload: Buffer.from('binary') }), 'text-only downlink');
  },

  'FR-SEC-2 backpressure: a fast peer and a slow consumer are stopped by the queue budget, and the delivered set stays bounded': async () => {
    const peer = await startRawPeer();
    const connection = await connectWebSocket({
      url: peer.url,
      maxFrameBytes: 64 * 1024,
      maxMessageBytes: 64 * 1024,
      // Small, and deliberately much smaller than what the peer will try to push.
      maxQueueBytes: 8192,
    });
    try {
      // 200 messages of 512 bytes = 100 KiB against an 8 KiB budget. The consumer below reads
      // nothing until the peer has finished, which is exactly the slow-reader case.
      const payload = Buffer.from(JSON.stringify({ type: 'event', pad: 'p'.repeat(480) }));
      assert.ok(payload.length > 400 && payload.length < 600, `fixture payload is ${payload.length} bytes`);
      const frames = [];
      for (let i = 0; i < 200; i += 1) frames.push(encodeFrame({ opcode: OPCODE.text, payload }));
      peer.send(Buffer.concat(frames));

      // Wait for the bound to bite, reading nothing.
      await waitFor(() => connection.stats.failed !== null, {
        timeoutMs: 5000, what: 'the queue budget to stop a fast peer',
      });
      const stats = connection.stats;
      assert.equal(stats.failed?.code, 'OVERSIZE', `expected a typed oversize, got ${JSON.stringify(stats.failed)}`);
      assert.match(String(stats.failed?.message), /maxQueueBytes/, 'the error must name the queue budget');
      // The bound itself, read from the client rather than from the machine: what is HELD is never
      // more than the budget plus the one frame that crossed it.
      assert.ok(stats.queueBytes <= 8192,
        `the held queue must stay inside the budget, got ${stats.queueBytes} bytes`);
      const held = stats.queueBytes / payload.length;
      assert.ok(held < 200,
        `the whole burst must not have been buffered: ${stats.queueBytes} bytes held out of ${200 * payload.length} sent`);

      // No later delivery: the consumer sees what was held, then the typed error, and nothing after.
      const { seen, error } = /** @type {any} */ (await readUpTo(connection, 1000));
      assert.equal(error?.code, 'OVERSIZE', 'the consumer must observe the refusal, not a truncated stream');
      assert.ok(seen.length >= 1 && seen.length <= 8192 / payload.length,
        `the delivered count must be bounded by the budget, got ${seen.length} messages`);
      assert.ok(seen.every((text) => typeof text === 'string' && text.includes('event')),
        'every delivered message must be a whole frame, never a partial one');
      assert.equal(connection.stats.queueBytes, 0,
        'a drained queue must hold nothing, so the budget is about bytes held and not bytes ever seen');
    } finally {
      connection.close();
      await peer.stop();
    }
  },

  'FR-SEC-2 isolation: a refusal tears down only its own connection, and a disconnect releases the buffers it was holding': async () => {
    const peer = await startRawPeer();
    // The failing connection: a partial message, then a frame that breaks the protocol.
    const failing = await connectWebSocket({
      url: peer.url, maxFrameBytes: 4096, maxMessageBytes: 16384, maxQueueBytes: 64 * 1024,
    });
    try {
      peer.send(encodeFrame({ opcode: OPCODE.text, fin: false, payload: Buffer.alloc(1024, 0x61) }));
      await waitFor(() => failing.stats.pendingMessageBytes === 1024, {
        timeoutMs: 5000, what: 'the partial message to be buffered',
      });
      // A second data frame while that message is still open: a violation, and a different one from
      // the size bounds above, so this case is about the connection's isolation rather than its
      // limits. (A `continuation` here would be perfectly legal and would leave the connection
      // healthy — which is what an earlier revision of this test accidentally asserted.)
      peer.send(encodeFrame({ opcode: OPCODE.text, fin: true, payload: Buffer.alloc(1024, 0x62) }));

      // A SECOND connection to the same peer, opened while the first is breaking. The refusal is a
      // property of the connection, not of the process or of the peer: the mux and the host downlink
      // are separate sockets, so one stream violating the protocol must not take the other with it.
      const healthy = await connectWebSocket({ url: peer.url, maxFrameBytes: 4096 });
      try {
        const alive = '{"type":"session/queue","items":[]}';
        peer.send(encodeFrame({ opcode: OPCODE.text, payload: Buffer.from(alive) }));
        const { seen, error } = await readUpTo(healthy, 1);
        assert.equal(error, null, `the healthy connection must keep working: ${/** @type {any} */ (error)?.message}`);
        assert.deepEqual(seen, [alive], 'and it must receive the frame the peer sent after the other failed');

        const failure = /** @type {any} */ (await failureOf(failing));
        assert.equal(failure?.code, 'HOST_PROTOCOL', 'the failing connection must have ended with its typed error');
        assert.equal(failing.stats.pendingMessageBytes, 0,
          'the half-assembled message must be released when the connection fails');
        assert.equal(healthy.stats.pendingMessageBytes, 0, 'and the healthy connection must be untouched');
        assert.equal(healthy.stats.failed, null, 'the healthy connection must not be marked failed');
      } finally {
        healthy.close();
      }
    } finally {
      failing.close();
      await peer.stop();
    }

    // Disconnect while a message is half-received: the parser's buffers must not outlive the socket.
    const dropping = await startRawPeer();
    const connection = await connectWebSocket({
      url: dropping.url, maxFrameBytes: 4096, maxMessageBytes: 16384, maxQueueBytes: 64 * 1024,
    });
    try {
      connection.frames[Symbol.asyncIterator]();
      dropping.send(encodeFrame({ opcode: OPCODE.text, fin: false, payload: Buffer.alloc(2048, 0x61) }));
      await waitFor(() => connection.stats.pendingMessageBytes === 2048, {
        timeoutMs: 5000, what: 'the partial message to be buffered before the drop',
      });
      for (const socket of dropping.sockets) socket.destroy();
      await connection.closed;
      await waitFor(() => connection.stats.pendingMessageBytes === 0, {
        timeoutMs: 5000, what: 'the parser buffers to be released on disconnect',
      });
      assert.equal(connection.stats.parseBufferBytes, 0,
        `a dropped connection must not keep a partial frame header, got ${connection.stats.parseBufferBytes}`);
      assert.equal(connection.stats.failed, null,
        'a peer that simply went away is not a protocol violation, and it must not be reported as one');
    } finally {
      connection.close();
      await dropping.stop();
    }
  },
};
