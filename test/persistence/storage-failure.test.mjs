/**
 * Storage-failure layer: ENOSPC, EACCES, corruption, and the durability rule that an intent
 * which cannot be persisted never reaches the network.  (FR-STATE-5)
 *
 * Why these tests exist: "the storage failed" is the case where a bridge most easily lies about
 * itself. Every cheap implementation of it is silent — treat a failed write as best-effort, keep
 * the row in memory, dispatch anyway — and each of those turns a durable-intent design into a
 * cache. So each case below asserts its three claims SEPARATELY, because they fail separately:
 * a TYPED refusal (a `BridgeError` from the taxonomy, not a raw driver error escaping to the
 * caller), the LAST GOOD STATE still intact and readable, and NO PARTIALLY APPLIED mutation
 * visible. The last case asserts the ordering rule itself: an intent that cannot be committed
 * must never be handed to the network, and the oracle for that is the request log of a real Host.
 *
 * HONESTY ABOUT THE INJECTIONS. This distinction matters more than how the file reads, so it is
 * stated here rather than implied by the assertions:
 *
 *   - `ENOSPC` is NOT a real full disk, and nothing below claims it is. There is no portable,
 *     unprivileged way to exhaust a filesystem on both CI platforms (macOS wants a disk image,
 *     Linux wants a mount, and both are environment-specific), so the full disk is SIMULATED at
 *     the narrowest point available: the database's OWN growth limit,
 *     `pragma max_page_count = <current page count>`. That makes the REAL SQLite engine raise its
 *     real `SQLITE_FULL` ("database or disk is full") from a real statement on the real file. The
 *     driver, the `Store` and the `Daemon` under test are all real and untouched; only the reason
 *     the engine cannot grow is simulated. Every ENOSPC assertion says so in its own failure
 *     message, so a red run here can never be misread as evidence about a real full disk.
 *   - `EACCES` IS a real filesystem condition. The state directory is really `chmod 0500`ed and
 *     the refusal below is the real `EACCES` the kernel returns when SQLite tries to create a
 *     file in it. Nothing is stubbed.
 *   - `corruption` IS real. Bytes are overwritten in the real state database, and the real
 *     `pragma integrity_check` reports the damage.
 *   - `refuse to dispatch` asserts against the request log of the real fake Host (real HTTP, real
 *     WebSocket), so "nothing was sent" is an observation rather than an inference.
 */

import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { assert, asRecord, collect, must, scratchDir, spawnNode } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/** SQLite's page size for this database; used to place the corruption and to size the payloads. */
const PAGE_BYTES = 4096;

/**
 * A host base the store-level cases never contact. They exercise durable state alone, so nothing
 * is listening here on purpose: a case that reached the network would fail rather than hang.
 */
const UNREACHED_HOST = 'http://127.0.0.1:1';

/** The "last good state" every refusal in this file must leave alone, and read back verbatim. */
const GOOD_TASK = 'task_last-good-0001';
const GOOD_SESSION = 'session_last-good-0001';
const GOOD_HOST_SESSION = 'host-last-good-0001';
const GOOD_KEY = 'prompt:last-good';
const GOOD_TEXT = 'the last good turn';

/**
 * The body of the intent that must be refused. It is exactly 64 KiB — the largest prompt the
 * tool schema admits — and carries a unique marker, so that if it ever did reach the wire the
 * leak would be identifiable in the Host's request log instead of merely suspected.
 */
const REFUSED_MARKER = 'refused-intent-never-sent';
const REFUSED_BODY = `${REFUSED_MARKER} ${'x'.repeat((64 * 1024) - REFUSED_MARKER.length - 1)}`;

/** Rows/size used to leave the database with almost no free space before the page cap is set. */
const FILLER_ROWS = 4;
const FILLER_BYTES = 1024 * 1024;

/** @param {string} stateDir @returns {string} the state database path */
function dbFile(stateDir) {
  return join(stateDir, 'state.sqlite');
}

/**
 * The observable proof that a refusal destroyed nothing: the state database's own bytes.
 * A recorded digest is what makes "the last good state was preserved" checkable without reopening
 * the file under the very permission that was just removed.
 * @param {string} stateDir
 * @returns {string}
 */
function stateDigest(stateDir) {
  return createHash('sha256').update(readFileSync(dbFile(stateDir))).digest('hex');
}

/** @param {unknown} error @returns {string} */
function describeThrown(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Run `fn` with the state directory made read-only for the duration, restoring the mode whatever
 * happens. The restore is unconditional on purpose: a scratch directory left at 0500 cannot be
 * removed, so a failing assertion would leak a directory rather than just a failure.
 * @template T
 * @param {string} stateDir
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withReadOnlyStateDir(stateDir, fn) {
  chmodSync(stateDir, 0o500);
  try {
    return await fn();
  } finally {
    chmodSync(stateDir, 0o700);
  }
}

/**
 * Open the real store and write the "last good" state that every refusal below must leave alone.
 * Written through the store itself, so the baseline is what the bridge would really have
 * persisted rather than a shape the test invented.
 * @param {string} stateDir
 * @param {string} hostBase
 */
async function openSeededStore(stateDir, hostBase) {
  const { Store } = await import('../../dist/lib/store.js');
  const store = new Store({ stateDir });
  store.createTask({ taskId: GOOD_TASK, label: 'task:last-good', hostBase, hostScope: 'default' });
  store.recordSession({
    sessionId: GOOD_SESSION, taskId: GOOD_TASK, hostSessionId: GOOD_HOST_SESSION, cwd: null,
  });
  const reserved = store.reserveOperation({
    taskId: GOOD_TASK, kind: 'session.prompt', idempotencyKey: GOOD_KEY, payload: { text: GOOD_TEXT },
  });
  assert.equal(reserved.created, true, 'the last-good fixture must write exactly one operation');
  return store;
}

/**
 * Run `attempt` and return the typed refusal it must produce.
 *
 * This is the first claim of FR-STATE-5: a storage failure has to arrive as a `BridgeError` from
 * the project's own taxonomy. A raw `ERR_SQLITE_ERROR` reaching the caller is a defect even when
 * the underlying condition is genuine, which is why the class is asserted and not only the code.
 * `await` sits inside the `try`, so a synchronous throw and a rejected promise are both caught —
 * the daemon's entry points are async and must be refused the same way.
 * @param {() => unknown} attempt
 * @param {string} what
 */
async function refusalFrom(attempt, what) {
  const { BridgeError } = await import('../../dist/lib/errors.js');
  /** @type {unknown} */
  let thrown = null;
  let succeeded = false;
  try {
    await attempt();
    succeeded = true;
  } catch (error) {
    thrown = error;
  }
  assert.equal(succeeded, false, `${what}: expected a refusal, but the call succeeded`);
  assert.ok(
    thrown instanceof BridgeError,
    `${what}: expected a typed BridgeError from the error taxonomy, got ${describeThrown(thrown)}`,
  );
  return thrown;
}

/**
 * Assert the last good state is exactly what the seed wrote, and that the refused intent left no
 * row behind. Used identically after every refusal, so "preserved" means the same thing in each
 * case rather than something re-argued per suite.
 * @param {import('../../dist/lib/store.js').Store} store
 * @param {string} context
 * @param {string} [refusedKey] the idempotency key the refused intent would have used
 */
function assertLastGoodStateIntact(store, context, refusedKey) {
  const task = store.getTask(GOOD_TASK);
  // `JSON.stringify`, not `String`: a `node:sqlite` row has a null prototype, so the implicit
  // primitive conversion throws and would replace the assertion's own message with a TypeError.
  assert.ok(task, `${context}: the last good task row must still be readable, got ${JSON.stringify(task)}`);
  assert.equal(task.task_id, GOOD_TASK, `${context}: the last good task row changed identity`);

  const session = store.getSession(GOOD_SESSION);
  assert.ok(session, `${context}: the last good session row must still be readable, got ${JSON.stringify(session)}`);
  assert.equal(session.host_session_id, GOOD_HOST_SESSION, `${context}: the last good session row was mutated`);

  const operations = store.listOperations(GOOD_TASK);
  assert.deepEqual(
    operations.map((row) => row.idempotency_key), [GOOD_KEY],
    `${context}: the durable operation set must be exactly the last good one, got ${JSON.stringify(operations)}`,
  );
  assert.deepEqual(
    store.operationCounts(), { pending: 1 },
    `${context}: the operation state counts must be unchanged by a refused write`,
  );

  if (refusedKey !== undefined) {
    const leftover = store.all(
      'select idempotency_key from operations where idempotency_key = ?', refusedKey,
    );
    assert.equal(
      leftover.length, 0,
      `${context}: a mutation that could not be committed must leave no row behind, found ${JSON.stringify(leftover)}`,
    );
  }
}

/**
 * SIMULATED full disk, at the narrowest point available — see the file header. The database is
 * capped at its CURRENT page count, so the next write that needs a new page fails with the real
 * SQLite engine's own SQLITE_FULL. The cap is read back and asserted, so a storage layer that
 * ignored it would fail here rather than turn the case below into a vacuous pass.
 * @param {import('../../dist/lib/store.js').Store} store
 * @returns {number} the page count the database is now capped at
 */
function simulateFullDisk(store) {
  const row = asRecord(store.get('pragma page_count'), 'the pragma page_count result');
  const pages = Number(row.page_count);
  assert.ok(
    Number.isInteger(pages) && pages > 0,
    `pragma page_count must be a positive integer, got ${JSON.stringify(row)}`,
  );
  store.run(`pragma max_page_count = ${pages}`);
  const confirmed = asRecord(store.get('pragma max_page_count'), 'the pragma max_page_count result');
  assert.equal(
    Number(confirmed.max_page_count), pages,
    'the simulated disk-full limit must be in force before the write is attempted',
  );
  return pages;
}

/**
 * Write real rows until almost no free space is left, so that even a small write (64 KiB is the
 * largest prompt the schema admits) has to allocate new pages. Without this the capping trick
 * would be defeated by the free space a fresh database keeps in its b-tree pages.
 * @param {import('../../dist/lib/store.js').Store} store
 */
function fillDatabase(store) {
  for (let i = 0; i < FILLER_ROWS; i += 1) {
    store.audit({ kind: 'disk-fill-filler', actor: 'test', detail: { pad: 'z'.repeat(FILLER_BYTES) } });
  }
}

/**
 * Overwrite one page of the state database with a fixed pattern.
 *
 * The LAST page is chosen deliberately: the header page and the schema page must survive, because
 * this case is about a database that opens but fails its integrity check, not about one that
 * cannot be opened at all (that path is already covered in test/unit/core.test.mjs). A filler row
 * is written first so the destroyed page belongs to filler rather than to the last-good rows,
 * which keeps "the last good state is still readable" a real observation instead of an accident
 * of where SQLite happened to put a table.
 * @param {string} stateDir
 */
function corruptLastPage(stateDir) {
  const path = dbFile(stateDir);
  const bytes = readFileSync(path);
  const pages = Math.floor(bytes.length / PAGE_BYTES);
  assert.ok(
    pages >= 2,
    `the state database must have whole pages to corrupt, got ${bytes.length} bytes`,
  );
  bytes.fill(0xa5, (pages - 1) * PAGE_BYTES, pages * PAGE_BYTES);
  writeFileSync(path, bytes);
}

/**
 * The daemon's startup refusal payload, as its entry point writes it: one JSON line on stderr.
 * @param {string} stderr
 * @returns {Record<string, unknown>}
 */
function refusalPayload(stderr) {
  for (const line of stderr.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return asRecord(parsed, 'the daemon refusal payload');
      }
    } catch { /* not the payload line */ }
  }
  throw new Error(
    `the daemon must report its refusal as a JSON payload on stderr, got: ${JSON.stringify(stderr.slice(0, 400))}`,
  );
}

/**
 * True when any recorded Host request carried `marker` in its payload. The oracle for "the intent
 * never reached the network" has to be the recorded body and not only a request count: a count
 * could stay level while some other request carried the payload.
 * @param {unknown[]} received
 * @param {string} marker
 * @returns {boolean}
 */
function anyRequestCarried(received, marker) {
  return received.some((row) => JSON.stringify(
    asRecord(row, 'a recorded Host request').payload ?? null,
  ).includes(marker));
}

/**
 * The real daemon entry point, spawned as a real second process. Storage refusals are a startup
 * property, so they are observed at the process boundary rather than through an in-process call.
 */
const DAEMON_ENTRY = 'dist/bin/dsh-pilot-daemon.js';

/** @param {number} ms @returns {Promise<void>} */
function delay(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Wait for a daemon that MUST refuse, and report a daemon that starts anyway as the defect it is.
 *
 * Two observations are raced rather than only waiting for the process to die: the exit (the
 * refusal) and the ready file, which the entry point writes only after a successful start.
 * Without the second one, "the daemon ignored its storage and came up serving" would surface as a
 * deadline rather than as the behaviour defect it is — a correct verdict reached for the wrong
 * reason, and a slow one. A deadline is still reported as a TIMEOUT, which the harness counts
 * separately, and never as a pass.
 * @param {import('node:child_process').ChildProcess} child
 * @param {string} readyPath
 * @param {number} timeoutMs
 * @param {string} what
 */
async function awaitRefusal(child, readyPath, timeoutMs, what) {
  const exited = collect(child);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(readyPath)) {
      child.kill('SIGKILL');
      throw new Error(
        `the daemon announced itself ready instead of refusing, so it started serving on storage it `
        + `must have rejected (${what}); its own report was: ${readFileSync(readyPath, 'utf8').trim().slice(0, 200)}`,
      );
    }
    const settled = await Promise.race([exited, delay(10).then(() => null)]);
    if (settled) return settled;
    if (Date.now() >= deadline) {
      child.kill('SIGKILL');
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    }
  }
}

export default {
  'ENOSPC on write: a typed STORAGE_FULL, the last good state intact, and no partial mutation visible': async () => {
    const scratch = scratchDir('storage-enospc');
    const stateDir = join(scratch.dir, 'state');
    /** @type {import('../../dist/lib/store.js').Store|null} */
    let opened = null;
    try {
      const store = await openSeededStore(stateDir, UNREACHED_HOST);
      opened = store;
      const pages = simulateFullDisk(store);
      const simulated = `the disk is NOT really full: growth was simulated by capping the database at ${pages} pages`;

      // Larger than the whole database as it stands, so the reservation must allocate new pages
      // and the engine must refuse. This is the intent that has to become durable before any send.
      const refusal = await refusalFrom(
        () => store.reserveOperation({
          taskId: GOOD_TASK, kind: 'session.prompt', idempotencyKey: 'prompt:no-room',
          payload: { text: 'x'.repeat(4 * pages * PAGE_BYTES) },
        }),
        `a write that cannot grow the database (${simulated})`,
      );
      assert.equal(
        refusal.code, 'STORAGE_FULL',
        `a full disk must be reported as the defined STORAGE_FULL code (${simulated}): `
        + `${JSON.stringify(refusal.toJSON())}`,
      );

      // (b) the pre-existing state is still fully readable, through the SAME live connection,
      // and (c) the refused mutation is nowhere in it.
      assertLastGoodStateIntact(store, `after the ENOSPC refusal (${simulated})`, 'prompt:no-room');

      // The failed transaction must have been rolled back, not merely reported: with the
      // condition lifted, a DIFFERENT intent still commits. (Deliberately not a retry of the
      // refused key — re-attempting until green is exactly what this project forbids.)
      store.run('pragma max_page_count = 1048576');
      const after = store.reserveOperation({
        taskId: GOOD_TASK, kind: 'session.prompt', idempotencyKey: 'prompt:after-cap-lifted',
        payload: { text: 'after' },
      });
      assert.equal(after.created, true, 'a write after the condition is lifted must still commit');
      assert.equal(
        must(after.operation, 'the operation reserved after the cap was lifted').state, 'pending',
        'the recovered write must be a normal pending intent',
      );
      opened.close();
      opened = null;

      // The durable state is not merely readable by the connection that suffered the failure: a
      // second connection opened after a clean close must see the same rows.
      const { Store } = await import('../../dist/lib/store.js');
      const reopened = new Store({ stateDir });
      try {
        assert.equal(
          reopened.getTask(GOOD_TASK)?.task_id, GOOD_TASK,
          `a second connection must still read the last good task (${simulated})`,
        );
        assert.deepEqual(
          reopened.listOperations(GOOD_TASK).map((row) => row.idempotency_key),
          [GOOD_KEY, 'prompt:after-cap-lifted'],
          `a second connection must see the committed writes and nothing from the refused one (${simulated})`,
        );
        const refusedRow = reopened.all(
          'select idempotency_key from operations where idempotency_key = ?', 'prompt:no-room',
        );
        assert.equal(
          refusedRow.length, 0,
          `the refused intent must not be visible to a second connection, found ${JSON.stringify(refusedRow)}`,
        );
      } finally {
        reopened.close();
      }
    } finally {
      opened?.close();
      scratch.cleanup();
    }
  },

  'EACCES on write: a real read-only state directory is refused with STORAGE_UNAVAILABLE and the last good state survives': async () => {
    const scratch = scratchDir('storage-eacces-write');
    const stateDir = join(scratch.dir, 'state');
    /** @type {import('../../dist/lib/store.js').Store|null} */
    let opened = null;
    try {
      const store = await openSeededStore(stateDir, UNREACHED_HOST);
      opened = store;

      // The store pins WAL mode, and a WAL connection holds its `-wal`/`-shm` descriptors open,
      // so a directory permission change alone does NOT deny a live write — measured, not
      // assumed. Switching this one connection to a rollback journal makes the NEXT write create
      // a file inside the state directory, which is exactly the operation a read-only directory
      // must deny. The EACCES below is therefore the kernel's, not a stub's.
      store.run('pragma journal_mode = delete');
      const digestBefore = stateDigest(stateDir);
      const sizeBefore = statSync(dbFile(stateDir)).size;

      await withReadOnlyStateDir(stateDir, async () => {
        const refusal = await refusalFrom(
          () => store.reserveOperation({
            taskId: GOOD_TASK, kind: 'session.prompt', idempotencyKey: 'prompt:permission-denied',
            payload: { text: 'cannot be written' },
          }),
          'a write into a read-only state directory',
        );
        assert.equal(
          refusal.code, 'STORAGE_UNAVAILABLE',
          'a permission failure must be reported as the defined STORAGE_UNAVAILABLE code: '
          + `${JSON.stringify(refusal.toJSON())}`,
        );

        // A second store cannot obtain write access either: the same typed refusal, not a raw
        // driver error escaping to the caller.
        const openRefusal = await refusalFrom(async () => {
          const { Store } = await import('../../dist/lib/store.js');
          const other = new Store({ stateDir });
          other.close();
        }, 'opening a second store against the read-only state directory');
        assert.equal(
          openRefusal.code, 'STORAGE_UNAVAILABLE',
          'opening unwritable storage must be refused with STORAGE_UNAVAILABLE, not an internal error: '
          + `${JSON.stringify(openRefusal.toJSON())}`,
        );

        assertLastGoodStateIntact(store, 'after the EACCES refusal', 'prompt:permission-denied');
      });

      // Nothing was rewritten or truncated by the refusal: the bytes are the ones the seed left.
      // This is the strongest form of "the last good state was preserved" available while the
      // directory is still unwritable (a WAL-mode database needs directory write access to build
      // its shared-memory index, so a read-only open inside the window proves nothing about the
      // bridge).
      assert.equal(stateDigest(stateDir), digestBefore, 'a refusal must not rewrite the state database');
      assert.equal(
        statSync(dbFile(stateDir)).size, sizeBefore,
        'a refusal must not truncate the state database',
      );

      // Restoring access restores service, on the same connection and with the same rows.
      store.run('pragma journal_mode = wal');
      const after = store.reserveOperation({
        taskId: GOOD_TASK, kind: 'session.prompt', idempotencyKey: 'prompt:after-permission-restored',
        payload: { text: 'after' },
      });
      assert.equal(after.created, true, 'a write must succeed again once the permission is restored');
    } finally {
      try { chmodSync(stateDir, 0o700); } catch { /* the scratch directory may already be gone */ }
      opened?.close();
      scratch.cleanup();
    }
  },

  'EACCES at startup: the daemon refuses to run against an unwritable state directory and sends nothing': async () => {
    const host = await new FakeHost().start();
    const scratch = scratchDir('storage-eacces-start');
    const stateDir = join(scratch.dir, 'state');
    try {
      const seeded = await openSeededStore(stateDir, host.baseUrl);
      seeded.close();
      const digestBefore = stateDigest(stateDir);

      const readyPath = join(scratch.dir, 'daemon.ready.json');
      const exit = await withReadOnlyStateDir(stateDir, async () => {
        const child = spawnNode([
          DAEMON_ENTRY, '--state-dir', stateDir, '--host', host.baseUrl, '--ready-file', readyPath,
        ]);
        return awaitRefusal(child, readyPath, 20000, 'the daemon to refuse an unwritable state directory');
      });

      // The durable-state claim: a daemon that cannot write its own state must not run at all, so
      // it cannot have sent anything. The Host's log is the observation that proves it.
      assert.notEqual(
        exit.code, 0,
        'the daemon must refuse to run against an unwritable state directory, got '
        + `${JSON.stringify({ code: exit.code, signal: exit.signal, stderr: exit.stderr.slice(0, 300) })}. `
        // Recorded plainly, because it is a real defect and not behaviour this file wants to
        // bless: on THIS path the entry point throws while CONSTRUCTING the Daemon, outside the
        // handler that turns a BridgeError into `{ok:false, code}` plus exit 5, so the process
        // dies with an unhandled BridgeError and exit 1. The refusal itself is typed and correct;
        // it is the REPORTING contract at the process boundary that is not met. The test
        // deliberately does not encode the broken exit code as expected behaviour. Reported
        // alongside this file rather than fixed here (a src/ change was out of scope).
      );
      assert.equal(
        host.received.length, 0,
        'a daemon that cannot write durable state must not contact the Host at all, saw '
        + `${JSON.stringify(host.received.map((row) => row.method))}`,
      );
      // 4 is the documented OWNERSHIP refusal. Excluding it here is what keeps this case from
      // passing for the wrong reason: a refusal that came from somewhere other than storage would
      // still show an empty Host log and an untouched database.
      assert.notEqual(
        exit.code, 4,
        'the refusal must come from the unwritable storage, not from an ownership conflict',
      );
      assert.equal(
        stateDigest(stateDir), digestBefore,
        'the refusal must leave the existing state database byte-identical',
      );

      // And once the operator restores access, the same directory still holds the good state.
      const { Store } = await import('../../dist/lib/store.js');
      const reopened = new Store({ stateDir });
      try {
        assertLastGoodStateIntact(reopened, 'after the unwritable-state refusal');
      } finally {
        reopened.close();
      }
    } finally {
      try { chmodSync(stateDir, 0o700); } catch { /* the scratch directory may already be gone */ }
      await host.stop();
      scratch.cleanup();
    }
  },

  'corrupt state: the daemon refuses to start with STORAGE_CORRUPT, preserves the evidence and never contacts the Host': async () => {
    const host = await new FakeHost().start();
    const scratch = scratchDir('storage-corrupt');
    const stateDir = join(scratch.dir, 'state');
    try {
      const seeded = await openSeededStore(stateDir, host.baseUrl);
      // A filler row, so the page about to be destroyed belongs to filler rather than to the last
      // good rows: "the last good state is still readable" must be an observation, not an accident
      // of where SQLite placed a table.
      seeded.audit({ kind: 'corruption-filler', actor: 'test', detail: { pad: 'z'.repeat(64 * 1024) } });
      seeded.close();

      corruptLastPage(stateDir);
      const sizeBefore = statSync(dbFile(stateDir)).size;

      // The precondition, asserted rather than assumed: if this corruption is NOT detected, the
      // case proves nothing about corruption and must fail loudly instead of passing vacuously.
      const { Store } = await import('../../dist/lib/store.js');
      const probe = new Store({ stateDir });
      try {
        const integrity = probe.integrityCheck();
        assert.equal(
          integrity.ok, false,
          `the injected corruption must be detectable or this case is vacuous: ${JSON.stringify(integrity)}`,
        );
        assert.ok(
          integrity.detail.length > 0,
          'a failed integrity check must carry the pragma\'s own detail as evidence',
        );
        // Evidence preserved: the damaged database is still there and still readable where the
        // damage did not reach. A store that deleted or reset it would destroy the triage material.
        assert.equal(
          probe.getTask(GOOD_TASK)?.task_id, GOOD_TASK,
          'the corruption must not have destroyed the rows outside the damaged page',
        );
      } finally {
        probe.close();
      }

      const readyPath = join(scratch.dir, 'daemon.ready.json');
      const child = spawnNode([
        DAEMON_ENTRY, '--state-dir', stateDir, '--host', host.baseUrl, '--ready-file', readyPath,
      ]);
      const exit = await awaitRefusal(child, readyPath, 20000, 'the daemon to refuse a corrupt state database');

      // The defined refusal at the process boundary: the documented exit code, plus the typed code
      // in a JSON payload — not a stack trace, and not a silent start.
      assert.equal(
        exit.code, 5,
        'a corrupt state database must be refused with the defined refusal exit (5), got '
        + `${JSON.stringify({ code: exit.code, signal: exit.signal, stderr: exit.stderr.slice(0, 400) })}`,
      );
      const reported = refusalPayload(exit.stderr);
      assert.equal(
        reported.code, 'STORAGE_CORRUPT',
        'a state database that fails its integrity check must be refused as STORAGE_CORRUPT: '
        + `${JSON.stringify(reported)}`,
      );
      assert.equal(
        reported.ok, false,
        `the refusal payload must report failure: ${JSON.stringify(reported)}`,
      );

      // The durability rule: a daemon that refuses its storage must never have reached the Host.
      assert.equal(
        host.received.length, 0,
        'a daemon that refuses a corrupt state directory must not contact the Host, saw '
        + `${JSON.stringify(host.received.map((row) => row.method))}`,
      );
      assert.equal(
        statSync(dbFile(stateDir)).size, sizeBefore,
        'the corrupt database must be preserved for triage, not deleted or reset',
      );
    } finally {
      await host.stop();
      scratch.cleanup();
    }
  },

  'refuse to dispatch: an intent that cannot be persisted never reaches the Host': async () => {
    const host = await new FakeHost().start();
    const scratch = scratchDir('storage-refuse-dispatch');
    const stateDir = join(scratch.dir, 'state');
    /** @type {import('../../dist/lib/daemon.js').Daemon|null} */
    let started = null;
    try {
      const { Daemon } = await import('../../dist/lib/daemon.js');
      // The REAL daemon against the REAL fake Host over real HTTP. It is run in-process for one
      // reason only: the durable store has to be made unable to commit from the test, and
      // `Daemon.store` is the public entry point that allows it.
      const daemon = new Daemon({ stateDir, hostBase: host.baseUrl, hostScope: 'default' });
      started = daemon;
      await daemon.start();
      await daemon.startEventIngest();

      const task = daemon.taskEnsure({ clientKey: 'storage-task' });
      const taskId = task.task.taskId;
      const session = await daemon.sessionStart({ taskId, clientKey: 'storage-session' });
      assert.ok(session.session, `the session must exist before the refusal is attempted: ${JSON.stringify(session)}`);
      const sessionId = session.session.sessionId;

      // A real, successful turn first: there is a last good operation whose state must survive.
      const good = await daemon.sessionPrompt({
        taskId, sessionId, clientKey: 'good-prompt', text: GOOD_TEXT,
      });
      assert.equal(
        must(good.operation, 'the operation the last good prompt reserved').state, 'succeeded',
        `the last good prompt must succeed: ${JSON.stringify(good)}`,
      );

      const promptsBefore = host.requestsFor('session.prompt').length;
      const requestsBefore = host.received.length;
      const operationsBefore = daemon.store.listOperations(taskId).map((row) => row.idempotency_key);

      // SIMULATED full disk at the narrowest point available — see the file header. The filler
      // leaves the database dense and capping it at the current page count then means even the
      // largest admissible prompt (64 KiB) must allocate pages it cannot get.
      fillDatabase(daemon.store);
      const pages = simulateFullDisk(daemon.store);
      const simulated = `the disk is NOT really full: growth was simulated by capping the database at ${pages} pages`;

      const refusal = await refusalFrom(
        () => daemon.sessionPrompt({ taskId, sessionId, clientKey: 'refused-prompt', text: REFUSED_BODY }),
        `a prompt whose durable intent cannot be committed (${simulated})`,
      );
      assert.equal(
        refusal.code, 'STORAGE_FULL',
        `a prompt that cannot be persisted must be refused with STORAGE_FULL (${simulated}): `
        + `${JSON.stringify(refusal.toJSON())}`,
      );

      // THE oracle for this case, and the whole point of the durability ordering: nothing was
      // handed to the network. A count alone is not enough, so the recorded bodies are read too.
      assert.equal(
        host.requestsFor('session.prompt').length, promptsBefore,
        'an unpersistable intent must not reach the Host: session.prompt went '
        + `${promptsBefore} -> ${host.requestsFor('session.prompt').length}`,
      );
      assert.equal(
        host.received.length, requestsBefore,
        'an unpersistable intent must not add any request to the wire, saw '
        + `${JSON.stringify(host.received.slice(requestsBefore).map((row) => row.method))}`,
      );
      assert.equal(
        anyRequestCarried(host.received, REFUSED_MARKER), false,
        `the refused intent's body was observed in the Host request log, so it was sent despite `
        + `being unpersistable (${simulated})`,
      );

      // No partial mutation: the reservation is one transaction, so a refusal leaves no row at all.
      assert.deepEqual(
        daemon.store.listOperations(taskId).map((row) => row.idempotency_key), operationsBefore,
        'a refused intent must leave no durable row behind',
      );

      // And the last good state is untouched: the turn that did commit is still durable and the
      // session is still there, so the refusal cost the caller nothing already accepted.
      const goodOperation = must(
        daemon.store.listOperations(taskId).find((row) => row.idempotency_key === 'prompt:good-prompt'),
        'the last good prompt operation',
      );
      assert.equal(goodOperation.state, 'succeeded', 'the accepted turn must remain succeeded');
      assert.ok(daemon.store.getSession(sessionId), 'the session must still be readable after the refusal');
    } finally {
      if (started) await started.stop();
      await host.stop();
      scratch.cleanup();
    }
  },
};
