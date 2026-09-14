/**
 * The IPC client's receive bound, and its framing.
 *
 * Why this file exists: the client claimed in a comment that it "bounds what it buffers too" and bounded
 * nothing. The server capped the frames it ACCEPTED; the client capped the frames it RECEIVED at no
 * number at all, so a peer that never sent a newline made a gateway's buffer grow without limit. A bound
 * applied by one end of a socket is not a bound on the connection.
 *
 * The peer here is a RAW socket server rather than the daemon, on purpose. The claim being tested is
 * "what this client does with a misbehaving peer", and the daemon is not a misbehaving peer — it cannot
 * be made to dribble bytes forever, to split a character mid-sequence on a schedule of the test's
 * choosing, or to answer one request twice. A fake daemon that can do those things is the only oracle
 * that can fail for the right reason.
 *
 * The bound is exercised at a small configured size (4 KiB) rather than the shipped 16 MiB, because the
 * property is "the client refuses to buffer beyond the bound" and 4 KiB proves it while keeping the case
 * cheap. The shipped default and its agreement with the daemon's own limit are asserted separately.
 */

import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { assert, ipcClient, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { IpcClient } from '../../dist/lib/ipc.js';
import { FakeHost } from '../fixtures/fake-host.mjs';

const CAP = 4096;

/**
 * A raw socket server that hands each connection to a scenario, on a socket path of its own.
 * @param {string} label @param {(socket: import('node:net').Socket) => void} scenario
 */
async function peer(label, scenario) {
  const scratch = scratchDir(`ipc-bounds-${label}`);
  const socketPath = join(scratch.dir, 'daemon.sock');
  /** Every socket this peer accepted, so `stop()` can end a scenario that is deliberately still writing. */
  const accepted = new Set();
  const server = createServer({ allowHalfOpen: false }, (socket) => {
    accepted.add(socket);
    socket.on('close', () => accepted.delete(socket));
    scenario(socket);
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen(socketPath, () => resolvePromise(undefined));
  });
  return {
    socketPath,
    stop: async () => {
      // `server.close()` waits for existing connections, and one scenario is a peer that writes for ever
      // by design: without destroying them here the case would end with the peer still flooding and the
      // test process would never exit, which would look like a hung test rather than a finished one.
      for (const socket of accepted) socket.destroy();
      await new Promise((resolvePromise) => server.close(() => resolvePromise(undefined)));
      scratch.cleanup();
    },
  };
}

/** Read one newline-terminated request frame from the peer's side. @param {import('node:net').Socket} socket */
function readRequest(socket) {
  return new Promise((resolvePromise) => {
    let text = '';
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8');
      const index = text.indexOf('\n');
      if (index >= 0) resolvePromise(JSON.parse(text.slice(0, index)));
    });
  });
}

/** An error's code, read through the client's own rejection rather than by inspecting internals. @param {unknown} error */
function codeOf(error) {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
}

/** A reply frame whose total wire size — body bytes plus its newline — is exactly `total`. @param {number} total @param {string} tag */
function replyOfExactSize(total, tag) {
  const overhead = Buffer.byteLength(JSON.stringify({ ok: true, value: { tag, pad: '' } })) + 1;
  assert.ok(total > overhead, `a frame of ${total} bytes cannot hold even an empty payload (needs > ${overhead})`);
  const fill = total - overhead;
  // Three-byte characters and then single bytes, so EVERY total is reachable and the padding is not
  // silently rounded to a multiple of three.
  const pad = '中'.repeat(Math.floor(fill / 3)) + 'x'.repeat(fill % 3);
  const body = JSON.stringify({ ok: true, value: { tag, pad } });
  assert.equal(Buffer.byteLength(body) + 1, total, 'the constructed frame must be exactly this size');
  return body;
}

/**
 * A reply frame of exactly `total` wire bytes whose LAST payload character is three bytes wide.
 *
 * This exists so a delivery split can be placed INSIDE a character rather than near one. The tail of a
 * JSON frame is `"}` plus the newline — four ASCII bytes — so subtracting a couple of bytes from the end
 * splits quoted ASCII and proves nothing about multi-byte handling. Here the padding ENDS in `中`, and the
 * case locates that character's real byte offset instead of assuming one.
 * @param {number} total @param {string} tag
 */
function replyOfExactSizeEndingInMultibyte(total, tag) {
  const overhead = Buffer.byteLength(JSON.stringify({ ok: true, value: { tag, pad: '' } })) + 1;
  const fill = total - overhead;
  assert.ok(fill >= 3, `a frame of ${total} bytes cannot hold a three-byte character (needs ${fill} free bytes)`);
  const pad = `${'x'.repeat(fill - 3)}中`;
  const body = JSON.stringify({ ok: true, value: { tag, pad } });
  assert.equal(Buffer.byteLength(body) + 1, total, 'the constructed frame must be exactly this size');
  return body;
}

/**
 * Locate the wire bytes and the interior offset of the last three-byte character in a frame.
 *
 * The assertions here are the point: they state that the split really does fall inside the character —
 * the first part ends with the character's LEADING byte and the second begins with a CONTINUATION byte —
 * and that the two parts rejoin into the bytes that were sent, so the oracle cannot be satisfied by a
 * split somewhere in the JSON punctuation.
 * @param {Buffer} bytes the whole frame, newline included
 */
function splitInsideLastCharacter(bytes) {
  const wide = Buffer.from('中', 'utf8');
  assert.equal(wide.length, 3, 'this case is written for a three-byte character');
  const at = bytes.lastIndexOf(wide);
  assert.ok(at >= 0, 'the frame must contain the wide character it was built around');
  assert.ok(bytes.subarray(at, at + 3).equals(wide), 'the located offset must hold the whole sequence');
  const cut = at + 1;
  const first = bytes.subarray(0, cut);
  const second = bytes.subarray(cut);
  assert.equal(first[first.length - 1], wide[0], 'the first delivery must end on the character\'s leading byte');
  assert.ok(first[first.length - 1] >= 0xc0, 'a leading byte is >= 0xc0, so the character really is cut open');
  assert.equal(second.length > 0 && second[0] >= 0x80 && second[0] < 0xc0, true,
    'the second delivery must begin with a continuation byte (0x80-0xbf)');
  assert.ok(Buffer.concat([first, second]).equals(bytes), 'and the two parts must rejoin into what was sent');
  return { cut, first, second };
}

export default {
  'two replies delivered in ONE write are both answered, though together they exceed the per-reply bound': async () => {
    // THE COALESCING BOUNDARY, and the defect this case exists for. A `data` event is a delivery, not a
    // protocol frame: the kernel may hand over two complete replies at once. The client added the whole
    // chunk to a counter and compared THAT against a per-reply budget, so two legal replies were refused
    // together — the bound rejecting traffic it was not about — and every pending caller was failed for
    // it. Each reply here is comfortably inside the bound and the pair is comfortably outside it.
    const CAP_LOCAL = 512;
    const pairs = 12;
    /** @param {number} n */
    const pairFor = (n) => [replyOfExactSize(300, `p${n}a`), replyOfExactSize(300, `p${n}b`)];
    for (const body of pairFor(1)) {
      assert.ok(Buffer.byteLength(body) + 1 <= CAP_LOCAL, 'each reply must be inside the bound');
    }
    assert.ok(pairFor(1).reduce((sum, body) => sum + Buffer.byteLength(body) + 1, 0) > CAP_LOCAL,
      'and the pair must together exceed it, or this case proves nothing');

    const p = await peer('coalesced', (socket) => {
      let text = '';
      let seen = 0;
      socket.on('data', (chunk) => {
        text += chunk.toString('utf8');
        let index = text.indexOf('\n');
        while (index >= 0) {
          const line = text.slice(0, index);
          text = text.slice(index + 1);
          if (line.includes('"tail"')) {
            // The probe at the end, answered on its own so the case can tell "the later request got its
            // own reply" from "a queued earlier frame was handed to it".
            socket.write(`${replyOfExactSize(300, 'tail-only')}\n`);
          } else {
            seen += 1;
            // Every SECOND request is answered together with the one before it, in a single write.
            if (seen % 2 === 0) {
              const [a, b] = pairFor(seen / 2);
              socket.write(`${a}\n${b}\n`);
            }
          }
          index = text.indexOf('\n');
        }
      });
    });
    const client = new IpcClient({ socketPath: p.socketPath, maxReplyBytes: CAP_LOCAL });
    try {
      for (let n = 1; n <= pairs; n += 1) {
        const [first, second] = await Promise.all([
          client.request({ op: 'pair', part: `${n}a` }),
          client.request({ op: 'pair', part: `${n}b` }),
        ]);
        // Each caller must receive ITS OWN reply, in order: a coalesced delivery still has to be split
        // into frames and handed out one per waiter.
        assert.equal(/** @type {{tag?: string}} */ (first).tag, `p${n}a`, `pair ${n}: the first reply must be the first caller's`);
        assert.equal(/** @type {{tag?: string}} */ (second).tag, `p${n}b`, `pair ${n}: the second reply must be the second caller's`);
      }
      // And nothing was polluted by the pairing: a later request gets its own reply.
      const tail = /** @type {{tag?: string}} */ (await client.request({ op: 'tail' }));
      assert.equal(tail.tag, 'tail-only', 'a later request must be answered from its own frame, not a queued earlier one');
      assert.equal(client.pendingRequests, 0, 'no waiter may be left behind');
    } finally {
      client.close();
      await p.stop();
    }
  },

  'a frame split so that one delivery carries its tail and the next frame\'s head is parsed as two frames': async () => {
    // The other shape of the same mistake: one delivery holding the END of one frame and the BEGINNING of
    // another. Nothing about the reply boundary lines up with the delivery boundary, and both frames must
    // come out whole with their own byte counts.
    const CAP_LOCAL = 512;
    const p = await peer('straddle', (socket) => {
      let text = '';
      let seen = 0;
      socket.on('data', (chunk) => {
        text += chunk.toString('utf8');
        let index = text.indexOf('\n');
        while (index >= 0) {
          text = text.slice(index + 1);
          seen += 1;
          index = text.indexOf('\n');
          if (seen !== 2) continue;
          const first = JSON.stringify({ ok: true, value: { tag: 'straddle-1', pad: 'y'.repeat(120) } });
          const second = JSON.stringify({ ok: true, value: { tag: 'straddle-2', pad: 'z'.repeat(120) } });
          const both = Buffer.from(`${first}\n${second}\n`, 'utf8');
          // One write: `splitAt` is inside the first frame's JSON, so the delivery boundary falls in the
          // middle of a frame rather than at a newline. The second write carries the rest.
          const splitAt = Math.floor(Buffer.byteLength(first, 'utf8') / 2);
          socket.write(both.subarray(0, splitAt));
          setTimeout(() => socket.write(both.subarray(splitAt)), 5);
        }
      });
    });
    const client = new IpcClient({ socketPath: p.socketPath, maxReplyBytes: CAP_LOCAL });
    try {
      const [first, second] = await Promise.all([
        client.request({ op: 'straddle' }),
        client.request({ op: 'straddle' }),
      ]);
      assert.equal(/** @type {{tag?: string}} */ (first).tag, 'straddle-1', 'the frame whose tail arrived first must be delivered');
      assert.equal(/** @type {{tag?: string}} */ (second).tag, 'straddle-2', 'and the frame whose head came with it must follow');
      assert.equal(client.pendingRequests, 0, 'both waiters must be settled');
    } finally {
      client.close();
      await p.stop();
    }
  },

  'a reply of exactly the bound is accepted and one byte more is refused, with the last character split across deliveries': async () => {
    // The boundary itself, asserted on both sides of it, and delivered in the shape that used to be
    // miscounted: the frame's final multi-byte character arrives in the NEXT delivery, so any accounting
    // done on the decoded remainder would be short by that character's leading bytes.
    //
    // The split is placed by LOCATING the wide character's byte offset, not by subtracting a constant from
    // the frame length: a JSON frame ends with `"}` and a newline, so a constant offset splits quoted ASCII
    // and would leave this case proving nothing about multi-byte handling while appearing to.
    const CAP_LOCAL = 512;
    const atBound = Buffer.from(`${replyOfExactSizeEndingInMultibyte(CAP_LOCAL, 'at-bound')}\n`, 'utf8');
    const overBound = Buffer.from(`${replyOfExactSizeEndingInMultibyte(CAP_LOCAL + 1, 'over-bound')}\n`, 'utf8');
    assert.equal(atBound.length, CAP_LOCAL, 'the accepted frame is exactly the bound, terminator included');
    assert.equal(overBound.length, CAP_LOCAL + 1, 'and the refused one is exactly one byte more');
    // These assertions are the evidence that the delivery boundary is inside the character: `first` ends on
    // the three-byte character's leading byte, `second` starts on a continuation byte, and the two rejoin
    // into the frame that was sent.
    const atSplit = splitInsideLastCharacter(atBound);
    const overSplit = splitInsideLastCharacter(overBound);
    assert.ok(atSplit.cut < atBound.length - 4, 'the split must be inside the payload, not in the JSON tail');

    const p = await peer('boundary', (socket) => {
      let text = '';
      let seen = 0;
      socket.on('data', (chunk) => {
        text += chunk.toString('utf8');
        let index = text.indexOf('\n');
        while (index >= 0) {
          text = text.slice(index + 1);
          seen += 1;
          index = text.indexOf('\n');
          const { first, second } = seen === 1 ? atSplit : overSplit;
          socket.write(first);
          setTimeout(() => socket.write(second), 5);
        }
      });
    });
    const client = new IpcClient({ socketPath: p.socketPath, maxReplyBytes: CAP_LOCAL });
    try {
      const accepted = /** @type {{tag?: string}} */ (await client.request({ op: 'boundary' }));
      assert.equal(accepted.tag, 'at-bound', 'a frame of exactly the bound must be accepted, not rounded down');
      assert.equal(client.pendingRequests, 0, 'and its waiter must be settled');

      const refused = await client.request({ op: 'boundary' }).then(
        () => { throw new Error('a frame one byte over the bound must be refused'); },
        (thrown) => thrown,
      );
      assert.equal(codeOf(refused), 'OVERSIZE', `one byte over must be refused, got ${codeOf(refused)}`);
      assert.equal(/** @type {{details?: {receivedBytes?: number}}} */ (refused).details?.receivedBytes, CAP_LOCAL + 1,
        'and the refusal must report the frame size that crossed the bound, not a delivery size');
      assert.equal(client.pendingRequests, 0, 'a refused connection must leave no waiter behind');
    } finally {
      client.close();
      await p.stop();
    }
  },

  'a delivery holding one complete reply plus the start of the next, cut inside a character, crosses neither frames nor waiters': async () => {
    // The combined shape, and the one that is easiest to get wrong in a way no single-frame case can see:
    // one `data` event carries a COMPLETE frame (whose size must be spent against the budget and then
    // released) followed by a PARTIAL frame whose bytes are sitting inside a three-byte character. The
    // first frame must be delivered to its own waiter, the partial bytes must be held and completed by the
    // next delivery, and neither waiter may receive the other's reply.
    const CAP_LOCAL = 512;
    const first = Buffer.from(`${replyOfExactSize(300, 'first-reply')}\n`, 'utf8');
    const second = Buffer.from(`${replyOfExactSizeEndingInMultibyte(300, 'second-reply')}\n`, 'utf8');
    assert.ok(first.length <= CAP_LOCAL && second.length <= CAP_LOCAL, 'each frame must be inside the bound');
    const { first: secondHead, second: secondTail, cut } = splitInsideLastCharacter(second);
    assert.ok(cut > 10, 'the partial frame must carry real bytes before its cut character');

    const p = await peer('tp', (socket) => {
      let text = '';
      let seen = 0;
      socket.on('data', (chunk) => {
        text += chunk.toString('utf8');
        let index = text.indexOf('\n');
        while (index >= 0) {
          const line = text.slice(0, index);
          text = text.slice(index + 1);
          seen += 1;
          index = text.indexOf('\n');
          if (line.includes('"probe"')) {
            socket.write(`${replyOfExactSize(300, 'probe-reply')}\n`);
            continue;
          }
          if (seen !== 2) continue;
          // ONE delivery: the whole of the first reply, then the second reply up to the middle of its
          // final character. The rest follows in a later delivery.
          socket.write(Buffer.concat([first, secondHead]));
          setTimeout(() => socket.write(secondTail), 5);
        }
      });
    });
    const client = new IpcClient({ socketPath: p.socketPath, maxReplyBytes: CAP_LOCAL });
    try {
      const [one, two] = await Promise.all([
        client.request({ op: 'burst', part: 'one' }),
        client.request({ op: 'burst', part: 'two' }),
      ]);
      assert.equal(/** @type {{tag?: string}} */ (one).tag, 'first-reply',
        'the complete frame in that delivery must go to its own waiter');
      assert.equal(/** @type {{tag?: string}} */ (two).tag, 'second-reply',
        'and the frame completed by the NEXT delivery must go to the other, decoded from its first byte');
      assert.equal(client.pendingRequests, 0, 'nothing may be left waiting after a frame straddles deliveries');
      const probe = /** @type {{tag?: string}} */ (await client.request({ op: 'probe' }));
      assert.equal(probe.tag, 'probe-reply', 'and a later request must still get its own reply, not a held one');
      assert.equal(client.pendingRequests, 0, 'the pairing must be back to one reply per waiter');
    } finally {
      client.close();
      await p.stop();
    }
  },

  'the daemon serves two request lines delivered in one write, each legal and together over the per-line bound': async () => {
    // The server's half of the same mistake, and the reason it is fixed in this module too: the daemon
    // added every byte that arrived in a chunk to one counter and compared it against a budget named per
    // REQUEST LINE, so two pipelined requests batched into one write were refused together — a client that
    // batched its requests would have its connection destroyed for being efficient.
    const { startIpcServer, ensureAuthorityToken } = await import('../../dist/lib/ipc.js');
    const scratch = scratchDir('ipc-server-coalesced');
    const lineCap = 512;
    ensureAuthorityToken(scratch.dir);
    /** @type {{op?: string}[]} */
    const handled = [];
    const server = await startIpcServer({
      stateDir: scratch.dir,
      maxRequestBytes: lineCap,
      maxReplyBytes: 4096,
      handle: async (request) => {
        handled.push(/** @type {{op?: string}} */ (request));
        return { op: /** @type {{op?: string}} */ (request).op, ok: true };
      },
    });
    try {
      /** @param {string} op @param {number} pad */
      const lineOfExactSize = (op, pad) => {
        const body = JSON.stringify({ op, pad: 'x'.repeat(pad) });
        assert.ok(Buffer.byteLength(body, 'utf8') + 1 <= lineCap, 'each request line must be inside the bound');
        return body;
      };
      const first = lineOfExactSize('first', 300);
      const second = lineOfExactSize('second', 300);
      assert.ok(Buffer.byteLength(first, 'utf8') + Buffer.byteLength(second, 'utf8') + 2 > lineCap,
        'the two lines together must exceed the bound, or this case proves nothing');

      const replies = await new Promise((resolvePromise, rejectPromise) => {
        const socket = connect(server.path);
        const timer = setTimeout(() => rejectPromise(new Error('the server never answered both lines')), 5000);
        const out = [];
        let text = '';
        socket.on('error', (error) => { clearTimeout(timer); rejectPromise(error); });
        socket.on('data', (chunk) => {
          text += chunk.toString('utf8');
          let index = text.indexOf('\n');
          while (index >= 0) {
            out.push(JSON.parse(text.slice(0, index)));
            text = text.slice(index + 1);
            if (out.length === 2) {
              clearTimeout(timer);
              socket.end();
              resolvePromise(out);
              return;
            }
            index = text.indexOf('\n');
          }
        });
        socket.on('connect', () => {
          // ONE write carrying both complete request lines.
          socket.write(`${first}\n${second}\n`);
        });
      });
      assert.equal(handled.length, 2, `both request lines must be handled, got ${handled.length}`);
      assert.deepEqual(replies.map((reply) => reply.value?.op), ['first', 'second'],
        'and both must be answered, in order, which is what the per-connection chain is for');
    } finally {
      await server.close();
      scratch.cleanup();
    }
  },

  'a peer that never sends a newline is refused on received bytes instead of being buffered forever': async () => {
    // A peer that accepts a request and then sends bytes for ever, with no newline in any of them. Before
    // the bound existed this grew the client's buffer until the process ran out of memory, which is a
    // denial of service against a gateway by whatever is on the other end of the socket.
    const p = await peer('no-newline', (socket) => {
      readRequest(socket).then(() => {
        const filler = Buffer.alloc(1024, 0x61);
        const timer = setInterval(() => {
          if (socket.destroyed) { clearInterval(timer); return; }
          socket.write(filler);
        }, 1);
        socket.on('close', () => clearInterval(timer));
      }).catch(() => { /* the client is allowed to go away first */ });
    });
    const client = new IpcClient({ socketPath: p.socketPath, maxReplyBytes: CAP });
    try {
      const started = Date.now();
      const error = await client.request({ op: 'health' }).then(
        () => { throw new Error('the request must NOT resolve: the peer never sent a frame'); },
        (thrown) => thrown,
      );
      const elapsed = Date.now() - started;
      assert.equal(codeOf(error), 'OVERSIZE',
        `the refusal must be the typed oversize, got ${codeOf(error)}: ${String(error?.message)}`);
      assert.equal(/** @type {{details?: {maxReplyBytes?: number}}} */ (error).details?.maxReplyBytes, CAP,
        'and it must name the bound that was applied');
      assert.ok(Number(/** @type {{details?: {receivedBytes?: number}}} */ (error).details?.receivedBytes) > CAP,
        'and the bytes actually received, which is the quantity the decision used');
      // Settled, not hung: the promise above resolved to a rejection, and it did so promptly rather than
      // waiting for a deadline that does not exist on this path.
      assert.ok(elapsed < 10_000, `the refusal must not wait for a deadline, took ${elapsed}ms`);
      assert.equal(client.pendingRequests, 0, 'no waiter may be left behind for a connection that failed');
    } finally {
      client.close();
      await p.stop();
    }
  },

  'a reply whose multi-byte characters are split across chunk boundaries is decoded exactly': async () => {
    // One byte per write, so every multi-byte character in the reply is split by construction rather
    // than by luck. `chunk.toString('utf8')` per chunk — what this client used to do — turns each split
    // sequence into U+FFFD that concatenation cannot repair, so this is the case that fails without a
    // streaming decoder. The text is read back through the client, which is the oracle.
    const expected = `中😀é漢-${'漢'.repeat(20)}`;
    const p = await peer('split', (socket) => {
      readRequest(socket).then((request) => {
        const frame = `${JSON.stringify({ ok: true, value: { text: expected, rpcId: request.rpcId } })}\n`;
        const bytes = Buffer.from(frame, 'utf8');
        let offset = 0;
        const timer = setInterval(() => {
          if (socket.destroyed || offset >= bytes.length) { clearInterval(timer); return; }
          socket.write(bytes.subarray(offset, offset + 1));
          offset += 1;
        }, 0);
        socket.on('close', () => clearInterval(timer));
      }).catch(() => { /* the client's assertions fail on their own */ });
    });
    const client = new IpcClient({ socketPath: p.socketPath, maxReplyBytes: CAP });
    try {
      const reply = /** @type {{text?: string}} */ (await client.request({ op: 'health', rpcId: 'r-1' }));
      assert.equal(reply.text, expected,
        'the reply text must survive a one-byte-per-chunk delivery unchanged');
      assert.ok(!String(reply.text).includes('\uFFFD'),
        'and must contain no replacement character, which is what a per-chunk decode produces');
    } finally {
      client.close();
      await p.stop();
    }
  },

  'the bound is per reply, so a long series of small replies is not refused': async () => {
    // The positive control for the bound: an implementation that counted ALL bytes over the connection
    // lifetime, or that never reset the counter, would pass the first case and fail every long-lived
    // gateway. Each frame here is small and there are many of them, so the total received is well above
    // the cap while no single reply is anywhere near it.
    let served = 0;
    const p = await peer('per-frame', (socket) => {
      let text = '';
      socket.on('data', (chunk) => {
        text += chunk.toString('utf8');
        let index = text.indexOf('\n');
        while (index >= 0) {
          const line = text.slice(0, index);
          text = text.slice(index + 1);
          index = text.indexOf('\n');
          served += 1;
          socket.write(`${JSON.stringify({ ok: true, value: { n: served, pad: 'x'.repeat(256) } })}\n`);
        }
      });
    });
    const client = new IpcClient({ socketPath: p.socketPath, maxReplyBytes: CAP });
    try {
      let total = 0;
      for (let i = 0; i < 40; i += 1) {
        const reply = /** @type {{n?: number}} */ (await client.request({ op: 'health' }));
        assert.equal(reply.n, i + 1, `reply ${i + 1} must be the one this request earned`);
        total += JSON.stringify(reply).length;
      }
      // 40 frames of ~280 characters: comfortably more than the 4 KiB cap in total.
      assert.ok(total > CAP, `the case must exceed the cap in total to mean anything, got ${total}`);
      assert.equal(served, 40, 'the peer must have answered every request exactly once');
    } finally {
      client.close();
      await p.stop();
    }
  },

  'a reply this client has no request for fails the connection rather than being paired with the wrong caller': async () => {
    // The client's one-reply-per-request pairing, and the hazard a future per-request deadline would
    // introduce. A peer sends TWO frames for one request: without the guard, the first frame would answer
    // this request and the second would sit in the pending queue until some LATER request shifted it off
    // and was handed a reply that was never its own — a silent mis-pairing, which is worse than a failure
    // because the caller believes it. This is not a demonstrated production failure: `request()` has no
    // deadline today, so the daemon cannot produce an unmatched frame. It is a hazard being closed, and
    // the test says so rather than presenting it as a bug that occurred.
    const p = await peer('double', (socket) => {
      readRequest(socket).then((request) => {
        socket.write(`${JSON.stringify({ ok: true, value: { which: 'first', rpcId: request.rpcId } })}\n`);
        socket.write(`${JSON.stringify({ ok: true, value: { which: 'second' } })}\n`);
      }).catch(() => { /* the client's assertions fail on their own */ });
    });
    const client = new IpcClient({ socketPath: p.socketPath, maxReplyBytes: CAP });
    try {
      const first = /** @type {{which?: string}} */ (await client.request({ op: 'health' }));
      assert.equal(first.which, 'first', 'the request must get its own reply');
      // The stray frame must fail the connection, and the NEXT caller must be told, not answered with
      // someone else's reply.
      const error = await client.request({ op: 'health' }).then(
        () => { throw new Error('a caller must never be handed a reply that was not its own'); },
        (thrown) => thrown,
      );
      assert.ok(['HOST_PROTOCOL', 'HOST_UNREACHABLE'].includes(codeOf(error)),
        `the second caller must learn the connection is no longer trustworthy, got ${codeOf(error)}`);
      assert.equal(client.pendingRequests, 0, 'and no waiter may be left behind');
    } finally {
      client.close();
      await p.stop();
    }
  },

  'the daemon decodes a request split mid-character: a multi-byte label written one byte at a time arrives whole': async () => {
    // The SERVER side of the same framing question, and the reason it is not enough to fix one end. The
    // daemon read raw Buffers and counted them honestly, but it still assembled text with
    // `chunk.toString('utf8')` per chunk — so a request whose multi-byte text straddled a chunk boundary
    // arrived with a replacement character where the peer had sent a character. A `session.prompt` with
    // Chinese text, split by the kernel at an unlucky byte, was stored and forwarded corrupted.
    //
    // The oracle is the daemon's own reply: `task.ensure` echoes the label it stored, so the string that
    // comes back is the one the daemon decoded from the raw frame. One byte per write means every
    // multi-byte character is split by construction, not by luck.
    const host = await new FakeHost().start();
    const scratch = scratchDir('ipc-server-decode');
    const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir: join(scratch.dir, 'state') });
    try {
      const label = `任务-${'中'.repeat(8)}-😀-end`;
      const frame = `${JSON.stringify({ op: 'task.ensure', clientKey: 'split-label', label })}\n`;
      const bytes = Buffer.from(frame, 'utf8');
      assert.ok(bytes.length > label.length * 2,
        'the frame must be long enough that splitting it is meaningful');
      const reply = await new Promise((resolvePromise, rejectPromise) => {
        const socket = connect(daemon.socketPath);
        let text = '';
        socket.on('error', rejectPromise);
        socket.on('data', (chunk) => {
          text += chunk.toString('utf8');
          const index = text.indexOf('\n');
          if (index < 0) return;
          socket.end();
          resolvePromise(JSON.parse(text.slice(0, index)));
        });
        socket.on('connect', () => {
          let offset = 0;
          const timer = setInterval(() => {
            if (offset >= bytes.length) { clearInterval(timer); return; }
            socket.write(bytes.subarray(offset, offset + 1));
            offset += 1;
          }, 0);
        });
      });
      const value = /** @type {{value?: {task?: {label?: string}}}} */ (reply).value;
      assert.equal(value?.task?.label, label,
        'the daemon must decode a request that was split inside a character exactly as it was sent');
      assert.ok(!String(value?.task?.label).includes('\uFFFD'),
        'and must not turn a split character into a replacement character');
    } finally {
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    }
  },

  'the daemon refuses to WRITE a reply above the bound, so the two ends cannot disagree about what is deliverable': async () => {
    // The server half of the same bound, and the reason it is not merely a backstop: the client's limit is
    // meaningless if the daemon happily emits frames above it, because the caller would then see a dropped
    // connection instead of an answer. Every reply is measured as the SERIALISED LINE — envelope, payload
    // and newline — and one above the bound becomes a typed refusal the caller can read.
    //
    // Exercised directly against the server rather than through the daemon: the daemon's own event policy
    // refuses an undeliverable page first (see `test/persistence/event-page-vs-ipc-bound.test.mjs`), so a
    // case driven through it would never reach this line — which is how the backstop went untested until a
    // control showed the end-to-end case passing with the cap disabled.
    const { startIpcServer, ensureAuthorityToken } = await import('../../dist/lib/ipc.js');
    const scratch = scratchDir('ipc-server-cap');
    const limit = 4096;
    // The token the daemon creates before it starts listening; without it the endpoint refuses every peer
    // and this case would be measuring the authorization gate instead of the reply bound.
    ensureAuthorityToken(scratch.dir);
    const server = await startIpcServer({
      stateDir: scratch.dir,
      maxReplyBytes: limit,
      handle: async (request) => ({ op: /** @type {{op?: string}} */ (request).op, pad: 'x'.repeat(limit * 2) }),
    });
    try {
      const reply = await new Promise((resolvePromise, rejectPromise) => {
        const socket = connect(server.path);
        // Bounded: a promise with no deadline would hang the whole suite if the server never answered,
        // and a hang is not a finding a reader can act on.
        const timer = setTimeout(() => rejectPromise(new Error('the server never answered the request')), 5000);
        let text = '';
        socket.on('error', (error) => { clearTimeout(timer); rejectPromise(error); });
        socket.on('data', (chunk) => {
          text += chunk.toString('utf8');
          const index = text.indexOf('\n');
          if (index < 0) return;
          clearTimeout(timer);
          socket.end();
          resolvePromise(JSON.parse(text.slice(0, index)));
        });
        socket.on('connect', () => socket.write(`${JSON.stringify({ op: 'health' })}\n`));
      });
      assert.equal(reply.ok, false, 'an oversized reply must be a refusal, not a frame above the bound');
      assert.equal(reply.error?.code, 'RESULT_TOO_LARGE',
        `the refusal must be typed, got ${reply.error?.code}: ${reply.error?.message}`);
      assert.equal(reply.error?.details?.maxReplyBytes, limit, 'and it must name the bound that applied');
      // The op is carried so an operator can tell WHICH call produced an undeliverable answer.
      assert.equal(reply.error?.details?.op, 'health', 'and the operation whose reply was too large');
      // Measured against the bound itself rather than asserted from the constant: the refusal is small,
      // which is the point — the caller gets an answer instead of a connection that dies mid-frame.
      assert.ok(Buffer.byteLength(JSON.stringify(reply), 'utf8') < limit,
        'and the refusal must itself fit inside the bound');
    } finally {
      await server.close();
      scratch.cleanup();
    }
  },

  'the shipped reply bound is the same number on both ends, and above the largest reply the daemon can build': async () => {
    // Two ends of one socket must not disagree, and this asserts the agreement from the artifacts rather
    // than from a comment: the constant the client defaults to, the constant the configuration defaults
    // to, and the daemon's own configured value in a fresh config resolution.
    const { MAX_IPC_REPLY_BYTES } = await import('../../dist/lib/ipc.js');
    const { resolveConfig } = await import('../../dist/lib/config.js');
    const config = resolveConfig({ DSH_PILOT_STATE_DIR: join(scratchDir('ipc-defaults').dir, 'state') });
    assert.equal(config.limits.ipcReplyMaxBytes, MAX_IPC_REPLY_BYTES,
      'a fresh configuration must default to the shared IPC reply bound');
    // Above every reply the daemon can construct from its OWN limits, because a client bound below the
    // daemon's legitimate maximum would reject frames the daemon considers deliverable and the symptom
    // would be a dropped connection on a call that should have worked.
    assert.ok(MAX_IPC_REPLY_BYTES > config.limits.hostResponseMaxBytes,
      'the reply bound must exceed the host response bound, which any reply can carry');
    assert.ok(MAX_IPC_REPLY_BYTES > config.limits.eventPageMaxBytes,
      'and the event page bound, which limits a page rather than a frame');
    assert.ok(MAX_IPC_REPLY_BYTES > config.limits.eventMessageMaxBytes,
      'and the single-message bound, because one oversized event is delivered alone rather than dropped');
    // A client constructed with no explicit bound must use it, which is what every production caller does.
    const p = await peer('default', () => { /* accepts and says nothing */ });
    const client = new IpcClient({ socketPath: p.socketPath });
    try {
      assert.equal(client.maxReplyBytes, MAX_IPC_REPLY_BYTES,
        'and a client that was not given a bound must apply the shared one rather than none');
    } finally {
      client.close();
      await p.stop();
    }
  },
};
