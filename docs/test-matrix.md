# Test matrix — requirement → layer → evidence

Task: `DSH-PILOT-20260912`. This file maps every requirement in
[`requirements.md`](requirements.md) to the layer that proves it and to the test that exists
**today**. There is no `planned` status: a row either names a test that ran, or says plainly what is
missing and why.

| Status | Meaning |
| --- | --- |
| `measured` | A named test exists, runs on the environment in §7, and passes. It is the oracle the requirement asked for. |
| `partial` | The code exists and part of the oracle is asserted. The unproven part is named in the row, and the row is never reported as `measured`. |
| `unverified` | The behaviour is implemented — or holds by construction — but **no test asserts it**. Nothing here is a result. |
| `not-implemented` | The capability itself is absent from this build. |
| `blocked` | Proving it needs something not available here: real elapsed time, or an observable the upstream contract does not have. |

Where a requirement is only partly blocked, the row is `partial` and names the blocked half rather
than carrying a whole-row `blocked` status: that applies to `FR-EV2-7` (the runner and its bounded
smoke exist; the 48-hour observation needs real elapsed time) and to `FR-CANCEL-2` (the prohibition
is measured; claiming a subprocess *did* stop would need a Host receipt that does not exist).

Rule for reading this document: **a skipped or unrun test is never a pass.** The default run skips
the whole isolated-Host layer and never selects the live layer; §7 reports those counts separately
and §2 shows them per layer.

---

## 1. How to run the tests

Requirements: Node ≥ 24 (the bridge uses the built-in `node:sqlite`), macOS or Linux. There are no
runtime dependencies; `npm ci` installs `typescript` and `@types/node` for the build and the type
gates only.

The implementation is **TypeScript source** under `src/`, and every layer listed here runs the
compiled output under `dist/` — a suite that spawns the MCP server spawns `dist/bin/dsh-pilot-mcp.js`,
and the suites import the compiled modules. So `npm run build` comes first; `test/run.mjs` refuses to
start with exit `2` and names the missing build when `dist/lib/ids.js` is absent.

| Command | What it runs | Needs |
| --- | --- | --- |
| `npm test` (or `node test/run.mjs`) | the default deterministic layers: unit, property, fake-host, persistence, mcp-e2e, isolated-host, security — the isolated-Host cases are listed but skip themselves without `--isolated` | nothing else; no network, no credentials |
| `node test/run.mjs test/unit test/property` | one or more named layer directories | — |
| `node test/run.mjs --filter=owner-lock` | every case whose id contains a string | — |
| `node test/run.mjs test/isolated-host --isolated` | the isolated **official** DSH Host layer | an installed `@deepseek-ai/dsh` (or `DSH_PILOT_DSH_BIN`), and an ephemeral port |
| `node test/run.mjs test/live --live` | the opt-in live layer against the operator's real provider route | the operator's own DSH settings + credential, and the willingness to spend real quota |
| `node test/mutation/run.mjs [--only NAME] [--json FILE]` | the negative controls (§4) | — |
| `node test/soak/run.mjs --minutes N` (or `--hours N [--resume]`, `--status`) | the resumable soak runner | — |
| `npm run build` | `tsc -p tsconfig.json`: `src/**/*.ts` → `dist/`, `strict` **and** `noImplicitAny` | `npm ci` |
| `npm run typecheck:contract` | `tsc -p tsconfig.contract.json`: `src/lib/{errors,mcp-tools,mcp-protocol}.ts` with the Node type surface removed | `npm ci` |
| `npm run typecheck:tests` | `tsc -p tsconfig.test.json`: `test/**/*.mjs` (`allowJs` + `checkJs`, `noEmit`, `noImplicitAny: false`) checked against the declarations emitted into `dist/` | `npm ci`, and a build |

Environment knobs a reader may need: `DSH_PILOT_JSON=<path>` (machine-readable report),
`DSH_PILOT_SEED` (replay a property run), `DSH_PILOT_PROPERTY_ROUNDS` (property rounds),
`DSH_PILOT_STATE_DIR`, `DSH_PILOT_HOST_URL`, `DSH_PILOT_ALLOW_REAL_STATE=1` (only if a state
directory at or under `~/.dsh` or `~/.local/state` is genuinely intended), `DSH_PILOT_SETTINGS_FILE`
(live layer), `DSH_PILOT_DSH_BIN` (isolated layer).

Safety properties of the suite itself: no test binds port `3080`; the isolated and live rigs boot
their own Host on an OS-assigned port inside their own temporary `DSH_HOME`; the live rig refuses a
URL ending in `:3080`; every state directory is a per-test scratch dir; the live layer refers to a
credential by environment-variable **name** only (`SX_API_KEY` in the operator's own settings is
read as a name, and its value goes straight into the child's environment and is never read back).

---

## 2. Layers and their measured counts

Default run, this machine (macOS `darwin/arm64`, Node `v24.15.0`), `node test/run.mjs`:

| Layer | Directory | Transport / process | Default | passed | failed | skipped | timed out |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Unit / contract | `test/unit` | in-process plus real child processes for ownership | yes | 21 | 0 | 0 | 0 |
| Seeded property / model | `test/property` | in-process, seeded, reference model independent of `src/` | yes | 3 | 0 | 0 | 0 |
| Fake-Host contract | `test/fake-host` | real HTTP + real WebSocket against our own fixture Host | yes | 17 | 0 | 0 | 0 |
| Persistence and crash | `test/persistence` | real processes, real `SIGKILL`/`SIGSTOP`, real restarts | yes | 6 | 0 | 0 | 0 |
| MCP E2E (stdio) | `test/mcp-e2e` | the built `dist/bin/dsh-pilot-mcp.js` spawned and driven over real pipes | yes | 8 | 0 | 0 | 0 |
| Isolated official Host | `test/isolated-host` | a real DSH Host, own home, ephemeral port, loopback mock provider | **opt-in (`--isolated`)** | 0 | 0 | 10 | 0 |
| Security and bounds | `test/security` | real sockets, real files, real `lsof` | yes | 9 | 0 | 0 | 0 |
| Live provider | `test/live` | real DSH Host + the operator's real route | **opt-in (`--live`)**, never in CI | *(not selected)* | — | — | — |

`passed=64 failed=0 skipped=10 timedOut=0` for the default run. The live layer is **not** in the
default layer list at all: when it is not selected the runner prints
`live suite: SKIPPED (opt-in; not selected on this run)`.

**Fixture separation is not negotiable.** The fake Host (`test/fixtures/fake-host.mjs`) is our own
code and a passing run against it is evidence about our client only. The isolated Host is the real
product booted by the test. They live in different directories, print different labels, and neither
is presented as evidence for the other. The live layer is a third thing again: a real Host against a
real model route.

---

## 3. Requirement → test → evidence

Requirement ids and priorities come from [`requirements.md`](requirements.md) §3 and keep its
numbering. Test ids are `<layer>/<file>::<case name>` — exactly what the runner prints, and what
`--filter=` matches on.

### 3.1 Identity and sessions (`FR-ID`, `FR-SESS`)

| Req | Pri | Status | Test id(s) | Evidence, and what is not covered |
| --- | --- | --- | --- | --- |
| FR-ID-1 | P0 | measured | `mcp-e2e/multi-caller::FR-ID-1: taskId, sessionId, turnId, operationId and interactionId are byte-identical across a daemon restart`; `mcp-e2e/multi-caller::FR-ID-1: the ids are in the journal, and the intent record is durable before the Host sees the send`; `persistence/crash::a restart preserves task, session and event identity, and never invents a new session`; `unit/core::durable-before-send: the dispatching row is committed before any network write` | All five ids are read through the real MCP stdio face before and after a real daemon restart and compared byte for byte, and each id is asserted to exist as a row of its own kind in the journal. **Honest limit:** the outside can prove the intent record is committed while the send is still unacknowledged, is body-identical to what the Host received, and survives a `SIGKILL` — it **cannot** observe the byte-level commit-before-write ordering *inside* the daemon, which stays a unit assertion (`unit/core::durable-before-send…`). |
| FR-ID-2 | P0 | measured | `fake-host/contract::session.create retries idempotently with the preallocated id and reports a cwd conflict`; `fake-host/contract::a host business refusal is recorded as refused with the host code preserved`; mutation `session-create-id-not-reused-on-retry` (production) | A stored retry reuses the stored host session id rather than minting a new one, and a business refusal keeps the Host's own code. **Review-0945 round:** `fake-host/session-create-value::the Host session id from session.create is recorded, not replaced by the id this bridge minted` — the read was one level too deep (`result.value['value']`, a key that never exists), so the Host's own session id was discarded on every create and a locally minted UUID took its place in every answer that names a session. |
| FR-ID-3 | P1 | partial | `fake-host/contract::concurrent sessions: 8 sessions run 3 rounds each with per-session isolation` | Eight sessions created in one process are all distinct. **Not covered:** no test spawns ≥ 8 concurrent *creator processes* against one state directory; cross-process creation is bounded by single ownership (only one daemon may own the directory) but that bound is not itself the oracle the requirement asked for. |
| FR-ID-4 | P2 | partial | `unit/core::id namespaces are separate and validated per kind`; `security/bounds::state directory contents contain no credential values, only references` | Every id carries a kind prefix, is validated per kind, and cross-kind use is refused; durable state holds references rather than credential material. **Not covered:** no test asserts that no absolute path fragment can appear inside an id. |
| FR-SESS-1 | P0 | measured | `fake-host/contract::concurrent sessions: 8 sessions run 3 rounds each with per-session isolation`; `live/live::three real sessions recall only their own planted fact`; `live/live::sessions run in parallel at widths 2, 4 and 8 without cross-contamination`; `isolated-host/turns::two sessions on one real Host stay isolated, and each ends on its own turn` | Parallel sessions on the fixture and on a real Host, with per-session markers that must not appear in a sibling's log. |
| FR-SESS-2 | P0 | measured | `live/live::three real sessions recall only their own planted fact` (each round is a plant turn and a recall turn in the *same* session); `mcp-e2e/stdio::a full session lifecycle driven only through MCP tools` | Follow-up turns are attributed to the same session and both turns appear in its log. |
| FR-SESS-3 | P0 | measured | `persistence/crash::a restart preserves task, session and event identity, and never invents a new session` (asserts exactly one `session.create` reached the Host across the restart); `live/live::a SIGKILL during a live turn leaves durable history and an honest, unresolved outcome` | Re-attach does not create a second session. |
| FR-SESS-4 | P0 | measured | `mcp-e2e/multi-caller::FR-SESS-4: two independent caller processes read the same durable task snapshot, byte for byte`; `mcp-e2e/multi-caller::FR-SESS-4: both callers read identical event cursor semantics and the same sequence set`; `mcp-e2e/multi-caller::FR-SESS-4: a second attach neither steals nor duplicates the session`; `mcp-e2e/multi-caller::FR-SESS-4 / FR-ID-1: a restarted caller process resumes the same cursor and creates no session` | Two real MCP servers are spawned over real stdio as separate OS processes against one daemon and one state directory; the snapshot text and the event page are compared as text, and the page union is compared with the journal's own sequence set. **Not covered:** there is no `task.get` or `session.list` tool, so the snapshot is `dsh_task_start` + `dsh_session_state` text and the "exactly one session" count is read from the durable journal plus the Host's independent receipt count. |
| FR-SESS-5 | P1 | unverified | — | The bridge has no discovery path that could adopt a session it did not create, so the property holds by construction. No test asserts it: the isolated Host always starts with zero sessions and the live rig always creates its own single-use home. |
| FR-SESS-6 | P1 | measured | `fake-host/contract::session.create retries idempotently with the preallocated id and reports a cwd conflict`; `security/workspace-cwd::a workspace replaced by a symlink to another directory is refused before dispatch, and no prompt is sent`; `::a workspace that was deleted, or replaced by a file, is refused before dispatch and no prompt is sent` | The recorded cwd IS now re-verified before every dispatch, and the "refused, and NO PROMPT WAS SENT" oracle is asserted against the fake Host's received-request log. **Still not covered:** the fixture never answers `workspace-invalid-path`, so the Host's own cwd refusal is untested. |
| FR-SESS-7 | P2 | not-implemented | — | No rename operation or tool exists. `session.rename` is in the pinned method inventory in `src/lib/adapter.ts`; nothing calls it. |

### 3.2 Durable state, crash behaviour and ownership (`FR-STATE`, `FR-OWN`)

| Req | Pri | Status | Test id(s) | Evidence, and what is not covered |
| --- | --- | --- | --- | --- |
| FR-STATE-1 | P0 | measured | `unit/core::durable-before-send: the dispatching row is committed before any network write` (reads the row back from a **second** SQLite connection); `persistence/crash::SIGKILL during dispatch: the next process reports the operation as uncertain, never as sent` (the Host saw exactly one `session.prompt`); `property/model::idempotency keys under repeated submission produce exactly one durable operation`; mutation `durable-intent-after-send` (production, caught by two persistence cases) | The intent and its outbox row are committed before the send, and a crash out of `dispatching` leaves it visible for the next process. |
| FR-STATE-2 | P0 | measured | `fake-host/contract::dropped ack after send becomes uncertain, is never retried, and never duplicates the send`; `persistence/crash::SIGKILL during dispatch…`; `mcp-e2e/stdio::uncertain outcomes are reported as errors so a caller cannot mistake them for success`; `live/live::a SIGKILL during a live turn…`; mutations `durable-intent-after-send` and `ack-loss-reported-as-success` (production, both caught) | Repeating the same logical call returns `previously-sent-outcome-unknown` and never reaches the wire again. Scope: the evidence is example-based across four layers; the seeded crash-interleaving model from the original plan was **not** built, so "exactly once under every interleaving" is not claimed. |
| FR-STATE-3 | P0 | measured | `persistence/crash::a restart preserves task, session and event identity…` (event count and cursor `highWater` unchanged); `live/live::a SIGKILL during a live turn…` (stored sequences are contiguous across the crash); mutation `duplicate-rows-written` (production, caught) | No duplicate dispatch, no cursor regression, no duplicate event after a real `SIGKILL`. |
| FR-STATE-4 | P0 | measured | `fake-host/contract::dropped ack after send becomes uncertain…` (`uncertainReason` names `after-send`/`timeout`); `persistence/crash::SIGKILL during dispatch…` (reason `crash-during-dispatch` is preserved); `mcp-e2e/stdio::uncertain outcomes are reported as errors…` | `uncertain` is a persisted state carrying the evidence that produced it, and it is surfaced to the caller with `isError: true`. |
| FR-STATE-5 | P0 | measured | `persistence/storage-failure::ENOSPC on write: a typed STORAGE_FULL, the last good state intact, and no partial mutation visible`; `persistence/storage-failure::EACCES on write: a real read-only state directory is refused with STORAGE_UNAVAILABLE and the last good state survives`; `persistence/storage-failure::EACCES at startup: the daemon refuses to run against an unwritable state directory and sends nothing`; `persistence/storage-failure::corrupt state: the daemon refuses to start with STORAGE_CORRUPT, preserves the evidence and never contacts the Host`; `persistence/storage-failure::refuse to dispatch: an intent that cannot be persisted never reaches the Host` | Typed codes, preserved last-good state and no-partial-mutation are asserted, and the "never reaches the Host" oracle is the fake Host's own request log. **Honesty:** `EACCES` and the corruption case are REAL filesystem conditions (`chmod 0500`, bytes overwritten, real `pragma integrity_check`), but **`ENOSPC` is NOT a real full disk** — there is no portable unprivileged way to exhaust a volume on both CI platforms, so growth is capped with the database's own `pragma max_page_count` and the real SQLite engine raises its real `SQLITE_FULL`. Every ENOSPC failure message says so. **Fixed this round (startup):** a storage failure while *constructing* the daemon used to escape the typed-error handler at the process boundary — exit 1 with no typed payload. `src/bin/dsh-pilot-daemon.ts` now routes construction, `start()` and `startEventIngest()` through one `failStartup` that writes the typed error as JSON and exits 4 for `OWNER_HELD` and 5 otherwise, and the EACCES-at-startup case asserts both the exit code and a typed payload matching `/STORAGE_UNAVAILABLE|STORAGE_CORRUPT|STORAGE_FULL/`, plus preserved state and no Host contact. **Known gap:** the exit codes are this project's own contract, not the Host's, and nothing asserts that a *second* startup failure mode (for example a corrupt `-wal` beside a valid database) lands on the same path. |
| FR-STATE-6 | P1 | not-implemented | — | There is no rotation and no compaction. `logMaxBytes` is a configured number with nothing enforcing or testing it beyond a WAL checkpoint on clean shutdown, so "growth is bounded and a compacted state can be replayed" is not a property of this build. |
| FR-STATE-7 | P1 | measured | `unit/core::a state file from a newer bridge is refused, not misread` (`STATE_VERSION_UNSUPPORTED`, with the found version in the details) | An unknown future schema version is refused rather than misinterpreted. **Review-0945 round:** `unit/core::a state file written before a column existed is brought up to shape instead of failing mid-operation` covers the OTHER direction — a state file from an OLDER bridge. `create table if not exists` does nothing to a table that already exists, so a column added to the DDL is absent from every database already in use, and the code reading it then fails in the middle of an operation on exactly the machines that have been running the bridge. `applyMigrations` checks for the column and adds it, and the recorded `schema_version` follows the shape on disk. The test builds the old table by hand WITH a row in it, opens it through the store, and asserts the old row survives unchanged (a migration must not invent a value for it) while the new column is usable. |
| FR-STATE-8 | P2 | partial | [`architecture.md`](architecture.md) §10 documents the layout; `security/bounds::IPC is a local socket with 0600 permissions, not a network listener`; `persistence/crash::state directory permissions: the authority token is private to the operator account`; `unit/owner-lock::the lock file keeps its inode, so releasing and re-taking cannot split ownership` | The layout is documented and its pieces are asserted individually. **Not covered:** no docs-to-reality check compares the documented layout to a real state directory field by field. **Review-0945 round:** the two ends of the IPC socket now share ONE reply bound (`MAX_IPC_REPLY_BYTES`, `DSH_PILOT_IPC_REPLY_MAX_BYTES`), because a bound applied by one end of a socket is not a bound on the connection: the server capped what it ACCEPTED and the client capped nothing, so a peer that never sent a newline grew a gateway's buffer without limit. Cases: `network/ipc-bounds::a peer that never sends a newline is refused on received bytes instead of being buffered forever`; `network/ipc-bounds::the bound is per reply, so a long series of small replies is not refused`; `network/ipc-bounds::the daemon refuses to WRITE a reply above the bound…`; `network/ipc-bounds::the shipped reply bound is the same number on both ends…`. Framing on both sides is now a streaming decode (`network/ipc-bounds::a reply whose multi-byte characters are split across chunk boundaries is decoded exactly`, `::the daemon decodes a request split mid-character…`), because a chunk boundary is not a character boundary and per-chunk decoding puts a replacement character where the peer sent a character. |
| FR-OWN-1 | P0 | measured | `unit/owner-lock::the lock database is held in exclusive locking mode, not merely remembered`; `unit/owner-lock::a second holder is refused, and an uncooperative connection cannot take the file`; `unit/core::exclusive ownership: a second handle is refused, and the holder keeps it while stopped`; `unit/core::the daemon refuses to start when the state directory is already owned`; `persistence/crash::two daemons cannot own one state directory, and a clean release lets the next one in`; mutation `second-owner-not-refused` (production) | Kernel-enforced exclusion: the second holder is refused, an *independent* process that knows nothing about `OwnerLock` cannot take a write lock, and a second daemon exits `4` with `OWNER_HELD`. |
| FR-OWN-2 | P0 | measured | `unit/core::the daemon refuses to start when the state directory is already owned`; `persistence/crash::two daemons cannot own one state directory…` | A refused daemon exits before it opens the store, binds IPC or contacts the Host, so it sends nothing. Scope: "the Host request log shows only owner traffic" is satisfied by that ordering rather than by an assertion on the loser's request log — it never opens a connection to assert against. |
| FR-OWN-3 | P0 | measured | `persistence/crash::SIGKILL during dispatch…` (a new process starts against the same directory with no manual cleanup); `unit/owner-lock::a stale marker left by a dead holder does not block a new owner`; `unit/owner-lock::the marker file is informational only: deleting it does not release anything` | Ownership is decided by the kernel lock, never by a file's presence, and a dead owner's directory is reclaimable automatically. |
| FR-OWN-4 | P1 | not-implemented | Measured **inverse**: `persistence/crash::SIGSTOP on the living owner: ownership is retained, and it comes back with its state`; `unit/core::exclusive ownership… the holder keeps it while stopped` | The requirement asks for a lease that a hung owner loses. This build deliberately refuses that ([`adr/0002-owner-exclusion-primitive.md`](adr/0002-owner-exclusion-primitive.md)): a paused owner may hold unflushed durable state, and handing the directory to a second process while the first lives is the failure mode the design exists to prevent. What is measured is the opposite property — a `SIGSTOP`ped owner keeps ownership, a `SIGCONT`ed owner resumes as the owner with its state intact, and a `SIGKILL`ed owner is released by the kernel. A hung owner therefore holds the directory until it is killed; the remedy is process-level, not a lock file. |
| FR-OWN-5 | P1 | partial | `store.audit` writes `daemon-started`, `session-created` and `approval-unauthorized` rows; `security/bounds::the authority token is never readable through the IPC surface` | Some transitions are journalled. **Not covered:** claim / release / reclaim are not recorded as ownership transitions (only daemon start is), and no test inspects an ownership history. |
| FR-OWN-6 | P2 | partial | Stated plainly in [`architecture.md`](architecture.md) §7 ("a coordination device, not a security boundary") and in ADR 0002; `unit/owner-lock::the marker file is informational only…` shows the marker is not authority | The non-claim is documented. **Not covered:** no test detects and reports a foreign process that writes the state directory without following the protocol. |

### 3.3 Events, cursors, execution and waiting (`FR-EV`, `FR-EXEC`)

| Req | Pri | Status | Test id(s) | Evidence, and what is not covered |
| --- | --- | --- | --- | --- |
| FR-EV-1 | P0 | measured | `property/model::cursor conclusions are stable no matter how many times the same stream is replayed`; `persistence/crash::a restart preserves task, session and event identity…` (cursor `highWater` preserved across a restart); `fake-host/contract::disconnect then reconnect refetches history and converges to the control state` | Durable per-session cursors, and a restart that neither re-delivers nor loses. |
| FR-EV-2 | P0 | measured | `security/bounds::an event page is bounded by the configured maximum regardless of what is asked for` (`limit: 5` returns 5 with `hasMore: true`; `limit: 10_000_000` is clamped to ≤ 200); `persistence/event-page-bytes::FR-STATE-4 paging: a page is bounded by serialised UTF-8 bytes, and the reply reports the bytes it cost`; `persistence/event-page-bytes::FR-STATE-4 paging: paging with the cursor delivers every event exactly once, in order, with nothing dropped by the byte budget`; `persistence/event-page-bytes::FR-STATE-4 paging: a single event larger than the whole page budget is delivered and named, so the cursor can still advance`; `persistence/event-page-bytes::FR-STATE-4 paging: a page that is not truncated says so, and the count limit still applies`; `property/model::generated event streams: stored sequences and gap conclusions match an independent model`; `mcp-e2e/stdio::a full session lifecycle driven only through MCP tools` **Fixed in the review-0710 round:** `eventPageMaxBytes` was declared in `DEFAULT_LIMITS` and in `docs/architecture.md` and read by NOTHING — the only limit a page respected was a count, so 200 events of a megabyte each were a 200-megabyte reply built in this process. The byte budget is now enforced on the serialised UTF-8 size of the reply, walking the window newest-first so the page stays a contiguous run and a paging loop sees every event exactly once; a single event over the whole budget is delivered anyway and named in the page's `oversize` list (skipping it would lose it silently, and an empty page would loop the caller forever); and `hasMore` is now asked of the database rather than inferred from the page length, because a byte-limited page is short while older events remain and a full page may be the whole history. A negative control that ignores the budget fails with `got 10832` against a 2048-byte limit; a control that restores the page-length inference fails all four cases. | Pages are bounded and carry `completeness`, `completedThrough`, `highWater` and any gap. Shape note: continuation is a **backwards** cursor (`beforeSeq`, "strictly below"), not a forward token; the schema bounds `limit` to 1..200. **Review-0945 round:** the page budget's single-oversize-event exemption is now reconciled with the IPC reply bound it can cross: `persistence/event-page-vs-ipc-bound::an event larger than the IPC reply bound is refused with its seq named, and paging past that seq makes progress` and `::the same event is delivered alone when the configured bound allows it…`. The refusal names the seq and both bounds because the alternative — a frame the server will not write — told the caller only that something failed, with no way to advance past the one event it could not receive. |
| FR-EV-3 | P0 | measured | `fake-host/contract::a silent frame gap is reported as incomplete and cannot be smoothed over`; `fake-host/contract::malformed and duplicate frames do not corrupt state, and duplicates are counted not re-stored`; `property/model::generated event streams…` (the completeness verdict must equal the independent model's); mutation `gap-smoothed-over` (production) | A hole is reported with its range and never presented as a complete log. |
| FR-EV-4 | P0 | partial | `fake-host/contract::disconnect then reconnect refetches history and converges to the control state` (reopen the downlink **and** refetch, because mux `since` is unimplemented upstream; `eventStats.reconnects` is counted); `isolated-host/reconnect::FR-EV-4: a real Host serves the history page the reconnect refetch depends on, and it carries a turn that really ran`; `isolated-host/reconnect::FR-EV-4: after the real Host is restarted on a new port, the durable state reattaches and still serves the pre-restart events` | Measured against the fixture, and now also against a **real official Host** booted by the test in its own `DSH_HOME` on an ephemeral port: the history page's real shape is asserted and a daemon restarted against the moved origin reattaches and still serves the pre-restart events. **Not covered:** the real-Host cases are in the opt-in isolated layer, which does NOT run in CI, and the live layer was not run this round; the real-Host restart moves the origin (a genuine `session-conflict` path was exercised) rather than forcing a mid-turn socket drop, so the *disconnect* half against a real Host is still unproven. `session.events` completeness for a hole a refetch could not fill is asserted only against the fixture. |
| FR-EV-5 | P1 | unverified | — | Interactions are keyed durably by correlation id, so a replayed request resolves to the row that already exists rather than arming a second one — but **no test replays a frame** and asserts that. The case named `fake-host/contract::approvals: a replayed request is not re-armed, and the receipt decides the reported meaning` records one approval and asserts it stays `pending`; its name promises more than its body checks. |
| FR-EV-6 | P1 | measured | `fake-host/contract::malformed and duplicate frames do not corrupt state…` (raw non-JSON and truncated frames on the real socket; duplicates counted, not re-stored); `property/model::cursor conclusions are stable…` (shuffled duplicates collapse to one row each); `security/bounds::an oversized event frame is refused as oversize rather than buffered` | Duplicate, old, out-of-order and oversize input leave the canonical state unchanged. |
| FR-EV-7 | P1 | not-implemented | — | There is no retention window and no age-based expiry. `CURSOR_EXPIRED` means exactly one thing today: a cursor bound to a different store generation (`src/lib/daemon.ts`). No test asserts a typed "cursor expired" with a documented refetch path. |
| FR-EV-8 | P2 | not-implemented | — | Counters exist (`health.eventStats`: frames, stored, duplicates, gaps, malformed, oversize, reconnects, historyTruncations) and caps are configured, but no long-running test asserts that memory or on-disk event records stay under a cap, or that truncation counters agree with observed growth. |
| FR-EXEC-1 | P0 | measured | `fake-host/contract::wait returns a closed-set reason and a deadline is a timeout, not a hang` (`no-turn-observed`; `timeout` inside the deadline; `turn-ended` when the terminal event arrives); `mcp-e2e/stdio::a full session lifecycle driven only through MCP tools`; `mcp-e2e/stdio::cancelling a wait does not cancel the turn, and the server keeps serving` | A bounded wait always returns a reason from a closed set; a deadline is reported as a timeout. |
| FR-EXEC-2 | P0 | measured | `fake-host/contract::execution state is not derived from connection state` (the carrier is killed while a turn is open: execution stays `running`, connection is not `ready`); `persistence/crash::SIGSTOP on the living owner…` (the resumed owner rebinds its downlink and returns to `ready`) | Connection state and execution state are separate facts in both directions. |
| FR-EXEC-3 | P0 | measured | `fake-host/terminal-reason::FR-EXEC-3 completed: the terminal reason is 'completed', with the operation and turn facts under it`; `fake-host/terminal-reason::FR-EXEC-3 failed: …`; `fake-host/terminal-reason::FR-EXEC-3 cancelled: …`; `fake-host/terminal-reason::FR-EXEC-3 uncertain: …`; `fake-host/terminal-reason::FR-EXEC-3 host-rejected: …`; `fake-host/terminal-reason::FR-EXEC-3 the set of terminal reasons is closed, and no two paths share a reason`; `isolated-host/turns::a real turn runs to an authoritative end, and the model reply arrives in the event log` | A table drives each of the five paths against a real fake Host and a real daemon child, and each row can fail under a deliberate defect (four controls, none survived). **Fixed this round (terminal state):** the reason handed to a caller was the fixed sentence `authoritative turn/end at seq N` for `completed`, `failed` AND `cancelled`, and `session.wait` answered `turn-ended` for all three, so no public IPC or MCP surface could distinguish a failed turn from a completed one. The terminal state now leads the reason (`<state>: authoritative turn/end at seq N`), a dedicated `lastTerminalState` is exposed on `session.state.execution` and as `terminalState` on `session.wait`, and the case asserts the state prefix, both structured surfaces and their mutual distinctness across all five states — rather than pinning the old strings as if they were correct. **Known gap:** `session.wait`'s closed-set `reason` field (`turn-ended`) is deliberately unchanged, so a caller must read `terminalState` to tell the three apart; and a turn that ends without an `authoritative turn/end` still reports `uncertain` rather than a state. |
| FR-EXEC-4 | P1 | measured | `mcp-e2e/stdio::uncertain outcomes are reported as errors so a caller cannot mistake them for success`; `fake-host/contract::dropped ack after send becomes uncertain…`; mutation `ack-loss-reported-as-success` (production, caught) | The negative control is the proof: mapping an unprovable outcome to success turns the suite red. |
| FR-EXEC-5 | P1 | partial | `test/live/live-route.mjs` derives the route from the operator's own settings and names the credential only by environment variable; `live/live::a real model turn completes through the bridge and its reply is in the durable log` (prints provider id, model id and credential variable **name**; no endpoint or value is committed anywhere); `live/live::three real sessions recall only their own planted fact` | A real, operator-configured route is exercised, and a missing route is reported as a SKIP with the precise cause (`resolveLiveRoute` returns `{ok:false, reason}`). **Not covered:** an *unroutable* route is not asserted to produce a typed error — the layer skips instead — and `HOST_UNREACHABLE` is not asserted by any test. |
| FR-EXEC-6 | P2 | partial | `fake-host/contract::execution state is not derived from connection state`; `fake-host/contract::a stale or foreign terminal event does not end the current turn` | Execution state is computed per session from that session's own `turn/start`/`turn/end`, and nothing derives it from a host-level aggregate. **Not covered:** the planned negative control (a fixture reporting a misleading `attachedSessions` while our session is idle) does not exist — the fixture reports its real count. |

### 3.4 Approvals and cancellation (`FR-APPR`, `FR-CANCEL`)

| Req | Pri | Status | Test id(s) | Evidence, and what is not covered |
| --- | --- | --- | --- | --- |
| FR-APPR-1 | P0 | partial | `fake-host/contract::prompt text that demands approval authorizes nothing`; `fake-host/contract::an approval decision requires the operator token and cannot be replayed`; `security/bounds::an unauthenticated caller cannot decide an approval, even with a well-formed request`; `mcp-e2e/stdio::handshake, tools/list and a real initialize round trip over stdio` (no tool name matches the pattern `approve`, `decide` or `allow`); mutation `approval-authority-not-checked` (production, caught) | Nothing answers an approval without the operator token, and no tool can. **Not covered:** the timeout and reconnect paths specifically — "not on timeout, not on reconnect" is structural (no code path decides without the token) rather than separately asserted. |
| FR-APPR-2 | P0 | measured | `fake-host/approval-binding::FR-APPR-2 wrong turn: an answer naming a different turn is refused, and naming its own turn is accepted`; `fake-host/approval-binding::FR-APPR-2 wrong task: a token valid for task A cannot decide task B's interaction, and nothing is delivered`; `fake-host/approval-binding::FR-APPR-2 wrong interaction: a decision naming another interaction is refused, and a sibling stays pending`; `fake-host/approval-binding::FR-APPR-2 replay: a second decision is refused as stale and the receipt is never sent twice`; `fake-host/approval-binding::FR-APPR-2 stale: an interaction past its expires_at is terminal (expired), never allowed-once`; `fake-host/approval-binding::FR-APPR-1/FR-APPR-2 timeout and reconnect never auto-approve, and nothing is delivered for an undecided interaction`; `fake-host/approval-binding::FR-APPR-2 control: a correct answer is accepted, carried to the Host, and durably recorded`; `security/bounds::an unauthenticated caller cannot decide an approval, even with a well-formed request` | Task, turn, interaction and `approvalId` binding are all asserted, and the answer is now genuinely CARRIED to the Host — the delivery did not exist before this round, and the control case asserts the delivered payload's `sessionId`, `approvalId` and `outcome` against the Host's own receipt log. **Fixed this round:** the answer used to be recorded locally and never sent (`DshHostAdapter.respond` had zero callers), there was no turn binding, `shapeInteraction` did not expose `turnId`, and the answer carried the bridge's internal session id instead of the Host's. **Fixed this round (replay):** a replayed decision is now a THROWN typed error, `ERROR_CODES.APPROVAL_REPLAYED`, carrying `details.deliveredToHost` — the delivery state read from the durable record — instead of a success-shaped `receipt: 'duplicate'`. Returning a success for a replay told the caller an approval had been answered when the only thing that had happened was that it had already been decided. **Known gap:** the caller is still not required to echo the Host `rpcId` (the bridge derives it from the interaction), so a caller cannot observe that binding. |
| FR-APPR-3 | P0 | measured | `fake-host/approval-binding::FR-APPR-3 not-pending: the carrier receipt is surfaced, and the interaction is host-resolved rather than answered`; `fake-host/approval-delivery::FR-APPR-3: the adapter closes the receipt set, so a bad-response is never reported as not-pending`; `fake-host/approval-delivery::FR-APPR-3: a crash while the answer is in flight is reported as unproven, and the answer is never sent twice`; `fake-host/approval-delivery::FR-APPR-3: an unreachable host records a provable refusal, which is a different state from dispatching`; `fake-host/approval-binding::FR-APPR-1/FR-APPR-2 timeout and reconnect never auto-approve, and nothing is delivered for an undecided interaction` (the lost-receipt half) | The fixture answers `{accepted:false, reason:'not-pending'}` for an `rpcId` it is not holding, and the bridge surfaces that receipt verbatim, reports `delivered:false`, and lands the interaction on `answer-not-pending` — a state that records BOTH facts (the operator answered AND the Host had nothing to apply it to). It is never `answered`. The store needed a dedicated transition for this, because `decideInteraction`'s compare-and-set only moves a row out of `pending` and the answer had already moved it — measured, not assumed. **Fixed this round (closed set):** the classifier read `typeof receiptField === 'string' ? receiptField : 'accepted'` and special-cased only `not-pending`, so every other string — `bad-response`, a future reason, a typo, any arbitrary text — was recorded as an acceptance with `delivered: true`; and the adapter collapsed `accepted:false` into `not-pending` whatever the reason, reporting "the Host has no pending request for this rpc id" for a malformed answer. Both are now closed sets with a typed case per member and an explicit unrecognised outcome. **Fixed this round (crash window):** the intent to deliver is now written durably as `dispatching` BEFORE the request, so a process killed between sending and recording leaves evidence: `delivery.state` distinguishes no row (never attempted), `dispatching`/`uncertain` (may have reached the Host), `refused` (provably not sent) and `accepted`. `interaction.list` and `session.state` expose it, so "decided" is no longer readable as "delivered". A negative control removing the `dispatching` write makes the crash case fail with `delivery: null` — the exact "never sent" misreading.
**Fixed in the review-0610 round (the replay hint):** the `APPROVAL_REPLAYED` detail's `hint` was generated from the mere EXISTENCE of a delivery row — `previousDelivery ? 'the decision was already delivered to the Host; re-deciding is a no-op' : …` — so an answer recorded as `dispatching`, `uncertain`, `refused`, `bad-response`, `unclassified` or `unrecognised` was all described to an operator as delivered. For `refused` that is actively harmful: it suppresses the retry that fixes the situation. The hint is now a total table over the closed set (plus "no row", which means never attempted), a `deliveryState` field names the same value as what it is rather than a null-ness, and an unlisted state falls back to the explicit "unproven" entry — never to the delivered wording. Asserted as `fake-host/approval-delivery::FR-APPR-3: a crash while the answer is in flight…` (dispatching must not claim delivery) and `…an unreachable host records a provable refusal…` (a refusal must point at delivering again), with the accepted case kept as the positive control that the delivered wording still exists where it is true. A negative control restoring the old existence-based hint fails exactly those two, and not the positive control — the wording assertion was loosened to the CLAIM after the first control run showed it firing on a copy difference. |
| FR-APPR-4 | P0 | measured | `fake-host/respond-bounds::FR-APPR-4 a silently held response ends as an unproven receipt after the deadline, and the answer is never sent twice`; `fake-host/respond-bounds::FR-APPR-4 an oversized receipt body is refused while it is read, and the daemon still answers everything else`; `fake-host/respond-bounds::FR-APPR-4 a receipt that cannot be parsed is reported as unproven, exactly like one that could not be read`; `fake-host/respond-bounds::FR-APPR-4 a failure before any byte is written is still a provable refusal, and is distinguishable from the unproven case`; `fake-host/respond-bounds::FR-APPR-4 the deadline is per attempt: three held responses in a row each end on their own bound with no timer left behind`; `fake-host/contract::prompt text that demands approval authorizes nothing` (a prompt instructing the bridge to approve; the interaction stays `pending` and `respondReceipts` stays 0) | Text in the conversation is not human intent. Scope: the adversarial text is injected as prompt text; document-content and event-payload text are not separately injected. **Review-0945 round:** `fake-host/response-bytes` holds both unary paths to the byte claim — the cap was compared against `text.length` after `setEncoding('utf8')`, i.e. against UTF-16 code units, so a body of 3-byte characters could be three times the promised cap before anything refused it, and the truncation case (a peer that flushes part of a body and only then dies) hung until the deadline because the reader listened for failure on the request only. |
| FR-APPR-5 | P1 | partial | `fake-host/contract::an approval decision requires the operator token and cannot be replayed` | `allowed-once` plus the stale/duplicate refusals are measured. **Not covered:** no test drives an interaction to `rejected` or `expired`, so those are not shown to be distinguishable from accepted-by-human. |
| FR-APPR-6 | P2 | unverified | Durable rows exist (an `interactions` table with `decision`, `reason`, `decided_at` and the correlation id, plus an `audit` table; an unauthorised decision writes `approval-unauthorized`). | **Not covered:** no test inspects an interaction history for who answered, when, on which correlation id, with what outcome. |
| FR-CANCEL-1 | P0 | measured | `fake-host/contract::FR-CANCEL-1: cancelling the turn stops it and leaves the queued items reported as remaining`; `fake-host/contract::FR-CANCEL-1: a removal bound to the observed snapshot makes the item disappear from it`; `fake-host/contract::FR-CANCEL-1: a removal is bound to the current session and leaves a sibling session alone`; `fake-host/contract::FR-CANCEL-1: a repeated removal is refused locally from the durable ledger, never sent twice and never reported as a success`; `fake-host/queue-removal-once::two concurrent callers naming one item produce at most one removal request on the wire`; `fake-host/queue-removal-once::a confirmed removal is not re-sent after a daemon restart, and the ledger survives the restart`; `fake-host/queue-removal-once::an outcome that was never proven blocks a retry, and a fresh queue snapshot without the item resolves it`; `fake-host/queue-removal-once::with the observed snapshot still listing a settled item, the ledger alone refuses the second send`; `persistence/removal-crash-window::FR-CANCEL-1 crash: the Host applied the removal and the process died before the ledger was written, so the item is never removed twice`; `persistence/removal-crash-window::FR-CANCEL-1 crash: an ack persisted but never written to the ledger settles as removed, and is refused without a send`; `persistence/removal-crash-window::FR-CANCEL-1: a removal that provably never left the process stays retryable across a restart`; `persistence/removal-crash-window::FR-CANCEL-1: the reconciler reads the response the REAL successful path persists, so a confirmed removal is never downgraded`; `fake-host/contract::FR-CANCEL-1: an item id that was never observed is refused without being sent upstream`; `isolated-host/turns::cancel is reported as a turn-level ack with no subprocess evidence, never as proof` | The two scopes are separate operations with separate reports: turn cancellation leaves the queue intact and says so, and removal is performed with the Host's own `session.updateQueue` (`action: {kind:'remove'}`), addressed to the session and the item id read from the last observed `session/queue` snapshot. The capability is real, verified from the installed Host `0.1.1-rc.2`'s own declarations rather than assumed. **Fixed this round (double-send):** the observed-item snapshot, the binding check and the ledger read all ran OUTSIDE the per-session serialization boundary, and a fresh `randomUUID` delivery intent was minted inside it, so two parallel clears of one item could both become sendable and both be sent; a success or an `uncertain` outcome also did not consume the item. The snapshot and the persistent removal state are now read inside `#serialize`, and a durable `queue_removals` ledger is the sole defence: a confirmed removal is `removed`, an unproven one is `uncertain` and blocks a blind re-send until the item's absence is observed in a fresh snapshot, and a Host `queue-item-not-found` settles as `not-pending`. A pre-send refusal records nothing, so a legitimate retry stays possible.
**Fixed in the review-0610 round (the send-in-flight crash):** the ledger row was still written only AFTER `#dispatch` returned, and every attempt minted a fresh `randomUUID`, so the ledger was the ONLY memory an attempt could have. A process killed between the Host applying a `remove` and that write left NO ledger row — and since a `session/queue` snapshot is re-broadcast on the Host's schedule, the item could still be listed and observed after a restart, making the same occurrence removable a second time. The bridge must not rely on the Host to refuse the duplicate: it is the Host that would have applied it. `#dispatch` already persists the attempt as `pending` and then `dispatching` BEFORE writing any byte, so `recover()` now reconciles every `session.updateQueue` remove attempt that has no ledger row against that operation's durable state: `pending`/`refused` prove nothing was applied and stay RETRYABLE, while `succeeded` (reading the persisted `{accepted:true}`) settles `removed` and `uncertain`/`dispatching` settle `uncertain`, which blocks a blind re-send. A negative control that removes the reconciliation call makes the crash case report `got 2` removals at the Host — the duplicate, reproduced, and the primary assertion is now the Host's own request count so the control fails on the defect rather than on our bookkeeping. **Known gap:** the `uncertain` resolution still depends on observing the item's absence in a fresh snapshot; if the Host never emits another `session/queue` frame for that session the row stays `uncertain` rather than being resolved by a poll, and there is no test for a Host that answers with a *different* non-confirming `ok` envelope twice in a row. |
| FR-CANCEL-2 | P0 | measured | `fake-host/contract::cancel is turn-scoped…` (`processEvidence.observed === false`); `isolated-host/turns::cancel is reported as a turn-level ack…` (observed false, with the reason naming the missing Host receipt); mutation `cancel-ack-claims-subprocess-stop` (production, caught) | The requirement is a prohibition and it holds: no path reports a subprocess as stopped on the strength of a turn-level ack. The positive half — observing a real child-process stop with pid/exit evidence — is not implemented and is blocked on an observable the contract does not have (§8). |
| FR-CANCEL-3 | P1 | unverified | `src/lib/daemon.ts` returns `{operation, reused: true}` for a repeated cancel idempotency key, which is the mechanism the requirement asks for. | **No test calls cancel twice** and asserts one effect, a stable journal and a typed outcome. |
| FR-CANCEL-4 | P1 | partial | The daemon builds the `uncertain` note ("cancel outcome unproven: the turn may or may not have stopped") when the dispatch result is unproven; the dropped-ack path itself is measured for `session.prompt` in `fake-host/contract::dropped ack after send becomes uncertain…` | The code path exists. **Not covered:** no test drops the carrier around a cancel, so "cancel during a disconnect is never a false success" is not asserted for cancel specifically. |
| FR-CANCEL-5 | P2 | unverified | Cancels are serialized per session and hold the next local dispatch while the turn is checked (`src/lib/daemon.ts`), which is the mechanism a race would be resolved by. | **No seeded cancel-versus-completion race test exists**, so the resolution is not shown to be deterministic. |

### 3.5 MCP face, compatibility and security (`FR-MCP`, `FR-SEC`)

| Req | Pri | Status | Test id(s) | Evidence, and what is not covered |
| --- | --- | --- | --- | --- |
| FR-MCP-1 | P0 | measured | `mcp-e2e/stdio::handshake, tools/list and a real initialize round trip over stdio` (spawns `dist/bin/dsh-pilot-mcp.js` and speaks JSON-RPC 2.0 over real pipes; all 11 tools are checked for an object schema with `additionalProperties: false`); `mcp-e2e/stdio::a full session lifecycle driven only through MCP tools` | A real client process spawns the real entry point; no in-process shortcut anywhere in the layer. |
| FR-MCP-2 | P0 | measured | `mcp-e2e/stdio::invalid arguments are a JSON-RPC invalid-params error, and nothing is sent upstream` (missing field, unknown property, wrong type, out-of-range value → `-32602`; unknown tool → `-32601`; the fake Host's mutation counter is unchanged); mutation `mcp-unknown-arguments-accepted` (production) | Strict schemas, machine-readable errors, and a refused call demonstrably not reaching the Host. |
| FR-MCP-3 | P0 | measured | `unit/core::capability negotiation reports unverified methods instead of assuming them`; `fake-host/contract::unsupported methods are reported as unsupported, never faked`; `isolated-host/host::the unverified method set is reported, and a method outside it is refused not faked` (a method absent from this Host never answers `ok:true`); `mcp-e2e/stdio::invalid arguments…` (`-32601` for an unknown tool) | An unsupported capability is reported, never simulated. |
| FR-MCP-4 | P1 | partial | `unit/core::capability negotiation reports unverified methods instead of assuming them` (the pinned inventory is unique and complete, which is the drift tripwire's basis); `isolated-host/host::the bridge attaches to a real Host and reaches ready without a protocol error` (`protocolErrors === 0`, declared and unverified counts printed) | The pin exists in code and is probed against the real Host. **Not covered:** there is no checked-in generated inventory of the resolved dependency tree, no artifact-hash assertion, and no test that fails on an add/remove/rename of the method map — the compatibility gate described in [`host-compatibility.md`](host-compatibility.md) §2.2 is a procedure, not yet an oracle. |
| FR-MCP-5 | P1 | partial | `mcp-e2e/stdio::the gateway fails closed and stays silent on stdout when the daemon is absent` (diagnostic on stderr, no stdout noise); `unit/core::the daemon refuses to start when the state directory is already owned` (exit 4, `OWNER_HELD`); `src/bin/dsh-pilot-daemon.ts` guards a real-state-dir target and exits 3 | Two startup failures fail closed. **Not covered:** an unwritable state directory (`EACCES`) is not exercised, and an unreachable Host is deliberately **not** a startup failure — the daemon runs with `connection != ready`, so "host reachability fails closed" is not a property of this build. |
| FR-MCP-6 | P2 | partial | `mcp-e2e/stdio::cancelling a wait does not cancel the turn, and the server keeps serving` (a `notifications/cancelled` is sent for a wait request; the turn is still `running` afterwards; the gateway keeps serving with `rejectedToolCalls === 0`) | Cancelling a caller's wait is not cancelling work, and the server stays healthy. **Not covered:** an in-flight wait is not interrupted early — the gateway records the cancelled id and answers `-32800` only when a request carrying that id arrives — and no progress notifications are emitted. |
| FR-SEC-1 | P0 | measured | `fake-host/contract::concurrent sessions: 8 sessions run 3 rounds each with per-session isolation`; `property/model::generated event streams: stored sequences and gap conclusions match an independent model` (every stored event's `sessionId` must be the session asked for); `isolated-host/turns::two sessions on one real Host stay isolated…`; `live/live::three real sessions recall only their own planted fact`; `live/live::sessions run in parallel at widths 2, 4 and 8 without cross-contamination` | No marker or event crosses a session boundary, on the fixture, on a real Host, and against a real model. |
| FR-SEC-2 | P0 | partial | `security/bounds::IPC is a local socket with 0600 permissions, not a network listener`; `security/bounds::the daemon refuses to bind anything on a TCP port` (`lsof -a -iTCP -sTCP:LISTEN` for the daemon's pid finds no listener); `isolated-host/host::an isolated Host boots on an OS-assigned port, in its own home, and answers host.describe` (the home is inside the test's scratch dir; never `:3080`) | The daemon exposes exactly one endpoint, the socket file, and the real Host is never the operator's. **Not covered:** there is no audit of the write paths recorded by the whole suite against the allowed roots, and the `~/.dsh` / `~/.local/state` refusal (`src/lib/config.ts`) is a startup guard with no test asserting a refused attempt. |
| FR-SEC-3 | P0 | measured | `security/redaction-boundary::the sentinel is absent from a flat string, a log line and a tool-input payload`; `security/redaction-boundary::the sentinel is absent from a deeply nested object, an array element and an error-detail bag`; `security/redaction-boundary::the sentinel is absent when it is planted in an object KEY, and the sibling fields survive`; `security/redaction-boundary::the fields a replay reads are byte-identical before and after the boundary`; `security/redaction-boundary::with redaction disabled the sentinel is still present, so a real failure would be observable`; `security/redaction-boundary::redaction is deterministic and idempotent`; `security/redaction-boundary::a cyclic payload and a very deep payload terminate at the bound, and the bound is visible`; `security/redaction-boundary::LIMIT: a credential form outside the policy is NOT recognised, and this case states the limit`; `security/secret-leakage::the upstream event archive holds the NORMALISED payload, keeps every replay-critical field, and the secret is gone`; `security/secret-leakage::a secret in a host error never reaches a caller, a log, or durable state`; `security/secret-leakage::a secret in an approval reason never reaches durable state or a caller`; `security/secret-leakage::the bridge never reads a provider credential value, only the variable name`; `security/bounds::state directory contents contain no credential values, only references`; `persistence/crash::state directory permissions: the authority token is private to the operator account` | A runtime-assembled synthetic sentinel is planted in a flat string, a log line, tool input, nested error details, a deep structure, an array element AND an object key, and traced through the boundary: the failing direction is asserted (the sentinel is gone from the archive and from every authored surface) and the surviving direction too (ids, `seq`, `type`, `turn`, ordering, array length and non-string values are unchanged). **Fixed this round (C-1):** the archive previously kept the peer's payload byte-for-byte and the exposure was asserted positively as a documented conflict. One boundary now runs at ingress and its output feeds BOTH the durable archive and the live state reduction, so the live path and a post-crash replay of the archive cannot diverge — the property the old objection was actually about. See `docs/conflicts.md` C-1 and ADR 0003. **Explicit LIMIT, asserted as a test:** the boundary recognises credential-shaped material by pattern and key name, so an unrecognised form is NOT redacted (a 40-character hex blob is asserted to pass through), and the `Basic` header shape has a recorded false positive. No claim is made that every credential form is recognised. |
| FR-SEC-4 | P1 | measured | `security/token-path::FR-SEC-4 a symlink at the authority token path is refused, and the file it points at is neither chmodded nor read`; `security/token-path::FR-SEC-4 a DANGLING symlink is refused instead of being followed to create the token outside the state directory`; `security/token-path::FR-SEC-4 a real token is still created with mode 0600, still readable, and still re-readable idempotently`; `security/token-path::FR-SEC-4 a non-regular file at the token path is refused by both operations, and never read` | **Fixed in the review-0710 round (the authority-token path):** every operation on `<state>/authority.token` used a path-following call — `existsSync` then `chmodSync`, `writeFileSync` when absent, `readFileSync` to read — so a symlink planted at that path redirected all three outside the 0700 state directory that is the actual access control. Measured against the pre-fix code with a real link in this task's own temp directory: a RESOLVING link made it chmod a file it does not own (0644 → 0600, contents unchanged), and a DANGLING link made it create the approval secret at the link's target, outside the state directory. The path is now `lstat`ed and a non-regular file is refused with the typed `UNSAFE_STATE_PATH` rather than followed; creation uses `O_CREAT|O_EXCL|O_NOFOLLOW` so a dangling link can never be written through; the mode is set with `fchmod` on an open descriptor taken with `O_NOFOLLOW`; and `fstat` on that descriptor confirms it is a regular file, which a path check cannot do against a later rename. **The `cwd`/workspace half is now built too** — see section 12: a `cwd` is resolved to the directory it names, that directory is what is recorded and sent, and the recorded directory is re-verified before every dispatch, with `security/workspace-cwd` asserting both the refusal and that no prompt reached the Host. |
| FR-SEC-5 | P1 | partial | `security/bounds::an event page is bounded by the configured maximum…`; `security/bounds::an oversized event frame is refused as oversize rather than buffered`; `security/bounds::host error details are bounded before they reach a caller`; `security/bounds::a hostile IPC line is refused without taking the daemon down` (a > 4 MiB line closes the connection and the daemon keeps serving); `network/ws-bounds::FR-SEC-2 fragments: a message assembled from individually legal fragments is refused when the TOTAL exceeds the message budget`; `network/ws-bounds::FR-SEC-2 backpressure: a fast peer and a slow consumer are stopped by the queue budget, and the delivered set stays bounded`; `network/ws-bounds::FR-SEC-2 isolation: a refusal tears down only its own connection, and a disconnect releases the buffers it was holding`; `network/ws-bounds::FR-SEC-2 fragments: an interleaved data frame, a reserved opcode and a binary frame are each a typed protocol error, and the connection still ends every time`; mutation `host-error-text-unbounded` (production) | Each declared bound is enforced at a real boundary. **Fixed in the review-0710 round:** the WebSocket client bounded a FRAME and nothing else, in two ways that were both reachable with frames that are each individually legal — a fragmented message is assembled across frames, so `Buffer.concat` could be handed an unbounded total, and the parsed-but-unconsumed queue had no byte budget at all, so a fast peer and a slow reader grew it without limit. `maxMessageBytes` (checked against the declared length BEFORE the payload is buffered, so the peer cannot make this process hold the bytes) and `maxQueueBytes` now bound them, both configured rather than fixed in the client, and a frame that is ILLEGAL rather than large — a continuation that starts no message, a data frame inside an open fragmented message, a reserved opcode, a binary frame on a text-only downlink — is a typed protocol error that ends the connection instead of being skipped, because skipping it would drop data while the stream still reported itself complete. Negative controls: removing the two byte budgets fails the message and backpressure cases (the first with `messagesDelivered: 1`, i.e. the 16 KiB message assembled and delivered); removing the legality checks fails three, one of them with bytes held permanently. **Not covered:** no long randomized run asserts memory or per-session retention growth, or counters agreeing with observed growth. |
| FR-SEC-6 | P2 | partial | The prohibition is written down ([`architecture.md`](architecture.md) §7 and §12, ADR 0002), and the security layer's own header states it exercises no network reachability because the Host's trust fence is not an auth layer. | The non-claim is explicit. **Not covered:** the planned test asserting that an untrusted-directory case is *reported* rather than blocked does not exist. |

### 3.6 Evidence, CI and reproducibility (`FR-EV2`)

| Req | Pri | Status | Test id(s) | Evidence, and what is not covered |
| --- | --- | --- | --- | --- |
| FR-EV2-1 | P0 | partial | This document is the audit: every row above carries a status, and §7 carries the commands and counts. | **Not covered:** nothing fails the build when a requirement loses its test; the mapping is maintained by hand, so a missing row is a documentation bug rather than a red test. |
| FR-EV2-2 | P0 | measured | `property/model::generated event streams: stored sequences and gap conclusions match an independent model`; `property/model::idempotency keys under repeated submission produce exactly one durable operation`; `property/model::cursor conclusions are stable no matter how many times the same stream is replayed` — all three print `[seeded property] seed=<n> rounds=<n> (replay with DSH_PILOT_SEED=<n>)` at the **start** of every run, not only on failure, and read the seed back from `DSH_PILOT_SEED` (`test/property/model.test.mjs`); the PRNG is `mulberry32`, so one seed replays identically on any platform, and each failure message repeats the seed and round | A failure that cannot be replayed is impossible by construction. |
| FR-EV2-3 | P0 | partial | `.github/workflows/ci.yml` runs the deterministic layers plus the negative controls on `ubuntu-latest` and `macos-latest`, installs dev tooling with `npm ci`, asserts zero runtime dependencies, builds the sources and runs the `typecheck` / `typecheck:contract` / `typecheck:tests` configs, prints `passed/failed/skipped/timedOut` as separate numbers, and appends a per-layer table to the job summary. | The workflow exists and is written to do this. **Not covered:** no run of that workflow has been observed or recorded, so nothing here claims a two-platform result. What *is* measured is one macOS run of the same command (§7). |
| FR-EV2-4 | P0 | partial | The workflow declares `permissions: contents: read`, references no secret, and has no job that can reach the live layer; the live suite is local and opt-in only. | **Not covered:** no fork-context run is recorded; this is workflow inspection. |
| FR-EV2-5 | P1 | partial | `DSH_PILOT_JSON=<path> node test/run.mjs` writes a report containing `counts`, per-layer counts, `layerNotes`, `liveSuite` and every test id with its status and duration (this run's report: `.local/evidence-default-run.json`); CI consumes and uploads it. | Per-test ids and statuses are machine-readable. **Not covered:** no artifact is committed, and the JSON has no per-test seed field. |
| FR-EV2-6 | P1 | partial | §6 of this document names the critical modules and the measured test id for each behaviour. No percentage is reported anywhere. | **Not covered:** no coverage tool is wired in, and no artifact carries the module→test mapping. |
| FR-EV2-7 | P2 | partial | `test/soak/run.mjs` is resumable, records wall clock *and* monotonic segments *and* the gaps between them, records checkpoint failures rather than retrying them, refuses to start without a bound, and reports `meetsMultiDayMilestone` only when 48 h of monotonic coverage has no unexplained gap; CI runs a bounded smoke (`--smoke --minutes 1`). | The runner exists and its short mode is exercised. **Blocked part:** the 48-hour milestone needs real elapsed time that has not been spent, so no multi-day figure is claimed anywhere in this repository — 48 h of monotonic coverage is a later milestone, not a result. |

---

## 4. Negative controls

A green suite proves nothing on its own; it may simply be unable to fail. `test/mutation/run.mjs`
copies the tree to a scratch root, applies exactly **one** defect, and requires the target suite to
go RED. It never mutates the working tree, and it verifies that each mutation applied (a stale
anchor is an error, not a silent no-op).

| Control | Kind | Mutates | Must break |
| --- | --- | --- | --- |
| `durable-intent-after-send` | production | `src/lib/daemon.ts` | `test/persistence` (the `dispatching` row no longer precedes the send) |
| `ack-loss-reported-as-success` | production | `src/lib/daemon.ts` | `test/fake-host` (an unprovable outcome recorded as success) |
| `duplicate-rows-written` | production | `src/lib/store.ts` | `test/unit` (`store dedupe`) |
| `stale-terminal-event-closes-turn` | production | `src/lib/daemon.ts` | `test/fake-host` (any terminal event closes the turn) |
| `approval-authority-not-checked` | production | `src/lib/daemon.ts` | `test/security` (a decision without the operator token) |
| `gap-smoothed-over` | production | `src/lib/daemon.ts` | `test/property` (a holed stream reported as complete) |
| `session-create-id-not-reused-on-retry` | production | `src/lib/daemon.ts` | `test/fake-host` (one logical session becomes two Host sessions) |
| `second-owner-not-refused` | production | `src/lib/owner-lock.ts` | `test/unit` (a refused handle treated as acquired) |
| `host-error-text-unbounded` | production | `src/lib/adapter.ts` | `test/security` (a peer's size becomes our size) |
| `cancel-ack-claims-subprocess-stop` | production | `src/lib/daemon.ts` | `test/fake-host` (ack reported as process evidence) |
| `mcp-unknown-arguments-accepted` | production | `src/lib/mcp-tools.ts` | `test/mcp-e2e` (a typo silently ignored) |
| `fake-host-ignores-preallocated-session-id` | **fixture** | `test/fixtures/fake-host.mjs` | `test/fake-host` |

Measured on this machine (`node test/mutation/run.mjs`, re-run during this documentation pass;
machine-readable report at `.local/evidence-mutations.json`):

```
mutations=12 caught=12 survived=0 invalid=0
  production: 11/11 caught — production code in lib/ (evidences this bridge)
  fixture:    1/1  caught — fixture fidelity (evidences the FAKE HOST, not this bridge)
  required obligations: 11/11 have a caught negative control
```

Two of those catches are the reason the hang and timeout rules exist rather than being theory:

- `second-owner-not-refused` was caught **by a HANG** — `test/unit` never finished inside the
  runner's 300 s ceiling, because a refusal path that no longer refuses blocks its caller instead
  of failing it. Counting non-termination as detection is what stopped a real defect from being
  reported as a surviving control.
- `stale-terminal-event-closes-turn` was caught by three **timeouts** in `test/fake-host` (all
  sessions idle; turn closed by an authoritative event; wait returns a closed-set reason), which is
  the same class of observation.

Rules this runner follows and reports:

- **`kind` decides what a caught control proves.** A `production` control mutates `src/`, so it
  evidences *this bridge*. A `fixture` control mutates our own fake Host, so it evidences *fixture
  fidelity* only — the summary splits the two counts on purpose, because collapsing them would
  overstate what has been demonstrated.
- **`survived`** — the target suite stayed green with the defect applied — is a failure of the
  runner, and the exit code is non-zero.
- **`invalid`** — the mutation left the file unparseable (`node --check` fails), or the target run
  produced no tests at all — is reported separately from `survived`, because a build broken before
  the first assertion is not evidence about a missing control.
- **A mutation that makes the suite HANG is counted as caught.** Non-termination is an observable
  defect: a refusal path that no longer refuses blocks its caller instead of failing it.
- The summary ends with an **obligation table** — `owner-exclusion`, `output-bounds`,
  `cancel-local-only`, `uncertainty-not-success`, `durable-intent-before-send`,
  `turn-boundary-authority`, `approval-authority`, `event-identity`, `stream-completeness`,
  `session-identity`, `tool-schema-strictness` — and names any obligation with no caught control,
  rather than letting "N of M caught" be read as "every required control exists". An obligation is
  marked covered only by a **caught** control whose declared `protects` text names it, never by a
  test's name.

---

## 5. Supported and unsupported capabilities

### 5.1 Supported, with the evidence that says so

| Capability | Evidence |
| --- | --- |
| Real MCP server over stdio, 11 tools, strict schemas | `mcp-e2e/stdio::handshake…`, `mcp-e2e/stdio::invalid arguments…` |
| Durable single-owner daemon behind N thin gateways over a local socket | `security/bounds::IPC is a local socket with 0600 permissions…`, `unit/core::IPC framing…` |
| Kernel-enforced single ownership; dead-owner reclaim with no manual cleanup | `test/unit/owner-lock.test.mjs` (7 cases), `test/persistence/crash.test.mjs` (`SIGSTOP`, `SIGKILL`) |
| Durable-before-send intents; `uncertain` as a first-class, inspectable state; no auto-retry | `unit/core::durable-before-send…`, `fake-host/contract::dropped ack…`, `persistence/crash::SIGKILL during dispatch…` |
| Restart recovery with a reported sweep (`health.recovery`) and per-operation inspection (`ops.get`) | `persistence/crash::SIGKILL during dispatch…`, `live/live::a SIGKILL during a live turn…` |
| Event ingest with native-sequence dedupe, explicit completeness and gap ranges; bounded pages | `property/model::*` (3 cases), `fake-host/contract::a silent frame gap…`, `security/bounds::an event page is bounded…` |
| Bounded waits with a closed-set reason; waiting is not cancelling | `fake-host/contract::wait returns a closed-set reason…`, `mcp-e2e/stdio::cancelling a wait…` |
| Turn cancellation with an honest "no subprocess evidence" report | `fake-host/contract::cancel is turn-scoped…`, `isolated-host/turns::cancel is reported as a turn-level ack…` |
| Approval listing, operator-only decision with stale/duplicate refusal, and no model-reachable approval tool | `fake-host/contract::an approval decision requires the operator token…`, `security/bounds::an unauthenticated caller cannot decide an approval…` |
| Capability negotiation against a real Host without protocol errors | `isolated-host/host::the bridge attaches to a real Host and reaches ready without a protocol error` |
| Real turns end-to-end against a real Host with a deterministic loopback mock provider | `isolated-host/turns::*` (6 cases), `test/fixtures/mock-provider.mjs` |
| Real turns against the operator's real route, with a budget the layer cannot exceed | `live/live::*` (5 cases), `LIVE_BUDGET` + `sharedBudget` |
| TypeScript sources under `src/` compiled by `tsc` to `dist/`, which is what every layer runs; protocol surface checked with the Node type surface removed | `npm run build`, `npm run typecheck:contract`, `npm run typecheck:tests` — 0 errors |

### 5.2 Not implemented (do not ask the bridge for these)

| Not implemented | What happens today |
| --- | --- |
| `session.export` (session-log ZIP) | Never called. The Host route exists; the bridge does not use it, because a session log is sensitive by definition and is never produced, committed or published. |
| MCP **resources** | The face is tools only: `initialize` advertises `capabilities: {tools: {listChanged: false}}` and `tools/list` returns the 11 tools. |
| A `streamable-http` MCP transport | stdio only. A listener would need its own ADR and a different trust story. |
| Host-side queue removal for items the daemon has never observed | `queue.clear` removes only the item ids it was given and only if it has seen them in a `session/queue` snapshot; an unobserved id is refused locally. |
| Positive process-level evidence that a subprocess stopped | `processEvidence.observed` is always `false`, with the reason. |
| Symlink / workspace-escape handling | `cwd` is recorded and replayed, not resolved or bounded. |
| Cursor retention floor / typed "cursor expired" by age | `CURSOR_EXPIRED` means a store-generation mismatch only. |
| Journal rotation or compaction | No rotation; a size cap is configured but not enforced by a tested mechanism. |
| 48-hour soak | A resumable runner and a bounded smoke run exist; the multi-day figure is a later milestone. |
| MCP progress notifications | Not emitted. |

### 5.3 Unsupported upstream at the measured pin

These are the Host's limits, not ours, and the bridge must report them rather than work around them.
Full detail and sources: [`host-compatibility.md`](host-compatibility.md) §5.4 (unsupported at this
pin) and §2.3 (measured drift between published versions).

| Unsupported upstream | Evidence |
| --- | --- |
| Cursor pagination on `session.list` | contract: "cursor is a reserved seat, unimplemented" |
| Mux `since` resume | contract: "unimplemented in v1 (ignored if passed)" — hence reconnect = reopen **and** refetch |
| Any client→host traffic on the WebSocket | contract: a protocol violation |
| Any authentication/authorization layer for `/api` | contract: the trust fence "is not an auth layer" |
| `command.execute` / `command.list` | absent from the method map at this pin (present in an older published tree); asserted not to answer `ok:true` in `isolated-host/host::the unverified method set is reported…` |
| A Host-observable stop receipt for tool subprocesses | no such method or frame in the contract |

---

## 6. Coverage statement

Coverage here means "a named test decides this behaviour", not a percentage of lines. A row is
satisfied by the test id in it, never by "line coverage of this file".

| Critical module | Behaviour that must be covered | Covered by | Gaps |
| --- | --- | --- | --- |
| Durable state (`src/lib/store.ts`) | write-before-send ordering, idempotency-key conflict, illegal transition refusal, version refusal, corruption, dedupe by native sequence | `unit/core::durable-before-send…`, `unit/core::idempotency key returns the same operation…`, `unit/core::illegal operation transitions are refused, not coerced`, `unit/core::a state file from a newer bridge is refused, not misread`, `unit/core::corrupt storage is reported with evidence preserved`, `property/model::idempotency keys under repeated submission…` | no `ENOSPC`/`EACCES`; no growth bound; no crash-interleaving model |
| Ownership (`src/lib/owner-lock.ts`) | exclusive mode read back from the holder, refusal of a cooperating and an uncooperative second writer, process-level refusal, inode stability, stale marker, `SIGSTOP`/`SIGKILL` | `test/unit/owner-lock.test.mjs` (7 cases), `test/persistence/crash.test.mjs` (`SIGSTOP`, two-daemon, lock probe) | no foreign-writer detection; no ownership-transition journal |
| Event ingest and cursors (`src/lib/daemon.ts`, `src/lib/store.ts`) | dedupe, gap detection and reporting, reconnect + refetch convergence, completeness verdict, bounded pages, oversize refusal | `property/model::*` (3 cases), `fake-host/contract::a silent frame gap…`, `fake-host/contract::disconnect then reconnect…`, `security/bounds::an event page is bounded…`, `security/bounds::an oversized event frame is refused as oversize…` | no retention floor; no real-Host reconnect |
| Approval / interaction binding (`src/lib/daemon.ts`, `src/lib/ipc.ts`) | authority token required, unauthenticated refusal, stale and duplicate refusal, no model-reachable decide path, adversarial text answers nothing | `fake-host/contract::an approval decision requires the operator token…`, `security/bounds::an unauthenticated caller cannot decide an approval…`, `fake-host/contract::prompt text that demands approval authorizes nothing` | no `not-pending` receipt assertion; no wrong-turn binding; no rejected/expired history |
| Cancellation scopes (`src/lib/daemon.ts`) | turn-scoped cancel, separate local queue scope, no fabricated subprocess evidence | `fake-host/contract::cancel is turn-scoped…`, `isolated-host/turns::cancel is reported as a turn-level ack…` | Host queue removal absent; no double-cancel test; no disconnect-during-cancel test |
| Host client carrier (`src/lib/adapter.ts`, `src/lib/ws-client.ts`) | envelope and rpcId echo, error-code mapping (including an unknown code), capability probe, detail bounds, `426` on plain GET, real WebSocket frames | `unit/core::capability negotiation…`, `unit/core::host error details are sanitised…`, `fake-host/contract::a plain GET on the event downlink is refused with 426…`, `fake-host/contract::an unknown host error code is surfaced as unknown…`, `security/bounds::host error details are bounded…` | no resolved-tree pin test; no `HOST_UNREACHABLE` assertion |
| MCP face (`src/lib/gateway.ts`, `src/lib/mcp-tools.ts`, `src/lib/mcp-protocol.ts`) | real stdio handshake, strict schemas, JSON-RPC error mapping, framing resilience, fail-closed startup, no approval tool | `test/mcp-e2e/stdio.test.mjs` (8 cases) | in-flight cancellation not honoured early; no progress notifications |
| Isolation of official-Host behaviour | real boot, `426` on both downlinks, a real turn to an authoritative end, a real tool effect on disk, a refused sandbox write carried through, a provider failure that is not a completion, two isolated sessions, an honest cancel | `test/isolated-host/*.test.mjs` (10 cases, opt-in) | turn-level cases are opt-in and therefore skipped in the default run |
| Live behaviour against a real route (`test/live/`) | one real turn; three sessions recalling only their own fact; parallel widths 2/4/8; `SIGKILL` in flight; budget adherence | `test/live/live.test.mjs` (5 cases, opt-in) | never in CI; only one recorded run |

---

## 7. Exact evidence

Every row below names **what was run, on which revision, on which platform, and when**. A number
without that provenance is not evidence, and this table is written so that no entry can be quoted
against a revision it was not measured on.

Versions on this machine: Node `v24.15.0`, `darwin/arm64`, SQLite `3.51.3` through `node:sqlite`,
`process.binding('fs').flock === undefined`, zero runtime dependencies.

| # | Command | Observed result | Revision | Platform | When (UTC) | Permission |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `node test/run.mjs` | `passed=107 failed=0 skipped=10 timedOut=0`; per layer: unit 24/0/0/0, property 3/0/0/0, fake-host 39/0/0/0, persistence 11/0/0/0, mcp-e2e 14/0/0/0, isolated-host 0/0/**10**/0, security 19/0/0/0; `live suite: SKIPPED (opt-in; not selected on this run)` | working tree on top of `9cd0f8a` (this round, uncommitted at the moment of the run) | `darwin/arm64` | 2026-09-12T18:5x | default sandbox |
| 2 | `npm run build` | 0 errors — `src/**/*.ts` → `dist/`, `strict` + `noImplicitAny` on; the artifact every layer above ran | same working tree | `darwin/arm64` | 2026-09-12T18:5x | default sandbox |
| 3 | `npm run typecheck:contract` | 0 errors — `src/lib/{errors,mcp-tools,mcp-protocol}.ts` with the Node type surface removed (`types: []`) | same working tree | `darwin/arm64` | 2026-09-12T18:5x | default sandbox |
| 4 | `npm run typecheck:tests` | 0 errors — `test/**/*.mjs` checked against the declarations emitted into `dist/` | same working tree | `darwin/arm64` | 2026-09-12T18:5x | default sandbox |
| 5 | `node test/mutation/run.mjs` | `mutations=12 caught=12 survived=0 invalid=0`; `production: 11/11 caught`, `fixture: 1/1 caught`, `required obligations: 11/11 have a caught negative control`; one control was caught by a hang, none survived, none was invalid | same working tree | `darwin/arm64` | 2026-09-12T18:5x | default sandbox |
| 6 | CI, hosted runners, commit `9cd0f8a` | all **three required checks SUCCESS**: `deterministic layers (ubuntu-latest)` 8m13s, `deterministic layers (macos-latest)` 8m11s, `package shape and secret hygiene` 7s; both layer jobs report `passed=64 failed=0 skipped=10 timedOut=0` and both **SKIP** the isolated layer | `9cd0f8a45e8f38f396150c61a3aee847c0cff5c5` (superseded by this round's commit — see the row below for the current one) | GitHub-hosted `ubuntu-latest` and `macos-latest` | 2026-09-12 | hosted runner |
| 7 | `node test/run.mjs test/isolated-host --isolated` | `passed=73 failed=1 skipped=0 timedOut=0` (three runs: 73/1, 73/1, 72/2) | **an older revision, NOT this one**: HEAD `66511d1`, i.e. the JavaScript-only source, before the TypeScript migration | `darwin/arm64` | earlier round | default sandbox |
| 8 | `node test/run.mjs test/live --live` | `5 passed, 0 failed`, 93 s of a 20-minute ceiling | **an older revision, NOT this one**: HEAD `66511d1` | `darwin/arm64` | earlier round | default sandbox |
| 9 | `node test/soak/run.mjs --minutes N` | bounded smoke only: 28 segments, 0 unexplained gaps | older revision | `darwin/arm64` | earlier round | default sandbox |

### 7.1 What rows 7–9 may and may not be used for

Rows 7–9 were measured on **`66511d1`, the pre-TypeScript JavaScript source**. The `src/` tree has
since been rewritten in TypeScript, the daemon and adapter have changed substantially, and this
round's own work changed delivery, turn binding, approval state and the queue-removal path. **Those
three results must not be extrapolated to the current revision, and no row in §3 cites them as
evidence for current behaviour.** They are recorded here because deleting them would hide that the
work was ever done, and because their *limits* are still informative:

- **Row 7 is not an all-green result and is not presented as one.** The single failure is the
  tool-effect oracle: it refuses with `SANDBOX_UNAVAILABLE` because `sandbox-exec: sandbox_apply:
  Operation not permitted` on this machine. That is a **real, reported refusal**, not a skipped test
  and not a timeout. It is recorded honestly as a failure. Under CI (both platforms) the whole
  isolated layer is skipped, so **no confined tool execution has been observed anywhere** — and this
  document therefore makes no claim that one works.
- **The response to that failure is a refusal, never a widening.** It was not answered by escalating
  the test to a broader sandbox permission, by restarting the operator's Host, or by changing any
  shared DSH setting. An earlier revision of this repository did escalate a sandbox denial to
  `danger-full-access`; that path was removed, and the review that caught it was right. The rule now
  is that an unavailable sandbox yields `SANDBOX_UNAVAILABLE` and an honest non-pass.
- **Row 8 proves less than it looks like it proves.** 5 green cases over 93 s of a 20-minute ceiling
  establish **durability and reattach** against a real provider route. They do **not** establish the
  in-flight `dispatching → uncertain` crash path, because no in-flight kill was driven. Row 8 was
  **not** re-run this round: it spends real provider quota, and this round spends none.
- **Row 9 is not the 48-hour milestone.** 28 bounded segments are not 48 hours. The 48-hour figure is
  claimed nowhere in this repository.

The remaining entries in this section are **not** evidence rows and are listed so they are not
mistaken for measurements: no run of the multi-day soak has been observed, and no live run on the
current revision exists.

The seeded property layer prints its seed on every run, e.g.
`[seeded property] seed=20260912 rounds=40 (replay with DSH_PILOT_SEED=20260912)`; replay with
`DSH_PILOT_SEED=<seed> node test/run.mjs test/property`.

### 7.2 The requirement-to-test mapping is enforced, not maintained

`test/unit/matrix-gate.test.mjs` cross-checks `docs/requirements.md`, this document and
`docs/architecture.md` **in both directions**:

- every P0/P1 requirement must have a row, every row must name a real requirement, and the two
  documents must agree on its priority;
- **every citation in every audited document must resolve to a real case under `test/`** — 186 of them
  at the time of writing, in `docs/test-matrix.md`, `docs/architecture.md`, `docs/conflicts.md`,
  `docs/requirements.md` and `docs/adr/`. The count is not hand-maintained here: the gate collects the
  citations it audited and reports the number it actually walked, so this line is the observation and
  not the input. A citation naming a deleted or renamed test fails the build rather than
  keeping its claim forever;
- the gate's own count of declared cases must equal **what the runner itself registered**, which the
  runner now hands the gate in the case context (`context.registeredCases`) rather than the gate
  keeping a constant it would have to remember to bump. This is the difference between a check and a
  chore: the previous form compared against a hand-maintained number, and it went stale exactly as
  often as the suite grew — most recently at `149` declared against `127` expected. The check
  additionally honours the layers the run selected, because `node test/run.mjs test/unit` registers a
  subset while the gate collects the whole tree, and that is not a disagreement; a run narrowed with
  `--filter` prints that the total check is not applicable rather than comparing incomparable numbers.
  A further correction is applied only when the gate actually collected the opt-in live layer, since
  its cases are declared in the tree but registered only when it is selected;
- a row may only claim `measured` when it cites at least one id and every id resolves.

The gate has already earned its keep. It caught `FR-EV2-2` claiming `measured` while citing no test id
at all, and it caught 14 further citations in rows the `measured`-only check did not cover. Both were
corrected; the rule was not relaxed. In this round it caught two stale citations created by renaming
the cases they pointed at — including one this document was still citing under a name that no longer
existed — and one stale case total. None of the three was silenced by widening the citation rule.

It also caught a case name that could not be cited at all: a new case was named
`…and \`bytes\` reports what it cost`, and the backticks are the citation delimiter, so the gate read a
truncated name and failed. The name was changed. That is the intended direction of repair — a test that
cannot be cited is a claim that cannot be checked, and the fix belongs in the name rather than in the
delimiter.

Abbreviated citations are allowed only when the abbreviation is a unique prefix of exactly one real
case name in that file, and an ambiguous abbreviation is refused rather than guessed at. For a suite
whose cases are **generated at runtime**, the gate reads the names the suite declares (`$names`,
skipped by the runner as metadata) by importing the module — not by predicting them from the
generator's template text. That distinction is the whole point: predicting a generated name is a
second implementation of the generator, and this gate's first two attempts at it were both wrong,
once reporting four real citations as naming nothing. Importing cannot disagree with the suite.

The gate's own refusals are tested too — five negative cases, three positive controls, a check that a
corrupted generated name is refused while the real one resolves, and the count agreement above —
because a resolver that cannot say no is decoration.

---

## 8. What is not implemented

Stated plainly, because a capability that is only *named* in an architecture section is not a
capability:

| Not implemented | Reason | Where it stands |
| --- | --- | --- |
| **Session export** (`session.export`) | A produced ZIP is a real session log by definition, and this project never produces, commits, attaches or quotes one | The Host route exists and is documented in [`host-compatibility.md`](host-compatibility.md) §3; the bridge never calls it |
| **MCP resources** | The face is deliberately tool-only; every capability maps 1:1 onto one daemon op | `initialize` advertises tools only; `tools/list` returns 11 tools |
| **`streamable-http` MCP transport** | It would open a listener, which is a different trust story and needs its own ADR | stdio only |
| **Host-side queue removal without an observed item id** | A removal is addressed to an item id, and the daemon will not invent one | `queue.clear` with an unknown id answers `queue-item-not-observed` and sends nothing; with a known id it performs the removal and reports the per-item outcome |
| **Positive subprocess-stop evidence** | The Host contract has no receipt for child-process termination | `processEvidence.observed` is always `false`, with the reason |
| **48-hour soak** | Real elapsed time has not been spent | `test/soak/run.mjs` exists and has only been run as a bounded smoke (CI uses `--minutes 1`); the 48-hour figure is a later milestone and is claimed nowhere |
| **A 48-hour or multi-day reliability claim of any kind** | Same as above | No document in this repository claims one |
| **Workspace/cwd escape handling (the other half of FR-SEC-4)** | BUILT. A `cwd` is resolved to the directory it names at create time — that directory, not the name, is what the bridge records and what the Host is told — and the recorded directory is re-verified before every dispatch. A path that is relative, missing, or not a directory is refused with `WORKSPACE_UNSAFE`; a recorded workspace that has been deleted, replaced by a file, or replaced by a symlink to somewhere else is refused with `WORKSPACE_CHANGED` BEFORE the intent is reserved, so no prompt can reach the Host | `security/workspace-cwd` (5 cases) plus two production controls; the "no prompt was sent" half is asserted on the fake Host's received-request log |
| **An aggregate ceiling across both downlinks** | The queue budget is per connection, so two connections may each hold up to `eventBufferMaxBytes` | Stated in C-5 rather than implied; no global ceiling exists |
| **Binary frames on a downlink** | Both DSH downlinks are JSON text, so a binary frame is refused as an unknown protocol shape rather than decoded on a guess | C-5 records this as a deliberate limit to revisit, not a fact about DSH |
| **Event retention or rotation** | No window and no compaction | Same as FR-EV-7/FR-STATE-6 above; `logMaxBytes` is still a configured number with nothing enforcing it |

---

## 9. What this matrix does not claim

- No row above says `measured` without naming the test that measured it.
- `partial` means exactly that: implemented, partly proven, with the gap written in the row. It is
  never to be quoted as passing.
- `unverified` means implemented-but-unasserted; `not-implemented` means the capability is absent,
  and the reason says which of the two a reader is looking at. Neither is a pass.
- `blocked` items are dependencies on something outside this repository (real elapsed time, or an
  upstream observable that does not exist), not failures and not passes.
- The default run skips the entire isolated-Host layer (10 skips) and never selects the live layer.
  A default green run is therefore **not** evidence about the official Host or about a real model.
- The fake Host is our own code. A green fake-Host run is evidence about our client only, and this
  document never presents it as evidence about the official Host.
- The live layer ran once and is opt-in; nothing here is a standing claim about provider behaviour,
  and no endpoint or credential value appears in this repository — the credential is referred to by
  environment-variable name only.
- Requirement `FR-OWN-4` is recorded as `not-implemented` on purpose: the delivered design rejects
  the lease the requirement describes, and the measured behaviour is the opposite one.
- No test audits coverage percentages, and no percentage is reported.

## 10. Changes from the review-0945 round, with the test that holds each one

Every line below is a defect that was present at `00983ac`, the case that fails without the fix, and the
negative control that was actually run (a control that is not run is a claim, not evidence).

| Defect | Test | Control that was run |
| --- | --- | --- |
| `session.create`'s Host value read one level too deep, so the Host's session id was always replaced by a locally minted UUID | `fake-host/session-create-value::the Host session id from session.create is recorded…` | restoring the over-deep read fails with the minted UUID |
| `Store.recordSession` returned the id it had just minted when the insert took its conflict arm, so a second client key resolving to one Host session made the daemon dereference `null` (a `TypeError` as the caller's error text) | `fake-host/session-create-value::two client keys the Host maps to one session resolve to one session…` | restoring the return fails with `Cannot read properties of null (reading 'session_id')` |
| The unary response cap was applied to `text.length` after `setEncoding('utf8')` — UTF-16 code units, not received bytes | `fake-host/response-bytes::the response cap counts BYTES…` | counting `chunk.toString('utf8').length` fails with `uncertain` replaced by `succeeded` |
| A truncated response body had no exit: failure was watched on the request only, and a body that stops early fails the response | `fake-host/response-bytes::a response that stops early settles on the truncation…` | removing BOTH response-level exits hangs the case; removing either one alone does not, and this row says so rather than crediting one handler |
| `IpcClient` bounded nothing it received, and decoded per chunk | `network/ipc-bounds::a peer that never sends a newline…`, `::a reply whose multi-byte characters are split…` | removing the bound hangs; restoring `chunk.toString('utf8')` fails on the split reply |
| The daemon assembled requests with `chunk.toString('utf8')` per chunk | `network/ipc-bounds::the daemon decodes a request split mid-character…` | restoring the per-chunk decode fails |
| The page budget exempted one oversized event from a limit it could not cross, and the caller was never told which event | `persistence/event-page-vs-ipc-bound::an event larger than the IPC reply bound is refused with its seq named, and paging past that seq makes progress` | disabling the policy fails on the missing seq |
| A control frame above 125 bytes was answered with a pong whose length byte held the payload length — in the 7-bit field, 126/127 mean "read the length", so the reply was malformed | `network/ws-bounds::a ping carrying more than 125 bytes is refused…`, `::a fragmented control frame is refused…` | accepting the frame leaves the connection open instead of failing it |
| The server would emit a reply above the bound its own client applies | `network/ipc-bounds::the daemon refuses to WRITE a reply above the bound…` | disabling the cap fails the case (the end-to-end case passes either way, which is how this went unnoticed) |
| `dsh_task_ensure`'s `label` was accepted from its own schema, forwarded, and ignored | `fake-host/task-label::a task label supplied by the caller comes back on the task…` | dropping the label fails; the identity case fails if the label is stored in the lookup column |
| A column added to the DDL was absent from every state file already in use | `unit/core::a state file written before a column existed is brought up to shape…` | removing `applyMigrations` fails on the pre-existing row |
| The daemon-local queue was described as a scope while nothing appends to it, and `#localQueueMax` bounded nothing | no new case; the reply's note and `docs/architecture.md` now say the local scope is EMPTY BY DESIGN, and the dead limit is deleted | not applicable — this is a withdrawn claim, recorded in `conflicts.md` C-7 |
| `#dispatch`'s `retryable` argument and `sessionWait`'s `sinceSeq` were accepted and never read | no new case; both are removed, and `#dispatch`'s note says retrying is decided from the contract | not applicable — withdrawn arguments, listed in `conflicts.md` C-8 |

Not fixed, and named so nobody reads this table as complete: the `session.wait` `sinceSeq` capability
(withdrawn rather than built), the two cancellation-scope gaps already recorded at
`docs/test-matrix.md` line 329, and the Host's own `workspace-invalid-path` refusal (the workspace boundary
is now enforced from this side, but the fixture cannot answer that code, so the Host-side path is untested).

## 12. The workspace (cwd) boundary: a path is a name, not a directory

`cwd` is the one caller-supplied value this bridge hands to a component that runs tools inside it. It was
forwarded verbatim: recorded as given, sent as given, and never looked at again. Three things follow from
that, and each has a case.

| Defect | Test | Control that was run |
| --- | --- | --- |
| A `cwd` that is a symlink was recorded and sent as the LINK, so the session's workspace was a name whose target could be changed later | `security/workspace-cwd::a cwd that is a symlink is recorded and dispatched as the directory it resolves to` | `workspace-path-not-resolved` fails it: the Host receives the link path, not the directory |
| A `cwd` that is relative, does not exist, or is not a directory was accepted at create time, and the failure surfaced later, on the Host side, in the middle of a session | `security/workspace-cwd::a cwd that does not exist, is relative, or is not a directory is refused before anything is sent` (asserts the refusal names which case, and that NO `session.create` reached the Host) | the same control fails it on the first case |
| A recorded workspace that was swapped for a symlink, deleted, or replaced by a file was dispatched into anyway — the Host would run the turn in a directory the bridge never recorded and the caller never chose | `security/workspace-cwd::a workspace replaced by a symlink to another directory is refused before dispatch, and no prompt is sent`; `::a workspace that was deleted, or replaced by a file, is refused before dispatch and no prompt is sent` | `workspace-not-reverified-before-dispatch` fails both: the swap case dispatches with no error at all |

The refusal codes are distinct because the responses differ: `WORKSPACE_UNSAFE` is an argument this call
cannot use, `WORKSPACE_CHANGED` is a session whose workspace moved underneath it and retrying is not the
fix. `WORKSPACE_UNSAFE` maps to JSON-RPC `-32602` so an MCP client does not read its own bad argument as an
internal failure of ours. The design trade — resolve and record, rather than refuse every symlink, and
refuse a same-key retry whose workspace changed instead of returning the earlier outcome — is recorded in
`docs/conflicts.md` C-10 with its reasoning.

The honest limit: this is a boundary this process can enforce over the PATH it hands over, not a sandbox.
The Host holds the authority to run a turn wherever it likes, and nothing here confines it. What is
enforced is that this bridge never dispatches into a directory other than the one it recorded.

## 11. The framing budget, corrected again: a delivery is not a frame

`00983ac` and `6497080` both bounded "bytes per frame" and both measured something else. The first
measured characters instead of bytes. The second measured BYTES — but of the wrong thing: everything the
current `data` event happened to carry, compared before that chunk was split on newlines, and restored
after each frame from the re-encoded length of the decoded remainder. Three consequences, all of them
observable, and the reviewed candidate had all three on BOTH ends of the socket:

| Defect | Test | Control that was run |
| --- | --- | --- |
| Two legal replies delivered in one write were refused together, and every pending caller was failed for it | `network/ipc-bounds::two replies delivered in ONE write are both answered, though together they exceed the per-reply bound` (12 pairs, 12 sequential rounds, each pair in a single write, each reply 300 bytes against a 512-byte bound) | `ipc-client-counts-the-delivery-not-the-frame` fails it with `reply exceeds the IPC reply limit` |
| A frame of `cap + 1` bytes was ACCEPTED when the peer delivered it in pieces, because the comparison had stopped being about a frame | `network/ipc-bounds::a reply of exactly the bound is accepted and one byte more is refused, with the last character split across deliveries` | the same control accepts the over-bound frame and fails the case with `a frame one byte over the bound must be refused` |
| The reset undercounted by the bytes a streaming decoder holds for an incomplete trailing sequence (up to 3 per frame transition) | the same boundary case, whose accepted frame is exactly the bound and whose delivery split is placed inside its final three-byte character by LOCATING that character's offset | removed by construction: the framer reports raw bytes, so there is no decoder in the accounting path to lose them in |
| A delivery carrying one complete frame and the start of the next, cut inside a character — the shape where a completed frame, a partial frame and two waiters are all live at once | `network/ipc-bounds::a delivery holding one complete reply plus the start of the next, cut inside a character, crosses neither frames nor waiters` | `ipc-client-counts-the-delivery-not-the-frame` fails it with `reply exceeds the IPC reply limit` |
| The daemon refused two request lines batched into one write, each legal and together over the per-line bound | `network/ipc-bounds::the daemon serves two request lines delivered in one write, each legal and together over the per-line bound` | `ipc-server-counts-the-delivery-not-the-line` fails it with `the server never answered both lines` |
| A frame straddling two deliveries — one carrying its tail and the next frame's head | `network/ipc-bounds::a frame split so that one delivery carries its tail and the next frame's head is parsed as two frames` | the delivery-shaped control does not fail this one, and this row says so rather than implying it does: a straddling frame is also mis-measured as a whole delivery, but each piece stays under the bound, so the case pins the requirement instead of the defect |

**How the split is placed, and why that had to be fixed too.** The first version of the boundary case
chose its delivery split as `bytes.length - 2`. A JSON frame ends with `"}` and a newline, so that offset
splits quoted ASCII: the case would have gone on passing while proving nothing about multi-byte handling,
and an `endsWith` assertion could not tell the difference. The case now builds a frame whose padding ENDS
in `中`, LOCATES that character's byte offset in the frame, and asserts the structure of the split — the
first delivery ends on the character's leading byte (`>= 0xc0`), the second begins on a continuation byte
(`0x80-0xbf`), and the two rejoin into exactly the bytes that were sent. The exact `cap` and `cap + 1`
frame sizes are asserted too, so a case that silently rounded its own padding would fail rather than pass.

The fix is `LineFramer` in `src/lib/ipc.ts`: newline BYTES on an accumulated `Buffer`, each frame
returned with its exact size, and the bytes still waiting for a newline reported as their own number so an
unterminated frame is refused at one frame's worth rather than buffered. Decoding per frame is exact
rather than a compromise because a newline byte cannot occur inside a UTF-8 sequence, so a frame boundary
is always a character boundary; `docs/conflicts.md` C-8a has the reasoning and the decision record.
`startIpcServer` gained `maxRequestBytes` so the daemon's half can be tested at 512 bytes instead of
4 MiB, which is the difference between a property with a test and a property with a comment.
