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

export default {
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
