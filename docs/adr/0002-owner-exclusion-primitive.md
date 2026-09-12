# ADR 0002 — Owner exclusion primitive

- Status: accepted
- Date: 2026-09-12
- Supersedes: nothing; extends ADR 0001.

## Context

The bridge must have exactly one owner per state directory. Two owners would write the same event
log and answer the same calls from two processes, and the resulting history would be
indistinguishable from a Host that replayed events — the worst possible failure, because it is
silent.

The requirement is stronger than "detect a second process". It is: **the exclusion must be
kernel-enforced, must not depend on the current owner being alive, and must survive the owner being
killed outright.** In particular:

- a PID file is not enough (pids are reused, and a file left by a dead owner looks alive);
- a timeout lease is not enough (a paused owner should not lose ownership, because it may hold
  unflushed durable state — losing ownership there is how you get two writers);
- "check the PID, then delete the lock" is worse than either, because two processes can interleave
  the check and the delete.

The design therefore requires: hold a lock for the daemon's whole lifetime, on a **fixed inode**, so
nothing can unlink it and let a third party lock a newer file, and let the operating system release
it on process death — including `SIGKILL` — without any cleanup step we are responsible for.

## Decision

Use **SQLite's `locking_mode=EXCLUSIVE` on a dedicated lock database file** inside the state
directory.

The daemon:

1. opens `<stateDir>/owner.lock.sqlite` as a SQLite database;
2. sets `locking_mode=EXCLUSIVE` and executes a write (`create table if not exists owner(...)`),
   which takes and holds the exclusive file lock for the connection's lifetime;
3. **never closes that connection** while the daemon runs, and does not pass the file descriptor to
   any child;
4. if the open or write fails with `SQLITE_BUSY`, reports `OWNER_HELD` and exits `4` without
   touching any state;
5. does not unlink `owner.lock` on shutdown, so the inode is stable across restarts.

The file is opened read-write rather than read-only, and it is a **separate file** from
`state.sqlite`, so the owner decision is never entangled with a write transaction on real data.

## Why not the alternatives

| Candidate | Why rejected |
| --- | --- |
| `process.binding('fs').flock` | **Not present on Node 24.15.0.** Verified: `process.binding('fs').flock` is `undefined`; the internal binding is not exposed to user code. Not a portable answer even if it were. |
| `flock(2)` via a native addon or external binary | Adds a runtime dependency or a spawn, and violates the zero-dependency posture in ADR 0001. A spawned helper would also hold the lock in a different process, complicating lifetime. |
| `O_EXCL` lock file | Cannot distinguish a live owner from a crashed one without liveness heuristics, and unlinking to recover reintroduces the check-then-delete race. |
| PID file + `kill(pid, 0)` | PID reuse gives false ownership; a `SIGSTOP`ped live owner is indistinguishable from a dead one by this test. |
| Timeout lease | Directly contradicts the requirement: a live-but-paused owner must keep ownership. |
| Advisory `flock` where available, `fcntl` elsewhere | Two code paths, one of which is untestable on the platforms we ship for. |

SQLite's exclusive locking mode already has exactly the semantics required — it is an OS-level file
lock held for the connection lifetime and released by the kernel when the process dies — and it is
reachable from Node 24 with **no dependency at all** (`node:sqlite`).

### A property of that pragma that cost a test to learn

`locking_mode` is **per-connection** state. A second connection to the same file reports `normal`
however the holder opened it, so "is exclusion configured?" is **not observable from outside the
holder**. The first version of the unit test probed a fresh connection and therefore measured nothing
at all — it asserted `exclusive` against a value that could only ever be `normal`.

Two consequences are part of the decision:

- `OwnerLock.describe()` reads `locking_mode` and `journal_mode` back from the holder's **own** handle,
  so the configuration is observable and therefore testable.
- The tests that matter assert **effects**, not configuration: an uncooperative second writer is
  refused by the kernel, and a second daemon process exits non-zero with `OWNER_HELD`.

## Consequences

Positive:

- The exclusion is enforced by the operating system, not by our own bookkeeping.
- It is released by the kernel on any death: exit, crash, `SIGKILL`. No stale-lock recovery path
  exists, so there is no recovery race to get wrong.
- A **paused** (`SIGSTOP`) live owner keeps ownership, which is the behaviour the design requires.
- One mechanism covers every platform Node 24 supports, so the tested behaviour and the shipped
  behaviour are the same code.

Negative and accepted:

- The state directory now holds a second, permanently present file (`owner.lock`). It is 0 bytes of
  real content; tooling that expects a single file in the state dir must be taught about it.
- The lock is per-file, so a state directory on a filesystem without working lock semantics (some
  network mounts) will misbehave. Detected indirectly: the unit test asserts that a second handle is
  refused, and a filesystem that cannot refuse would fail that test rather than silently permit two
  owners.
- An owner that hangs forever holds ownership forever. This is deliberate, and the operator's
  remedy is to kill the process, not to delete a lock file.
- Recovery is coarser than a lease would allow: after a `SIGKILL`, operations left in `dispatching`
  become `uncertain` and are resolved by inspection, never by an automatic retry.

## Verified by

`test/unit/owner-lock.test.mjs` — the primitive itself, held directly rather than through the daemon,
because the daemon-level test cannot distinguish "the kernel refused" from any other reason a second
daemon declines to start:

- `the lock database is held in exclusive locking mode, not merely remembered` — the mode is read back
  from the holder's own connection, and the database is asserted **not** to be in WAL mode;
- `a second holder is refused, and an uncooperative connection cannot take the file` — the second half
  is the load-bearing one: an **independent process**, opening the file with a plain SQLite connection
  that knows nothing about `OwnerLock` and shares no in-memory state, is refused. A marker file, a PID
  check or a leases table would pass the neighbours of this assertion and fail this one;
- `the lock file keeps its inode, so releasing and re-taking cannot split ownership`;
- `the startup self-check reports real exclusion on this platform, or fails loudly` — `probeLocking`
  must report `supported`, `secondRefused` and `inodeStable`;
- `the marker file is informational only: deleting it does not release anything` — the design forbids
  "delete the stale artefact to take ownership", so this asserts the marker is not load-bearing;
- `a stale marker left by a dead holder does not block a new owner` — a "refuse because the marker
  exists" implementation would deadlock after every crash;
- `a second daemon process started against a held state directory exits instead of running` — a real
  second daemon is spawned and its **exit** is the observable. Deliberately not written as "wait for
  the daemon to be ready": a daemon that wrongly acquires never becomes ready, so a readiness wait
  would turn a wrong result into a timeout instead of a failure.

`test/unit/core.test.mjs`, which runs real processes:

- `exclusive ownership: a second handle is refused, and the holder keeps it while stopped` — an
  alive holder refuses a second handle, a `SIGSTOP`ped holder still refuses, and a `SIGCONT`ped
  holder still refuses;
- `the daemon refuses to start when the state directory is already owned` — the second daemon exits
  with `OWNER_HELD`;
- `lock file inode is stable: nobody unlinks it, so a third party cannot lock a newer file`.

`test/persistence/crash.test.mjs` additionally kills an owner with `SIGKILL` and confirms the next
process acquires ownership immediately, and that the interrupted operation is reported as
`uncertain` rather than as sent.

`test/mutation/run.mjs` carries a production negative control, `second-owner-not-refused`, which
neuters the second holder's refusal in `src/lib/owner-lock.ts`. It is **caught as a hang**, not as a
failed assertion: a refusal path that stops refusing blocks its caller rather than failing it, so the
defect is observable as non-termination. The mutation runner counts a hang as a detection for exactly
this reason.

### Platform coverage, stated narrowly

All of the above ran on **macOS (darwin/arm64) with Node 24.15.0 and SQLite 3.51.3**. Measured
numbers from that run: a second `OwnerLock` was refused **20 times out of 20** with reason `busy`,
`probeLocking` reported `{supported: true, secondRefused: true, inodeStable: true}`, and a second
daemon process exited non-zero with `OWNER_HELD`.

**The SIGSTOP and SIGKILL behaviour has not been executed on Linux or Windows.** CI is configured for
both Linux and macOS, but the workflow has not yet been run on a runner, so no Linux result exists to
cite. This ADR's claim is limited to what has actually executed.

### Superseded formulation

An earlier revision of this ADR said the lock was held by `pragma locking_mode=EXCLUSIVE` **plus one
committed write**, and named the lock file `owner.lock`. Both statements were true but incomplete: the
committed write alone does not keep the lock held between statements, so what actually keeps the
file locked is the exclusive locking mode on a connection that is never closed, and the file is
`owner.lock.sqlite`. Corrected here rather than silently edited, because the earlier wording would
have led a reader to trust the write instead of the mode.
