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

1. opens `<stateDir>/owner.lock` as a SQLite database;
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

`test/unit/core.test.mjs`, all of which run real processes:

- `exclusive ownership: a second handle is refused, and the holder keeps it while stopped` — an
  alive holder refuses a second handle, a `SIGSTOP`ped holder still refuses, and a `SIGCONT`ped
  holder still refuses;
- `the daemon refuses to start when the state directory is already owned` — the second daemon exits
  `4` with `OWNER_HELD`;
- `lock file inode is stable: nobody unlinks it, so a third party cannot lock a newer file`.

`test/persistence/crash.test.mjs` additionally kills an owner with `SIGKILL` and confirms the next
process acquires ownership in milliseconds, and that the interrupted operation is reported as
`uncertain` rather than as sent.

These tests run on macOS with Node 24.15.0 and SQLite 3.51.3. **The same tests have not yet been run
on Linux or Windows**; CI is configured for Linux and macOS, and this ADR's claim is limited to what
has actually executed.
