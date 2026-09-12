/**
 * Unit and contract layer.
 *
 * Why these tests exist: they are the cheapest place to pin the load-bearing invariants that
 * everything else assumes — id namespaces, idempotency-key conflicts, the durable-before-send
 * ordering, the uncertain state surviving a restart, version refusal, and the exclusive-lock
 * semantics the design depends on. Each test asserts an OBSERVABLE fact (a row in SQLite, a
 * file on disk, a refusal from a second handle) rather than an implementation detail.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, asRecord, ipcClient, must, mustString, scratchDir, skip } from '../helpers.mjs';

/**
 * The daemon refuses with a coded BridgeError; catch sites below assert on that code.
 * @typedef {import('../../dist/lib/errors.js').BridgeError} BridgeError
 */

export default {
  'id namespaces are separate and validated per kind': async () => {
    const { mintId, parseId, assertIdKind, isIdempotencyKey, payloadDigest } = await import('../../dist/lib/ids.js');
    const taskId = mintId('task');
    const sessionId = mintId('session');
    assert.match(taskId, /^task_[0-9a-f-]{36}$/);
    assert.match(sessionId, /^sess_[0-9a-f-]{36}$/);
    // Both ids are well-formed by construction, so each parse is the ok variant; the annotation
    // only states the field this assertion reads, it does not relax the expectation.
    const taskParsed = /** @type {{kind: string}} */ (parseId(taskId));
    const sessionParsed = /** @type {{kind: string}} */ (parseId(sessionId));
    assert.equal(taskParsed.kind, 'task');
    assert.equal(sessionParsed.kind, 'session');
    assert.equal(parseId('nope_123').ok, false);
    assert.equal(parseId('task_notauuid').ok, false);
    assert.throws(() => assertIdKind(sessionId, 'task'), /expected task id/);
    assert.equal(isIdempotencyKey('prompt:abc-123').ok, true);
    assert.equal(isIdempotencyKey('short').ok, false);
    assert.equal(isIdempotencyKey('bad key with spaces').ok, false);
    // Canonical payload digests: key order must not change identity.
    assert.equal(payloadDigest({ a: 1, b: 2 }), payloadDigest({ b: 2, a: 1 }));
    assert.notEqual(payloadDigest({ a: 1 }), payloadDigest({ a: 2 }));
  },

  'error taxonomy is closed and unknown codes are refused': async () => {
    const { ERROR_CODES, assertKnownCode, BridgeError, toBridgeError } = await import('../../dist/lib/errors.js');
    assert.ok(Object.keys(ERROR_CODES).length >= 30);
    assert.equal(assertKnownCode(ERROR_CODES.UNCERTAIN), 'UNCERTAIN');
    assert.throws(() => assertKnownCode('NOT_A_REAL_CODE'), /unknown error code/);
    const wrapped = toBridgeError(new BridgeError(ERROR_CODES.HOST_REFUSED, 'nope', { method: 'x' }));
    assert.equal(wrapped.code, 'HOST_REFUSED');
    assert.equal(wrapped.details.method, 'x');
    // A thrown plain error becomes internal, never a fabricated business code.
    assert.equal(toBridgeError(new Error('boom')).code, 'INTERNAL');
  },

  'capability negotiation reports unverified methods instead of assuming them': async () => {
    const { DshHostAdapter, PINNED_METHODS, PINNED_ERROR_CODES } = await import('../../dist/lib/adapter.js');
    const adapter = new DshHostAdapter({ baseUrl: 'http://127.0.0.1:1' });
    const caps = adapter.capabilities();
    assert.equal(caps.declared.length, PINNED_METHODS.length);
    assert.deepEqual(caps.probed, []);
    assert.equal(caps.unverified.length, PINNED_METHODS.length);
    assert.ok(PINNED_METHODS.includes('session.create'));
    assert.ok(PINNED_ERROR_CODES.includes('session-conflict'));
    // The pinned map must not silently gain methods: this is the drift tripwire's basis.
    assert.equal(new Set(PINNED_METHODS).size, PINNED_METHODS.length);
  },

  'host error details are sanitised: no unbounded or secret-looking blob passes through': async () => {
    const { sanitizeDetails } = await import('../../dist/lib/adapter.js');
    const details = sanitizeDetails({
      long: 'x'.repeat(1000),
      n: 5,
      flag: true,
      nothing: null,
      list: [1, 2, 3],
      nested: { deep: 'value' },
    });
    // Truncation is visible in the value itself, so a caller can tell a full string from a
    // shortened one instead of silently receiving a shorter message.
    const long = mustString(details.long, 'the sanitized `long` detail');
    assert.ok(long.length > 200 && long.length < 260, `unexpected truncation length ${long.length}`);
    assert.match(long, /\[truncated 800 chars\]$/);
    assert.equal(long.startsWith('x'.repeat(200)), true);
    assert.equal(details.n, 5);
    assert.equal(details.flag, true);
    assert.equal(details.list, '[3 items]');
    assert.equal(details.nested, '[object]');
    assert.deepEqual(sanitizeDetails(undefined), {});
  },

  'idempotency key returns the same operation, and a different payload is a conflict': async () => {
    const { Store } = await import('../../dist/lib/store.js');
    const scratch = scratchDir('store-idem');
    const store = new Store({ stateDir: join(scratch.dir, 'state') });
    try {
      const task = must(
        store.createTask({ taskId: 'task_11111111-1111-1111-1111-111111111111', hostBase: 'http://h', hostScope: 'h' }),
        'the task row created for the idempotency test',
      );
      const first = store.reserveOperation({
        taskId: task.task_id, kind: 'session.prompt', idempotencyKey: 'prompt:k1', payload: { text: 'a' },
      });
      assert.equal(first.created, true);
      const again = store.reserveOperation({
        taskId: task.task_id, kind: 'session.prompt', idempotencyKey: 'prompt:k1', payload: { text: 'a' },
      });
      assert.equal(again.created, false);
      // The same key must resolve to the SAME row, so this assertion is about the rows themselves:
      // both reads are required to be present, and the identity is compared as before.
      assert.equal(
        must(again.operation, 'the operation row resolved for the repeated key').operation_id,
        must(first.operation, 'the operation row reserved for the first key').operation_id,
      );
      assert.throws(() => store.reserveOperation({
        taskId: task.task_id, kind: 'session.prompt', idempotencyKey: 'prompt:k1', payload: { text: 'DIFFERENT' },
      }), /different payload/);
    } finally {
      store.close();
      scratch.cleanup();
    }
  },

  'durable-before-send: the dispatching row is committed before any network write': async () => {
    const { Store } = await import('../../dist/lib/store.js');
    const scratch = scratchDir('store-order');
    const stateDir = join(scratch.dir, 'state');
    const store = new Store({ stateDir });
    const taskId = 'task_22222222-2222-2222-2222-222222222222';
    store.createTask({ taskId, hostBase: 'http://h', hostScope: 'h' });
    const { operation } = store.reserveOperation({
      taskId, kind: 'session.prompt', idempotencyKey: 'prompt:order', payload: { text: 'x' },
    });
    // Every read below keys off this operation, so the row must be there; the store types it
    // nullable because "not found" is one of its honest outcomes.
    const operationId = must(operation, 'the operation row reserved before dispatch').operation_id;
    store.markDispatching({
      operationId, method: 'session.prompt', endpoint: '/api/session.prompt', payload: { text: 'x' },
    });
    // Read the state from a SEPARATE connection: this proves the row was committed, not just
    // staged in this process's memory. A crash right now means "possibly sent".
    const observer = new Store({ stateDir });
    try {
      const observed = must(observer.getOperation(operationId), 'the operation row read back over a second connection');
      assert.equal(observed.state, 'dispatching');
      const outbox = observer.get('select * from outbox where operation_id = ?', operationId);
      assert.equal(outbox.state, 'dispatching');
      const interrupted = observer.sweepInterruptedDispatches('crash-during-dispatch');
      assert.equal(interrupted.length, 1);
      const afterSweep = must(observer.getOperation(operationId), 'the operation row after the interrupted-dispatch sweep');
      assert.equal(afterSweep.state, 'uncertain');
      // Uncertain is not auto-resolved and not retried: the reason is preserved as evidence.
      assert.equal(afterSweep.uncertain_reason, 'crash-during-dispatch');
    } finally {
      observer.close();
      store.close();
      scratch.cleanup();
    }
  },

  'illegal operation transitions are refused, not coerced': async () => {
    const { Store } = await import('../../dist/lib/store.js');
    const scratch = scratchDir('store-illegal');
    const store = new Store({ stateDir: join(scratch.dir, 'state') });
    try {
      const taskId = 'task_33333333-3333-3333-3333-333333333333';
      store.createTask({ taskId, hostBase: 'http://h', hostScope: 'h' });
      const { operation } = store.reserveOperation({
        taskId, kind: 'session.cancel', idempotencyKey: 'cancel:1', payload: {},
      });
      const operationId = must(operation, 'the operation row reserved for the illegal-transition test').operation_id;
      // Acknowledging a never-dispatched operation is refused.
      assert.throws(() => store.markAcknowledged({ operationId, ok: true, value: {} }), /cannot acknowledge from state pending/);
      store.markDispatching({ operationId, method: 'session.cancel', endpoint: '/api/session.cancel', payload: {} });
      store.markAcknowledged({ operationId, ok: true, value: { accepted: true } });
      assert.equal(must(store.getOperation(operationId), 'the operation row after acknowledging').state, 'succeeded');
      // Resolving an uncertain operation that is not uncertain is refused.
      assert.throws(() => store.resolveUncertain({ operationId, resolution: 'failed', evidence: {} }), /cannot resolve from state succeeded/);
    } finally {
      store.close();
      scratch.cleanup();
    }
  },

  'a state file from a newer bridge is refused, not misread': async () => {
    const { Store, STATE_SCHEMA_VERSION } = await import('../../dist/lib/store.js');
    const { BridgeError } = await import('../../dist/lib/errors.js');
    const scratch = scratchDir('store-version');
    const stateDir = join(scratch.dir, 'state');
    const store = new Store({ stateDir });
    store.close();
    // Rewrite the version to a future one, then reopen.
    const sqlite = process.getBuiltinModule('node:sqlite');
    const db = new sqlite.DatabaseSync(join(stateDir, 'state.sqlite'));
    db.prepare('update meta set value = ? where key = ?').run(String(STATE_SCHEMA_VERSION + 1), 'schema_version');
    db.close();
    let caught = null;
    try {
      const reopened = new Store({ stateDir });
      reopened.close();
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof BridgeError, 'expected a typed refusal');
    assert.equal(caught.code, 'STATE_VERSION_UNSUPPORTED');
    assert.equal(caught.details.found, STATE_SCHEMA_VERSION + 1);
    scratch.cleanup();
  },

  'corrupt storage is reported with evidence preserved': async () => {
    const { Store } = await import('../../dist/lib/store.js');
    const scratch = scratchDir('store-corrupt');
    const stateDir = join(scratch.dir, 'state');
    const store = new Store({ stateDir });
    store.close();
    // Overwrite the database header with garbage: a corrupt file must fail loudly.
    const path = join(stateDir, 'state.sqlite');
    const bytes = readFileSync(path);
    bytes.write('NOT-A-SQLITE-DATABASE-AT-ALL', 0, 'utf8');
    writeFileSync(path, bytes);
    /** @type {BridgeError|null} */
    let caught = null;
    try {
      const reopened = new Store({ stateDir });
      reopened.close();
    } catch (error) {
      caught = /** @type {BridgeError} */ (error);
    }
    assert.ok(caught, 'a corrupt database must not open successfully');
    assert.equal(caught.code, 'STORAGE_CORRUPT');
    // Evidence preserved: the file still exists and was not deleted.
    assert.ok(readFileSync(path).length > 0);
    scratch.cleanup();
  },

  'exclusive ownership: a second handle is refused, and the holder keeps it while stopped': async () => {
    const { OwnerLock, probeLocking } = await import('../../dist/lib/owner-lock.js');
    const scratch = scratchDir('lock');
    const lockPath = join(scratch.dir, 'owner.lock.sqlite');
    const probe = probeLocking(lockPath);
    assert.equal(probe.supported, true, 'this platform must support the exclusion primitive');
    assert.equal(probe.secondRefused, true, 'a second handle must be refused while the first is held');
    const first = new OwnerLock({ lockPath });
    const second = new OwnerLock({ lockPath });
    assert.equal(first.tryAcquire().acquired, true);
    assert.equal(second.tryAcquire().acquired, false);
    // Releasing lets a new owner in without deleting any file.
    first.release();
    assert.equal(second.tryAcquire().acquired, true);
    second.release();
    scratch.cleanup();
  },

  'the daemon refuses to start when the state directory is already owned': async () => {
    const { startDaemon, scratchDir } = await import('../helpers.mjs');
    const { FakeHost } = await import('../fixtures/fake-host.mjs');
    const host = await new FakeHost().start();
    const scratch = scratchDir('owner-refuse');
    const stateDir = join(scratch.dir, 'state');
    let first = null;
    try {
      first = await startDaemon({ hostBase: host.baseUrl, stateDir });
      // A second daemon on the same state directory must fail closed with OWNER_HELD.
      const { spawnNode, collect } = await import('../helpers.mjs');
      const second = spawnNode(['dist/bin/dsh-pilot-daemon.js', '--state-dir', stateDir, '--host', host.baseUrl]);
      const outcome = await collect(second);
      assert.equal(outcome.code, 4, `expected exit 4 (owner held), got ${outcome.code}; stderr=${outcome.stderr}`);
      assert.match(outcome.stderr, /OWNER_HELD/);
    } finally {
      if (first) await first.stop();
      await host.stop();
      scratch.cleanup();
    }
  },

  'lock file inode is stable: nobody unlinks it, so a third party cannot lock a newer file': async () => {
    const { OwnerLock } = await import('../../dist/lib/owner-lock.js');
    const { statSync } = await import('node:fs');
    const scratch = scratchDir('lock-inode');
    const lockPath = join(scratch.dir, 'owner.lock.sqlite');
    const first = new OwnerLock({ lockPath });
    assert.equal(first.tryAcquire().acquired, true);
    const inodeBefore = statSync(lockPath).ino;
    const second = new OwnerLock({ lockPath });
    assert.equal(second.tryAcquire().acquired, false);
    const inodeAfter = statSync(lockPath).ino;
    assert.equal(inodeAfter, inodeBefore, 'the lock path must keep its inode while held');
    first.release();
    second.release();
    scratch.cleanup();
  },

  'store dedupe: the same native sequence can never become a second row': async () => {
    const { Store } = await import('../../dist/lib/store.js');
    const scratch = scratchDir('store-dedupe');
    const stateDir = join(scratch.dir, 'state');
    const store = new Store({ stateDir });
    try {
      const taskId = 'task_55555555-5555-5555-5555-555555555555';
      store.createTask({ taskId, hostBase: 'http://h', hostScope: 'h' });
      const session = must(store.recordSession({
        sessionId: 'sess_66666666-6666-6666-6666-666666666666',
        taskId,
        hostSessionId: 'session-fixture-0001',
        cwd: null,
      }), 'the session row recorded for the dedupe test');
      const first = store.appendEvent({ taskId, sessionId: session.session_id, seq: 1, kind: 'user/message', payload: { n: 1 } });
      assert.equal(first, true, 'the first write of a sequence must be recorded as inserted');
      const second = store.appendEvent({ taskId, sessionId: session.session_id, seq: 1, kind: 'user/message', payload: { n: 2 } });
      // The return value is load-bearing: a caller uses it to decide whether the store gained
      // anything, so the store must not report an ignored write as an insertion.
      assert.equal(second, false, 'a repeated sequence must be reported as NOT inserted');
      assert.equal(store.countEvents(taskId, session.session_id), 1, 'a repeated sequence must not add a row');
      assert.equal(store.hasEvent(taskId, session.session_id, 1), true);
      assert.equal(store.hasEvent(taskId, session.session_id, 2), false);
    } finally {
      store.close();
      scratch.cleanup();
    }
  },

  'IPC framing: bounded lines, malformed json refused, per-connection ordering preserved': async () => {    const { startIpcServer } = await import('../../dist/lib/ipc.js');
    const { NetConnectOptions } = {};
    const scratch = scratchDir('ipc');
    const server = await startIpcServer({
      stateDir: scratch.dir,
      handle: async (request) => {
        // The handler receives a frame that was parsed from JSON, so its shape is not known to
        // the transport; the test is what decides it is a record, once, here.
        const frame = asRecord(request, 'IPC request frame');
        if (frame.op === 'echo') return { echo: frame.value, at: Date.now() };
        throw new (await import('../../dist/lib/errors.js')).BridgeError('UNSUPPORTED', 'nope', {});
      },
    });
    // Routed through the shared `ipcClient` fixture rather than constructed here: the untyped
    // reply view is admitted at one documented boundary in `test/helpers.mjs`, not per suite.
    const client = await ipcClient(server.path);
    try {
      const first = await client.request({ op: 'echo', value: 1 });
      const second = await client.request({ op: 'echo', value: 2 });
      assert.equal(first.echo, 1);
      assert.equal(second.echo, 2);
      assert.ok(second.at >= first.at);
      // An unsupported op surfaces as a typed error, not a silent empty value.
      /** @type {BridgeError|null} */
      let caught = null;
      try { await client.request({ op: 'nope' }); } catch (error) { caught = /** @type {BridgeError} */ (error); }
      assert.equal(caught?.code, 'UNSUPPORTED');
    } finally {
      client.close();
      await server.close();
      scratch.cleanup();
    }
  },
};
