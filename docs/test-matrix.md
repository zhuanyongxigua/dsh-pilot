# Test matrix — requirement → layer → oracle

Task: `DSH-PILOT-20260912`. Status: **Phase 0 plan**. Every test id below is a **planned**
item, not an executed one. The only things measured so far are the two Phase-0 fixture
observations in [`docs/host-compatibility.md`](host-compatibility.md) §6.

Rule for reading this document: a row's status is one of `planned`, `blocked` (needs a
decision or capability we do not have yet), or `measured` (evidence exists today). **No row
is `passing`.** A plan is not a result.

Conventions: requirement ids come from [`docs/requirements.md`](requirements.md); test ids
are `CT-` (contract/unit), `PT-` (seeded property/model), `PX-` (real multi-process
persistence + crash), `FH-` (fake Host over real HTTP/WebSocket), `ME-` (real stdio MCP
client against the built binary), `IH-` (isolated official DSH Host, opt-in), `LIVE-`
(opt-in paid live suite), `OR-` (process oracle), `SEC-` (security/bounds), `MT-`
(mutation/negative control), `CI-`, `SOAK-`.

---

## 1. Layers at a glance

| Layer | Directory (planned) | Real transport / real process | Default CI | Proves |
|---|---|---|---|---|
| L1 contract & unit | `test/contract`, `test/unit` | no | yes | schemas, envelopes, error mapping, state machines, invalid input |
| L2 seeded property/model | `test/property` | no | yes | invariants over generated event orders and crash interleavings, replayable seeds |
| L3 real persistence + crash | `test/persistence` | real files, real processes, `SIGKILL` | yes | durability, no duplicate dispatch/cursor, single-owner, stale-lock recovery |
| L4 fake Host (real HTTP + real WS) | `test/fake-host` | real sockets, in-process Host | yes | disconnect/delay/dropped ack/dup/old/reorder/malformed/oversize/replay-gap/pagination/backpressure/cancel races |
| L5 MCP E2E over stdio | `test/mcp-e2e` | built binary spawned by a real MCP client | yes | the actual MCP face, tool schemas, error mapping, cancellation |
| L6 isolated official Host | `test/isolated-host` | official `dsh web` on an ephemeral port under a throwaway `DSH_HOME` | planned yes, **gated** on mock-provider feasibility | our assumptions vs the real product |
| L7 live paid (deepseek-flash) | `test/live` | isolated Host + real company route | **never** | integration against a real provider, opt-in, ≤20 min, concurrency ≤8 |
| L8 process oracle | `test/oracle` | real child processes | yes | subprocess stop/kill claims carry evidence |
| L9 security & bounds | `test/security` | real FS, real sockets | yes | isolation, redaction, adversarial text, memory/log bounds |
| L10 mutation/negative controls | tooling | re-runs targeted suites against mutated code | yes (shard) | the suite actually fails when the property is broken |
| L11 CI wiring | `.github/workflows` | Linux + macOS, no secrets | n/a | deterministic, lockfile install, distinct counts |
| L12 soak runner | `tools/soak` | real wall time | manual | continuity, gaps, restart checkpoints |

**Fixture separation is mandatory.** L4's fake Host and L6's official Host live in separate
directories, print distinct labels, and are never described as proving each other's claims.

---

## 2. L1 — contract & unit (`CT-*`)

| Test id | Requirement | What it does | Observable oracle | Status |
|---|---|---|---|---|
| CT-ENV-1 | FR-MCP-1, FR-EXEC-3 | Parses and re-serializes every `client-request` / `server-response` / `client-response` envelope shape | Round-trip equality; an envelope missing `rpcId` or with a wrong `type` tag is rejected | planned |
| CT-ENV-2 | FR-STATE-2 | Asserts the bridge never mints an `rpcId` for a response and always echoes the request's | Field-level assertion on the built envelope | planned |
| CT-ENV-3 | FR-EXEC-4 | Maps every one of the 49 `error.code` values from the pinned map to a bridge outcome | Table-driven: each code produces its declared outcome; an unknown code is a failing test, not a default | planned |
| CT-ENV-4 | FR-MCP-3 | Capability negotiation table: every `RpcMethodMap` key is declared supported / unsupported / unknown | Table equality against the checked-in inventory; a new upstream key fails until classified | planned |
| CT-STATE-1 | FR-ID-1 | State-machine tests for task/session/turn/operation/interaction transitions | Every legal transition reachable; every illegal transition refused with a typed error | planned |
| CT-STATE-2 | FR-STATE-7 | Serialization versioning: writes carry a version; unknown future version refused | Hand-crafted version+1 fixture → typed error, file untouched | planned |
| CT-IN-1 | FR-MCP-2 | Invalid-input table for every MCP tool payload (missing/extra/wrong-typed/boundary) | Each rejected by schema with a machine-readable error; dispatch counter stays 0 | planned |
| CT-IN-2 | FR-MCP-2 | Oversize and adversarial input (deeply nested JSON, huge strings, non-UTF8, control chars) | Rejected or bounded, never a crash or unbounded allocation | planned |
| CT-CANCEL-1 | FR-CANCEL-1 | The two cancellation scopes are separate API paths with separate effects | Turn-cancel does not remove queue items; queue-remove does not stop the turn | planned |
| CT-WAIT-1 | FR-EXEC-1, FR-EXEC-3 | Wait-result contract: closed set of terminal reasons, each reachable from a scripted state | Table equality over the reason enum | planned |
| CT-PIN-1 | FR-MCP-4 | Compatibility test against the checked-in pin | Diff of resolved-tree inventory + method keys + frame unions; any add/remove/rename fails | planned |

---

## 3. L2 — seeded property / model (`PT-*`)

All `PT-*` print their seed on start and accept it back via env var. A failure without a
reproducing seed is a test bug.

| Test id | Requirement | What it does | Observable oracle | Status |
|---|---|---|---|---|
| PT-EV-1 | FR-EV-2, FR-EV-6 | Generates randomized event orders (dup / old / out-of-order / interleaved sessions) and folds them | Final canonical state equals the in-order control run for the same event set | planned |
| PT-EV-2 | FR-EV-1, FR-EV-3 | Model test over cursor arithmetic: persist, restart, resume at random points | Cursor monotonic; no duplicate id persisted; no id skipped | planned |
| PT-EV-3 | FR-EV-8 | Bounds model: random long sequences against retention caps | Memory and record counts stay within declared bounds; truncation counters agree with the model | planned |
| PT-CR-1 | FR-STATE-1, FR-STATE-2 | Crash-interleaving model: kills injected at random points around each dispatch step | For every interleaving, the logical operation appears exactly once in the Host request log or is reported `uncertain`; never twice | planned |
| PT-CR-2 | FR-STATE-3 | Crash/restore model over the journal | Replay from any prefix yields a state that matches the expected snapshot; no double-apply | planned |
| PT-OWN-1 | FR-OWN-1 | Randomized multi-process claim/expire/reclaim schedules | At most one owner at any instant; every refused claimant performed zero dispatches | planned |
| PT-CAN-1 | FR-CANCEL-5 | Randomized cancel-vs-completion race interleavings | Exactly one declared terminal reason per run, consistent with the observed event sequence | planned |
| PT-AP-1 | FR-APPR-2 | Randomized approval correlation: correct/stale/replayed/wrong-turn answers | Only the exactly-matching answer is delivered; all others refused | planned |

---

## 4. L3 — real persistence, multiprocess and crash (`PX-*`)

Real files, real processes, real signals. No mocked filesystem.

| Test id | Requirement | What it does | Observable oracle | Status |
|---|---|---|---|---|
| PX-1 | FR-STATE-3 | Two-process: writer process commits, `SIGKILL`, new process reads | Committed state present; state hash matches the post-commit expectation | planned |
| PX-2 | FR-STATE-1 | Kill during dispatch, then inspect the journal on disk | Intent + `requestId` present before any dispatch could have happened | planned |
| PX-3 | FR-STATE-2, FR-STATE-4 | Fake Host drops the ack; restart; reconcile | Exactly one upstream request observed; bridge reports `uncertain` then resolves by reconciliation | planned |
| PX-4 | FR-OWN-2 | Two live processes against one state dir; second attempts to send | Second refused with a typed error; Host request log shows only owner traffic | planned |
| PX-5 | FR-OWN-3 | `SIGKILL` the owner; start a new process with **no manual lock cleanup** | New process becomes owner automatically and reconciles before dispatching | planned |
| PX-6 | FR-OWN-4 | `SIGSTOP` the owner past the lease; second process reclaims; `SIGCONT` | Reclaim succeeds; resumed old owner detects loss and issues no further calls | planned |
| PX-7 | FR-STATE-5 | Injected corruption (truncated/bit-flipped journal), `ENOSPC` on a small loopback device (where permitted) or a quota-limited dir, and `EACCES` | Typed error per case; last-good state readable; no partial mutation visible | planned |
| PX-8 | FR-ID-4 | Real state dir produced by tests is scanned for absolute paths and secret-looking strings | Zero findings; scan fails the suite otherwise | planned |
| PX-9 | FR-EV-1 | Caller process A ingests, process B resumes from the same durable cursor | No re-delivery, no gap; both agree on the cursor | planned |

---

## 5. L4 — fake Host over real HTTP and WebSocket (`FH-*`)

A locally started fake Host implementing the pinned carrier shape: `POST /api/<method>`,
`POST /api/respond` with the real receipt semantics, `426` for plain `GET` on the downlinks,
WebSocket mux + host streams, and a recorded request log that tests assert against.

| Test id | Requirement | What it does | Observable oracle | Status |
|---|---|---|---|---|
| FH-1 | FR-EV-1, FR-EV-4 | Disconnect mid-stream, reconnect, refetch history | Client state equals a control run with no disconnect | planned |
| FH-2 | FR-EV-3 | Injected replay gap (frames silently absent, no `stream/error`) | Bridge detects the gap and reconciles by refetch; final set complete and duplicate-free | planned |
| FH-3 | FR-EV-6 | Duplicate / old / out-of-order / malformed frames | Malformed frame is skipped without killing the stream; gap reported; state converges | planned |
| FH-4 | FR-EV-6, FR-SEC-5 | Oversized frame and oversize response body | Typed oversize outcome; bounded memory; stream survives | planned |
| FH-5 | FR-EV-2, FR-SEC-5 | Pagination and backpressure: slow reader, producer flood | Bounded in-flight memory; pages bounded in size; no unbounded queue | planned |
| FH-6 | FR-CANCEL-4 | Cancel racing a dropped carrier | Typed `uncertain`/refused outcome; never a false `cancelled` | planned |
| FH-7 | FR-APPR-3 | `/api/respond` returns `not-pending` (stale/replayed) | Interaction marked already-resolved-by-host; never "answered by us" | planned |
| FH-8 | FR-MCP-3 | Fake Host answers an unsupported method with an unknown code | Bridge reports unsupported, does not fabricate a value | planned |
| FH-9 | FR-EXEC-2, FR-EXEC-6 | Fake Host reports healthy connection + misleading `attachedSessions` while a session is not running | Bridge's per-session execution state is unaffected; connection stays `up` | planned |
| FH-10 | FR-SESS-6 | Dispatch with a cwd the fake Host rejects (`workspace-invalid-path`) | Typed error surfaced; no retry loop; no partial state | planned |
| FH-11 | FR-EXEC-1 | Bounded program wait under a silent Host (no frames) | Returns `timeout` at the bound; no busy loop (CPU-time observed) | planned |

---

## 6. L5 — MCP E2E over real stdio (`ME-*`)

Every `ME-*` spawns the **built** entry point as a child process and speaks MCP to it with a
real MCP client. Calling internal handlers directly is not an E2E test and does not satisfy
these rows.

| Test id | Requirement | What it does | Observable oracle | Status |
|---|---|---|---|---|
| ME-1 | FR-MCP-1 | Spawn built binary; MCP `initialize`; `tools/list` | Handshake completes with the declared protocol version; tool list matches the schema snapshot | planned |
| ME-2 | FR-MCP-1, FR-MCP-2 | Call each tool with valid and invalid input over the wire | Valid calls succeed; invalid calls return MCP-level errors; fake-Host request log matches exactly the valid calls | planned |
| ME-3 | FR-MCP-3 | Request an operation the negotiated capability set lacks | Explicit unsupported error to the MCP client; no fabricated success | planned |
| ME-4 | FR-EV-2 | Watch/pagination tools stream incremental events to the client | Client receives bounded pages, strictly increasing cursors, no duplicates across pages | planned |
| ME-5 | FR-MCP-6 | Caller cancels a long wait via MCP cancellation | Bridge stops waiting promptly; no further mutating Host requests | planned |
| ME-6 | FR-ID-1 | Kill the server child, respawn against the same state dir, resume the task over MCP | Same ids; no duplicate dispatch of the pre-kill operation | planned |
| ME-7 | FR-SEC-1 | Two MCP clients/tasks against one bridge instance | No cross-task data or events in either client's results | planned |
| ME-8 | FR-MCP-5 | Missing/unwritable state dir; unreachable Host | Fail-closed startup error surfaced through the MCP client, with an actionable message | planned |

---

## 7. L6 — isolated official DSH Host (`IH-*`)

Fixture (verified feasible, §6 of the compatibility report):
`DSH_HOME=<tmp>/home dsh web --port 0 --host 127.0.0.1 --no-open`.

| Test id | Requirement | What it does | Observable oracle | Status |
|---|---|---|---|---|
| IH-0 | — (fixture) | Boot the isolated Host, probe `host.describe`, `session.list` | Boots on an ephemeral port with a fresh home; **measured today**: describe ok, 0 sessions, clean kill, port 3080 untouched | **measured** |
| IH-1 | FR-SESS-1 | Create N sessions through the bridge against a real Host | All created, distinct ids, each reachable in `session.list` with the recorded cwd | blocked: needs a deterministic provider fixture (no paid model) |
| IH-2 | FR-EV-1, FR-EV-4 | Real mux frames, real reconnect | Cursor/state consistent across a forced reconnect | blocked: needs a running turn |
| IH-3 | FR-SESS-3, FR-SESS-4 | Kill the bridge, re-attach from a new process | Same `sessionId`, no new session created by the re-attach path | blocked: needs a running turn |
| IH-4 | FR-APPR-1, FR-APPR-2 | Trigger a real approval-requiring tool call against a policy that asks | Interaction pending until answered; wrong-turn/stale answers refused; the Host's own state confirms the outcome | blocked: needs the provider fixture **and** an approval-triggering policy |
| IH-5 | FR-CANCEL-1, FR-CANCEL-2 | Real `session.cancel` with queued work **and** a real child process | Turn stops; queued items survive per Host semantics; subprocess claim carries process evidence (L8 oracle) | blocked: needs the provider fixture |
| IH-6 | FR-MCP-4 | Capability negotiation against the real pinned Host | Declared cap set matches the Host's actual answers; a missing method is reported unsupported | planned (can run without a turn) |

**Gate for L6 in default CI:** the mock-provider question (compatibility report §7) must be
resolved first, so that no automated test can reach a paid endpoint. Until then, every
turn-level `IH-*` row stays `blocked`, and that word — not "passing" — is what gets reported.

---

## 8. L7 — opt-in live deepseek-flash (`LIVE-*`)

Separately created test DSH home, Host and session set. Route: the company
`sx-anthropic/deepseek-flash` route **as configured by the operator**, by env reference
only. **No automatic provider fallback**: if the configured route is not routable, the suite
fails and says so; it never silently picks another model.

Hard caps: wall time ≤ 20 min for the whole suite, concurrency ≤ 8, no retries until green,
first failures reported verbatim, usage reported. Port 3080 and existing tasks are never
touched. Raw provider evidence stays in the ignored `.local/`.

| Test id | Requirement | What it does | Observable oracle | Status |
|---|---|---|---|---|
| LIVE-1 | FR-SESS-1 | 2 / 4 / 8 parallel sessions, each with a unique memory marker | Every session recalls its own marker; no sibling's marker appears in its history | blocked (opt-in; requires operator-provided route + budget) |
| LIVE-2 | FR-SESS-1, FR-SEC-1 | ≥3 rounds of unique-memory isolation | Round N's markers never surface in a later round of another session | blocked (opt-in) |
| LIVE-3 | FR-SESS-3, FR-STATE-3 | New caller process / new bridge process recovery | Same task and session ids; no duplicate dispatch; no lost turn | blocked (opt-in) |
| LIVE-4 | FR-SESS-3 | Isolated Host restart (own home) then re-attach | Session survives, work resumes, no manual lock deletion | blocked (opt-in) |
| LIVE-5 | FR-EXEC-5 | Route configuration by env reference; unroutable route handling | Configured route performs a real turn; an unroutable route fails with a typed error | blocked (opt-in) |

A green `LIVE-*` run is the only thing that may be called "verified against a real model".
When it is skipped, every document says skipped.

---

## 9. L8 — process oracle (`OR-*`)

| Test id | Requirement | What it does | Observable oracle | Status |
|---|---|---|---|---|
| OR-1 | FR-CANCEL-2 | Start a real long-running child process through an agent turn; attempt cancellation | Claim about the subprocess is backed by an observed pid + exit/reap; otherwise reported as unobserved | blocked: needs a resolvable tool surface for the process and an isolated Host |
| OR-2 | FR-CANCEL-2 | Negative control: cancel a turn whose process has already exited | No claim of "stopped by us"; report distinguishes already-exited from stopped | blocked (same dependency) |
| OR-3 | FR-SEC-4 | Symlink escape attempt during an agent filesystem operation | Refused or safely resolved; no write outside the owned workspace, verified by scanning the escape target | planned |
| OR-4 | FR-EXEC-2 | Carrier death while a child is demonstrably alive | Execution reported as unknown/running with evidence, never as stopped | blocked (needs the fixture) |

---

## 10. L9 — security, adversarial input and bounds (`SEC-*`)

| Test id | Requirement | What it does | Observable oracle | Status |
|---|---|---|---|---|
| SEC-1 | FR-SEC-3 | Synthetic sentinel secrets planted in config/env and in Host responses | Zero occurrences in state files, logs, error messages, MCP results, or evidence artifacts | planned |
| SEC-2 | FR-APPR-4 | Adversarial document/event text instructing the bridge to approve, or impersonating a human | No approval ever emitted; fake-Host log shows zero `respond` calls for those interactions | planned |
| SEC-3 | FR-APPR-4 | Approval request whose text claims "already approved" / "urgent" | Still pending until a real caller intent arrives | planned |
| SEC-4 | FR-SEC-1 | Cross-session/cross-task isolation under interleaved traffic | No data or event crosses tasks (fake Host and live both) | planned |
| SEC-5 | FR-SEC-2 | Filesystem scope audit of the whole suite | Recorded write paths all inside allowed roots; no write to a real DSH home, other repos, or port 3080 | planned |
| SEC-6 | FR-SEC-5 | Memory/log growth bounds under a long randomized run | Configured caps respected; counters agree with observed growth | planned |
| SEC-7 | FR-EV-7 | Cursor retention gap (`FR-EV-7`) | Typed "cursor expired" outcome with the documented refetch path; never a silent gap | planned |

---

## 11. L10 — mutation / negative controls (`MT-*`)

Negative controls exist to prove the suite can fail. Each mutates the implementation, runs a
targeted suite, and **requires red**.

| Test id | Requirement | Mutation | Required outcome | Status |
|---|---|---|---|---|
| MT-1 | FR-STATE-2 | Remove the durable-intent write before dispatch | `PX-2`/`PT-CR-1` fail | planned |
| MT-2 | FR-STATE-2 | Allow one blind re-send after an unknown outcome | `PX-3`/`PT-CR-1` fail (duplicate dispatch observed) | planned |
| MT-3 | FR-STATE-4 | Map `uncertain` to success | `PX-3`, `FH-6`, `OR-4` fail | planned |
| MT-4 | FR-OWN-1 | Replace the atomic claim with check-then-delete | `PT-OWN-1`/`PX-5` fail (two owners or manual cleanup needed) | planned |
| MT-5 | FR-APPR-1 | Auto-approve on timeout / on reconnect | `SEC-2`/`SEC-3`/`IH-4` fail | planned |
| MT-6 | FR-EV-3 | Ignore gaps instead of reporting/reconciling | `FH-2`/`PT-EV-1` fail | planned |
| MT-7 | FR-CANCEL-2 | Claim subprocess stopped without evidence | `OR-1`/`OR-2` fail | planned |
| MT-8 | FR-MCP-3 | Fabricate success for an unsupported method | `FH-8`/`ME-3` fail | planned |

Mutation runs are a shard in CI (targeted, time-bounded), not a full-suite pass.

---

## 12. L11 — CI (`CI-*`)

| Test id | Requirement | What it does | Observable oracle | Status |
|---|---|---|---|---|
| CI-1 | FR-EV2-3 | Linux + macOS matrix, frozen lockfile install | Both jobs green from `--frozen-lockfile`; no network install drift | planned |
| CI-2 | FR-EV2-3 | Counts reported distinctly | Report shows failed / skipped / timed-out as three separate numbers; a skipped live suite is visibly skipped | planned |
| CI-3 | FR-EV2-4 | Untrusted PR context (fork-like) | No secret is available to the job; live suite cannot run even if requested | planned |
| CI-4 | FR-EV2-5 | Machine-readable per-layer JSON artifacts | Artifact contains per-layer results with test ids, statuses, durations, seeds | planned |
| CI-5 | FR-EV2-6 | Coverage for critical modules | Report names the critical modules (state store, ownership, event cursor, approval binding, host client) with the oracle for each | planned |
| CI-6 | FR-EV2-3 | Timeout policy per suite, reported as timeout (not failure) | A deliberately hung test is reported as timed out, distinctly | planned |
| CI-7 | FR-SEC-3 | Secret scanner over the working tree and artifacts | Fails the build on any hit | planned |

---

## 13. L12 — soak (`SOAK-*`)

| Test id | Requirement | What it does | Observable oracle | Status |
|---|---|---|---|---|
| SOAK-1 | FR-EV2-7 | Resumable runner: real wall-clock duration, restart checkpoints, continuity counters, gap counts | JSON + human report per checkpoint; resuming continues rather than restarting | planned (short smoke only) |
| SOAK-2 | FR-EV2-7 | Multi-day observation | Real elapsed time ≥ the claimed window, with continuity evidence | **blocked**: explicitly a later measured milestone. A short smoke run is not multi-day proof, and no document may claim it. |
| SOAK-3 | FR-EV2-7 | No automatic multi-day paid loops | The runner refuses to start a multi-day paid configuration without explicit operator intent | planned |

---

## 14. Coverage targets (behavioural, not a percentage)

Coverage must be *meaningful for critical modules*, so the matrix tracks these modules
explicitly rather than one global number:

| Critical module | Behaviour that must be covered | Primary layers |
|---|---|---|
| Durable state store (journal, intent records, replay, versioning) | write-before-dispatch, crash replay, corruption/ENOSPC/EACCES, version refusal | L1, L2, L3 |
| Ownership / lease | atomic claim, refusal, expiry reclaim, no manual cleanup, resume-after-loss | L2, L3 |
| Event ingest & cursor | paging, dedupe, gap detection + refetch, retention floor, bounds | L2, L4, L5 |
| Approval / interaction binding | pending-until-intent, exact correlation, stale/replay refusal, receipt semantics | L1, L2, L4, L9 |
| Cancellation scopes | turn vs queue separation, uncertain outcomes, subprocess evidence | L1, L4, L8 |
| Host client carrier | envelopes, echo verification, error-code mapping, WS lifecycle, oversize, trust fence authority | L1, L4, L6 |
| MCP face | real stdio handshake, strict schemas, unsupported reporting, cancellation | L5 |

A row here is satisfied by a named test id above, never by "line coverage of this file".

---

## 15. What this matrix does NOT claim

- No row is executed. `measured` appears exactly once (`IH-0`, the Phase-0 fixture probe).
- `blocked` rows are dependencies, not failures and not passes.
- The live suite has never been run; nothing in this repository may be described as
  "verified against deepseek-flash" until `LIVE-1`…`LIVE-5` actually run and link evidence.
- Default CI can never produce a full-pass claim while any row is skipped or blocked; the
  reports must carry the three distinct counts and the blocked list.
