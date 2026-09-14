/**
 * Single-owner exclusion, held by the daemon for its whole lifetime.
 *
 * Why this file exists: the design forbids "check a PID, then delete a stale lock" — that
 * pattern either double-grants ownership (two daemons both believe they own the state) or
 * needs a human to hand-delete the artifact after a crash. It also forbids a
 * timeout-based lease: a lease hands ownership to a second process while the first is still
 * alive (SIGSTOPped, suspended, or slow), and the moment the first resumes there are two
 * owners.
 *
 * The primitive used here is a kernel-enforced lock: a dedicated SQLite file opened in
 * `locking_mode=EXCLUSIVE`, with one committed write so the database file locks are actually
 * taken and held for the lifetime of the connection.
 *
 * Measured detail worth knowing about that pragma: `locking_mode` is PER-CONNECTION state. A second
 * connection to the same file reports `normal` however the holder opened it, so "is exclusion
 * configured?" is not observable from outside the holder. That is why `describe()` reads the mode back
 * from the holder's own handle, and why a test that probed a fresh connection measured nothing. The OS releases those locks when the
 * process dies, for any reason, including SIGKILL — so ownership is never stale, needs no
 * cleanup, and cannot be handed over while the holder lives.
 *
 * Measured on this machine (macOS, Node 24.15.0, SQLite 3.51.3), reproduced by
 * test/unit/owner-lock.test.mjs (the primitive: exclusive locking mode read back from the holder's own
 * connection, an uncooperative second writer refused, inode stability, a process-level contender that
 * must exit) and test/persistence/crash.test.mjs (the daemon-level SIGSTOP/SIGKILL behaviour):
 *   holder alive            -> contender refused
 *   holder SIGSTOPped       -> contender still refused   (a live-but-stopped owner keeps it)
 *   holder SIGCONTed        -> unchanged, exactly one owner
 *   holder SIGKILLed        -> contender acquires immediately, no manual cleanup
 *
 * A departure from the suggested `flock(2)`: Node 24 no longer exposes `process.binding('fs').flock`
 * and `node:fs` has no public flock, so flock is not reachable from the runtime the handoff
 * selected. The semantics above are the ones the design demands, and they are verified by
 * test rather than assumed. Recorded in docs/adr/0002-owner-exclusion-primitive.md.
 */

import { openSync, closeSync, statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { BridgeError, ERROR_CODES } from './errors.ts';

/** What one acquisition attempt reports: a refusal always says why. */
export type AcquireOutcome =
  | { readonly acquired: true }
  | { readonly acquired: false; readonly reason: string };

/** What the HELD connection reports about itself, read back from its own handle. */
export interface LockDescription {
  readonly held: boolean;
  readonly lockingMode: string | null;
  readonly journalMode: string | null;
}

/** Platform self-check: whether exclusion behaves as the design requires on this platform. */
export interface LockProbe {
  readonly supported: boolean;
  readonly secondRefused: boolean;
  readonly inodeStable: boolean;
  /** The holder's inode; present only when the probe acquired the lock. */
  readonly inode?: number;
  /** Why locking is unusable here; present only when `supported` is false. */
  readonly reason?: string;
}

/** Held lock: one SQLite connection whose file locks live as long as this object. */
export class OwnerLock {
  #db: DatabaseSync | null = null;
  #dbPath: string;
  #markerPath: string;
  #held = false;

  /**
   * @param options.lockPath path of the exclusive lock database
   */
  constructor({ lockPath }: { readonly lockPath: string }) {
    this.#dbPath = lockPath;
    this.#markerPath = `${lockPath}.held`;
  }

  get dbPath(): string { return this.#dbPath; }
  get held(): boolean { return this.#held; }

  /**
   * Report what the HELD connection is actually doing, read back from the connection itself.
   *
   * Why this exists: `locking_mode` is per-connection state, so a fresh connection to the same file
   * reports `normal` no matter how the holder opened it. That makes "is exclusion configured?" an
   * unobservable claim from outside — and an unobservable claim cannot be tested, which is how the
   * `owner-lock-not-exclusive` mutation survived a daemon-level test that looked thorough.
   *
   * The returned values come from `pragma` reads on the holder's own handle, so they describe the real
   * state rather than a constant this class would otherwise be trusted to report.
   */
  describe(): LockDescription {
    if (this.#db === null) return { held: false, lockingMode: null, journalMode: null };
    const db = this.#db;
    const read = (pragma: string): string | null => {
      try {
        const row = db.prepare(`pragma ${pragma}`).get();
        const value = row ? Object.values(row)[0] : null;
        return typeof value === 'string' ? value.toLowerCase() : null;
      } catch { return null; }
    };
    return { held: true, lockingMode: read('locking_mode'), journalMode: read('journal_mode') };
  }

  /** Try to become the owner. Never blocks, never retries, never reclaims. */
  tryAcquire(): AcquireOutcome {
    if (this.#db !== null) return { acquired: true };
    if (typeof process.getBuiltinModule !== 'function') {
      return { acquired: false, reason: 'runtime-unsupported' };
    }
    const sqlite = process.getBuiltinModule('node:sqlite');
    if (!sqlite?.DatabaseSync) return { acquired: false, reason: 'sqlite-unavailable' };

    let db: DatabaseSync | undefined;
    try {
      db = new sqlite.DatabaseSync(this.#dbPath, { timeout: 0 });
      db.exec('pragma locking_mode=EXCLUSIVE');
      db.exec('pragma journal_mode=DELETE');
      db.exec('create table if not exists owner (marker text primary key, taken_at integer not null)');
      // The write is what takes the file locks; a read-only handle would not hold them.
      db.exec('delete from owner');
      db.prepare('insert into owner(marker, taken_at) values (?, ?)').run('owner', Date.now());
    } catch (error) {
      try { db?.close(); } catch { /* a refused handle may already be unusable */ }
      const message = error instanceof Error ? error.message : String(error);
      const busy = /busy|locked/i.test(message);
      return { acquired: false, reason: busy ? 'busy' : `error:${message.slice(0, 120)}` };
    }
    this.#db = db;
    this.#held = true;
    return { acquired: true };
  }

  /**
   * Acquire or throw a typed refusal. The error deliberately carries no PID: a PID would
   * invite exactly the check-then-delete pattern this class exists to remove.
   */
  acquire(): void {
    const result = this.tryAcquire();
    if (!result.acquired) {
      throw new BridgeError(
        ERROR_CODES.OWNER_HELD,
        'another process owns this state directory',
        { reason: result.reason },
      );
    }
  }

  /** Release explicitly (orderly shutdown). The kernel also releases it on process death. */
  release(): void {
    if (this.#db === null) return;
    try { this.#db.close(); } catch { /* closing a dead handle must not mask shutdown */ }
    this.#db = null;
    this.#held = false;
  }

  /**
   * Write a zero-byte private marker so an operator can see which directory is claimed.
   * Purely informational: the marker is never read to decide ownership, and deleting it
   * would not release anything.
   */
  writeMarker(): void {
    try {
      const fd = openSync(this.#markerPath, 'w', 0o600);
      closeSync(fd);
    } catch { /* informational only */ }
  }
}

/**
 * Report whether this platform's exclusion behaves as the design requires, without leaving
 * anything behind. Used by startup self-check and by a unit test that fails loudly on a
 * platform whose locking is a no-op.
 */
export function probeLocking(lockPath: string): LockProbe {
  const first = new OwnerLock({ lockPath });
  const second = new OwnerLock({ lockPath });
  try {
    const a = first.tryAcquire();
    if (!a.acquired) return { supported: false, secondRefused: false, inodeStable: false, reason: a.reason };
    // The holder must keep the same inode: if the path were unlinked and recreated, a third
    // process could take a lock on the NEW file while this holder still believes it owns the
    // state directory.
    const inodeBefore = statSync(lockPath).ino;
    const b = second.tryAcquire();
    const inodeAfter = statSync(lockPath).ino;
    return {
      supported: true,
      secondRefused: !b.acquired,
      inodeStable: inodeBefore === inodeAfter,
      inode: inodeBefore,
    };
  } finally {
    second.release();
    first.release();
  }
}
