/**
 * Unit layer: the owner-exclusion primitive, tested as a primitive.
 *
 * Why this file exists: `test/persistence/crash.test.mjs` proves the DAEMON refuses a second start, and
 * that is the property an operator cares about. But it leaves the primitive itself unmeasured: a daemon
 * could refuse a second start for a dozen reasons that have nothing to do with the kernel holding a
 * lock. When the `owner-lock-not-exclusive` mutation first ran, exactly that happened — the daemon-based
 * test stayed green, which means it was not actually testing the exclusive lock.
 *
 * So these tests hold `OwnerLock` directly and ask two questions the daemon-level test cannot:
 *
 *   1. is the lock database actually in SQLite's exclusive locking mode while the holder lives, and
 *   2. does an INDEPENDENT process, opening the file with a plain SQLite connection that knows nothing
 *      about `OwnerLock` — no marker file, no cooperation — fail to take a write lock on it?
 *
 * Question 2 is the one that says "kernel-enforced" rather than "mutually agreed". A marker file, a PID
 * check, or a leases table would pass question 1's neighbours and fail this one.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { assert, ROOT } from '../helpers.mjs';
import { OwnerLock, probeLocking } from '../../dist/lib/owner-lock.js';

const require = createRequire(import.meta.url);

/** A private directory per test, never the repo and never an operator's state dir. */
function scratch(label) {
  const dir = mkdtempSync(join(tmpdir(), `dshpilot-owner-${label}-`));
  return { dir, lockPath: join(dir, 'owner.lock'), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export default {
  'the lock database is held in exclusive locking mode, not merely remembered': () => {
    const s = scratch('mode');
    const lock = new OwnerLock({ lockPath: s.lockPath });
    try {
      const result = lock.tryAcquire();
      assert.equal(result.acquired, true, `the first holder must acquire: ${JSON.stringify(result)}`);
      // `locking_mode` is PER-CONNECTION, so this has to be read back from the holder's own handle:
      // a fresh connection to the same file reports `normal` however the holder opened it. The first
      // version of this test used a fresh connection and measured nothing — it asserted the wrong
      // thing and failed, which is how the per-connection nature was established.
      const state = lock.describe();
      assert.equal(state.held, true, 'the lock must report itself as held');
      assert.equal(state.lockingMode, 'exclusive',
        `the held connection must be in exclusive locking mode; it reports ${JSON.stringify(state)}`);
      // Not just any exclusive mode: the lock has to survive its own transaction, which is why the
      // implementation takes one committed write instead of relying on a read.
      assert.notEqual(state.journalMode, 'wal',
        `the lock database must not be in WAL mode, which would weaken single-file exclusion: ${JSON.stringify(state)}`);
    } finally {
      lock.release();
      s.cleanup();
    }
  },

  'a second holder is refused, and an uncooperative connection cannot take the file': () => {
    const s = scratch('second');
    const first = new OwnerLock({ lockPath: s.lockPath });
    const second = new OwnerLock({ lockPath: s.lockPath });
    try {
      assert.equal(first.tryAcquire().acquired, true);
      const refused = second.tryAcquire();
      assert.equal(refused.acquired, false, 'a second owner must never acquire while the first lives');
      assert.match(String(refused.reason), /busy|locked|error/i, `the refusal must say why: ${JSON.stringify(refused)}`);

      // The stronger claim: an INDEPENDENT process that knows nothing about OwnerLock shares no
      // in-process state with us and still cannot write. This is what distinguishes a kernel lock from
      // a convention, and it is the half a marker file or a PID file would fail.
      const foreign = execFileSync(process.execPath, ['-e', `
        const { DatabaseSync } = require('node:sqlite');
        try {
          const db = new DatabaseSync(${JSON.stringify(s.lockPath)}, { timeout: 0 });
          db.exec('create table if not exists intruder (x integer)');
          db.exec('insert into intruder(x) values (1)');
          process.stdout.write('WROTE');
        } catch (error) {
          process.stdout.write('REFUSED:' + (error && error.message ? error.message : String(error)));
        }
      `], { encoding: 'utf8' });
      assert.ok(foreign.startsWith('REFUSED'),
        `an uncooperative second writer must be refused by the kernel, got ${JSON.stringify(foreign.slice(0, 200))}`);
    } finally {
      second.release();
      first.release();
      s.cleanup();
    }
  },

  'the lock file keeps its inode, so releasing and re-taking cannot split ownership': () => {
    const s = scratch('inode');
    const lock = new OwnerLock({ lockPath: s.lockPath });
    try {
      assert.equal(lock.tryAcquire().acquired, true);
      const before = statSync(s.lockPath).ino;
      lock.release();
      // Re-acquire: if the implementation unlinked and recreated the file, a process still holding the
      // OLD inode would keep a lock on a file nobody else can see, and a new holder would happily take
      // the new one. Two owners, one state directory.
      const again = new OwnerLock({ lockPath: s.lockPath });
      try {
        assert.equal(again.tryAcquire().acquired, true);
        const after = statSync(s.lockPath).ino;
        assert.equal(after, before, 'the lock file must keep its inode across release and re-acquire');
      } finally { again.release(); }
    } finally {
      lock.release();
      s.cleanup();
    }
  },

  'the startup self-check reports real exclusion on this platform, or fails loudly': () => {
    const s = scratch('probe');
    try {
      const report = probeLocking(s.lockPath);
      assert.equal(report.supported, true, `locking must be supported on this platform: ${JSON.stringify(report)}`);
      assert.equal(report.secondRefused, true, `a second holder must be refused: ${JSON.stringify(report)}`);
      assert.equal(report.inodeStable, true, `the inode must be stable: ${JSON.stringify(report)}`);
    } finally {
      s.cleanup();
    }
  },

  'the marker file is informational only: deleting it does not release anything': () => {
    const s = scratch('marker');
    const first = new OwnerLock({ lockPath: s.lockPath });
    try {
      assert.equal(first.tryAcquire().acquired, true);
      first.writeMarker();
      assert.ok(readFileSync(`${s.lockPath}.held`, 'utf8') === '', 'the marker is a zero-byte informational file');
      rmSync(`${s.lockPath}.held`, { force: true });
      // The design forbids "delete the stale artefact to take ownership", so removing the marker must
      // change nothing at all about who owns the state directory.
      const second = new OwnerLock({ lockPath: s.lockPath });
      try {
        assert.equal(second.tryAcquire().acquired, false,
          'deleting the informational marker must not hand over ownership');
      } finally { second.release(); }
    } finally {
      first.release();
      s.cleanup();
    }
  },

  /**
   * The end-to-end claim, asserted WITHOUT waiting on a readiness file.
   *
   * Why not reuse the daemon-ready wait: a daemon that wrongly acquires never writes a ready file, so a
   * test that waits for one turns a wrong result into a timeout instead of a failure. That is precisely
   * how the first `owner-lock-not-exclusive` mutation appeared to "run 0 tests" instead of reporting a
   * caught control. So the contender is spawned on its own and its EXIT is the observable: a refused
   * starter exits quickly and non-zero, an incorrect one keeps running.
   */
  'a second daemon process started against a held state directory exits instead of running': async () => {
    const s = scratch('process');
    // The daemon locks `${stateDir}/owner.lock.sqlite` (see DshDaemon's constructor). Holding
    // `owner.lock` instead — the first version of this test did — means holding an unrelated file, and
    // the contender then starts correctly and hangs waiting for a Host, which looks like a broken
    // control rather than a wrong test.
    const holder = new OwnerLock({ lockPath: join(s.dir, 'owner.lock.sqlite') });
    try {
      assert.equal(holder.tryAcquire().acquired, true, 'the test must own the state directory first');
      const { spawn } = await import('node:child_process');
      const contender = spawn(process.execPath, ['dist/bin/dsh-pilot-daemon.js', '--state-dir', s.dir], {
        cwd: ROOT,
        env: { ...process.env, DSH_PILOT_HOST: 'http://127.0.0.1:1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      contender.stderr.setEncoding('utf8');
      contender.stderr.on('data', (chunk) => { stderr += chunk; });
      // Assigned by the `close` listener, which is the observable this test waits on, so the
      // declared type goes on the initializer: control-flow analysis cannot see a listener's
      // assignment, and without this the non-null assertion below would narrow to `never`.
      let outcome = /** @type {{code: number|null, signal: string|null}|null} */ (null);
      contender.on('close', (code, signal) => { outcome = { code, signal }; });
      const deadline = Date.now() + 20_000;
      while (outcome === null && Date.now() < deadline) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
      try {
        assert.ok(outcome !== null,
          `a second daemon must exit rather than run as a second owner; it was still alive after 20s. stderr=${stderr.slice(0, 200)}`);
        assert.notEqual(outcome.code, 0,
          `the refusal must be a non-zero exit; got ${JSON.stringify(outcome)} stderr=${stderr.slice(0, 300)}`);
        assert.match(stderr, /OWNER_HELD|owns this state directory/i,
          `the refusal must name the reason; stderr=${JSON.stringify(stderr.slice(0, 300))}`);
      } finally {
        if (outcome === null) contender.kill('SIGKILL');
      }
    } finally {
      holder.release();
      s.cleanup();
    }
  },

  /**
   * The ORDER: ownership is decided before the state store is opened.
   *
   * Why the order is the finding and not a detail: opening the store creates the state directory, runs
   * the DDL and applies migrations, so a contender that opened first would have already written to a
   * schema it does not own before being told it is not the owner — a refusal that damages the owner's
   * state is not a refusal.
   *
   * The oracle is the TYPED exit the contender reports, and it discriminates because the state file
   * planted here cannot be opened at all: if the store were opened first, the refusal would be a
   * storage refusal (exit 5); with ownership first it is the ownership refusal (exit 4). The control
   * below runs the SAME unopenable state file with NO owner holding the lock and asserts the storage
   * exit, so "exit 4" cannot be produced by the file merely being unreadable. The state file's bytes
   * are also compared before and after: a migration would have rewritten them.
   */
  'FR-OWN-1 the owner lock is taken before the state store is opened, so a refused contender cannot touch the schema': async () => {
    const s = scratch('lock-before-store');
    const stateDir = join(s.dir, 'state');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const statePath = join(stateDir, 'state.sqlite');
    // Not a database at all. Any attempt to OPEN the store fails loudly, which is what turns the two
    // possible orders into two different observable exits.
    writeFileSync(statePath, 'this file is not a sqlite database\n');
    const planted = readFileSync(statePath);
    const holder = new OwnerLock({ lockPath: join(stateDir, 'owner.lock.sqlite') });
    try {
      assert.equal(holder.tryAcquire().acquired, true, 'the test must own the state directory first');
      /** Spawn one contender and wait for its exit, reporting the code and everything it said. */
      const runContender = async (dir) => {
        const { spawn } = await import('node:child_process');
        const child = spawn(process.execPath, ['dist/bin/dsh-pilot-daemon.js', '--state-dir', dir], {
          cwd: ROOT,
          env: { ...process.env, DSH_PILOT_HOST: 'http://127.0.0.1:1' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        let outcome = /** @type {{code: number|null, signal: string|null}|null} */ (null);
        child.on('close', (code, signal) => { outcome = { code, signal }; });
        const deadline = Date.now() + 20_000;
        while (outcome === null && Date.now() < deadline) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        }
        if (outcome === null) {
          child.kill('SIGKILL');
          throw new Error(`the contender never exited within 20s; stderr=${stderr.slice(0, 200)}`);
        }
        return { outcome, stderr };
      };

      const refused = await runContender(stateDir);
      assert.equal(refused.outcome.code, 4,
        `a contender that does not own the directory must report the OWNERSHIP refusal (exit 4), not a `
        + `storage refusal from having opened the state file first: got ${JSON.stringify(refused.outcome)} `
        + `stderr=${refused.stderr.slice(0, 300)}`);
      assert.match(refused.stderr, /OWNER_HELD/,
        `the refusal must name ownership; stderr=${JSON.stringify(refused.stderr.slice(0, 300))}`);
      assert.equal(readFileSync(statePath).equals(planted), true,
        'the refused contender must leave the owner\'s state file byte-for-byte alone; a migration would '
        + 'have rewritten it');

      // The control: same unopenable file, no owner. This proves the exit code above is evidence of the
      // ORDER rather than of the file being unopenable, and that the storage path is still reachable.
      const controlDir = join(s.dir, 'control-state');
      mkdirSync(controlDir, { recursive: true, mode: 0o700 });
      writeFileSync(join(controlDir, 'state.sqlite'), 'this file is not a sqlite database\n');
      const unowned = await runContender(controlDir);
      assert.equal(unowned.outcome.code, 5,
        `with no owner, the same unopenable state file must surface as the STORAGE refusal (exit 5), `
        + `which is what makes exit 4 above meaningful: got ${JSON.stringify(unowned.outcome)} `
        + `stderr=${unowned.stderr.slice(0, 300)}`);
      assert.doesNotMatch(unowned.stderr, /OWNER_HELD/,
        `the control must not report ownership; stderr=${JSON.stringify(unowned.stderr.slice(0, 300))}`);
    } finally {
      holder.release();
      s.cleanup();
    }
  },

  'a stale marker left by a dead holder does not block a new owner': () => {
    const s = scratch('stale');
    // Simulate a crashed predecessor: a marker on disk from a process that no longer exists.
    writeFileSync(`${s.lockPath}.held`, '');
    const lock = new OwnerLock({ lockPath: s.lockPath });
    try {
      // Ownership must be decided by the kernel lock, never by the marker's existence, so this must
      // succeed. A "refuse because the marker exists" implementation would deadlock every crash.
      const result = lock.tryAcquire();
      assert.equal(result.acquired, true,
        `a stale marker must not block a new owner: ${JSON.stringify(result)}`);
      assert.equal(lock.held, true);
    } finally {
      lock.release();
      s.cleanup();
    }
  },
};
