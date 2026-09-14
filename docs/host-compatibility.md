# DSH Host compatibility report (measured)

Status: **measured against a real DSH Host**, in an isolated `DSH_HOME`, on 2026-09-12.
Bridge: implemented (daemon, MCP stdio gateway, durable store, Host client) — see [`README.md`](../README.md).
Owner: company DSH worker on route `sx-anthropic/deepseek-flash` (route and credential are named, never quoted — §1.2).

This report is the compatibility gate for the MCP bridge. It records what the DSH Host actually
exposes, what the bridge may rely on, what it must treat as unknown, and how the version pin is
established. Every claim below carries **how it was verified**, because "measured by running a real
Host", "measured against our own fake Host", and "read from a type declaration" are three different
strengths of evidence and must never be presented as each other.

---

## 1. Scope and method

| Item | Value |
|---|---|
| Target Host package | `@deepseek-ai/dsh` (the `dsh` CLI launcher + bundled plugin tree), installed `0.1.1-rc.2` |
| Installed path | a standard global npm install (exact local path redacted; resolve with `npm root -g`, then `<root>/@deepseek-ai/dsh`). Its published CLI bin entry is **`lib/bin.js`** — measured, not assumed |
| Contract types read | `<npm root -g>/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/**` (`rpc-map.d.ts`, `rpc.d.ts`, `sessions.d.ts`, `host.d.ts`, `events.d.ts`, `approvals.d.ts`, `questions.d.ts`, `fetch/client.d.ts`, `fetch/handler.d.ts`), and `@deepseek-ai/dsh-client-connection/lib/types/{api-path,api-request-trust,websocket-downlink}.d.ts` |
| Real-Host probe | an isolated Host started by the test layer: throwaway `DSH_HOME`, OS-assigned port, model route pointed at a loopback mock provider |
| Earlier baseline probe | local Host at `http://127.0.0.1:3080` (a running Web UI), **read-only calls only** — recorded in the earlier revision and not re-run here |
| Run that produced this revision | `node test/run.mjs test/isolated-host --isolated` → `passed=10 failed=0 skipped=0 timedOut=0` |
| Not probed | other users' sessions, credential values, provider endpoint URLs, production systems |

No write, prompt, cancel, approval, settings or credential call was made against the operator's live
Host. `session.list` was called only to confirm the endpoint shape and page metadata, and no other
session's content is reproduced here. All turn-level probing happened against a Host this project
started itself.

### 1.1 Verification classes (how a claim was verified)

| Class | Meaning | What it may be used to claim |
|---|---|---|
| `measured (real Host)` | observed by running a real DSH Host, started by this project, in a throwaway `DSH_HOME` on an OS-assigned port. The oracle is the Host's own response, the Host's own event stream, or a file a real tool wrote | behaviour of the real product on this machine |
| `measured (fake Host)` | observed against `test/fixtures/fake-host.mjs`, our own in-process stand-in over real HTTP and real WebSocket | behaviour of **our client code only**; never evidence about the official Host |
| `measured (contract read)` | read from the installed contract types / handler source at the pin | wire shapes, method and error-code sets; silent on runtime behaviour |
| `measured (tree probe)` | read from the installed and resolved dependency tree at the pin | what versions are present |
| `unknown` | none of the above; not verified by any means | nothing — treated as unsupported until a test proves otherwise |

### 1.2 Provider and credential references

The bridge and its tests refer to a provider route by **name** and to a credential by the **name of an
environment variable**. The operator's route is `sx-anthropic/deepseek-flash`, and the credential
variable is `SX_API_KEY`. No endpoint URL and no credential value is read into, printed by, or stored
in this repository, its fixtures, its reports, or this document.

---

## 2. Version pin — and why `host.describe.version` cannot be it

### 2.1 Measured facts

| Source | Version | Verified how |
|---|---|---|
| `@deepseek-ai/dsh/package.json` (installed) | `0.1.1-rc.2` | tree probe |
| `host.describe` on a freshly booted isolated Host | `"version": "0.0.1"` | **measured (real Host)** |
| `host.describe` on the operator's long-lived Host | `"version": "0.0.1"` | measured (earlier baseline probe) |
| `@deepseek-ai/dsh-host-apiproxy` in the installed tree | `0.1.1-rc.2` (bundled under the launcher's own `node_modules`) | tree probe |
| `@deepseek-ai/dsh-host-apiproxy` on npm | `next = 0.1.1-rc.2` (published 2026-08-21), `latest = 0.0.1-rc.1` | registry metadata (earlier baseline) |
| npm `dist-tags` for `@deepseek-ai/dsh` | `latest = 0.1.5-rc.1`, `next = 0.1.5-rc.2`, `alpha = 0.1.5-alpha.2` | registry metadata (earlier baseline) |

**`host.describe.version` reports `0.0.1` for both a long-lived host and a freshly booted one, while
the installed launcher package is `0.1.1-rc.2`.** The cause is not established. The field is a
placeholder value, not a compatibility pin: any bridge that gates behaviour on it would be gating on
a constant. This is a hard constraint on the design, not a cosmetic quirk, and it is asserted in the
test layer (`test/isolated-host/host.test.mjs` records the observed value and requires only that it
is a string).

### 2.2 The pin this project uses

The pin is a tuple, checked in and regenerated by inspection, never inferred from the Host:

1. `@deepseek-ai/dsh` launcher version (`0.1.1-rc.2`).
2. The resolved dependency tree: all `@deepseek-ai/*` package versions actually present.
   Recorded in the earlier baseline: **196 `@deepseek-ai/*` packages**, 187 of them at `0.1.1-rc.2`,
   plus `@deepseek-ai/cordis@4.0.1`, `@deepseek-ai/schemastery@3.18.1`, and single packages at
   `0.1.1`, `1.0.1`, `1.0.2`, `1.0.6`, `1.0.16`, `1.1.3`, `1.8.2`. The non-uniform tail is exactly
   why a launcher version alone is insufficient.
   Re-walked during this revision: 196 `@deepseek-ai/*` packages (agrees) and 484 `package.json`
   files under the installed tree's `node_modules`. The earlier baseline recorded **452 packages**
   from a resolution walk; that figure was **not reproduced** by a directory walk, and the two are
   different measurements of the same tree — neither should be read as the other.
3. Runtime packages the bridge may meet in the consumer's process, read from the tree:
   `zod@4.4.3`, `ws@8.21.3`, and `@modelcontextprotocol/sdk@1.30.0` (declared `^1.12.0` by
   `@deepseek-ai/dsh-mcp-client@0.1.1-rc.2`). **The bridge itself depends on none of them** — see
   [ADR 0001](adr/0001-language-runtime-and-dependency-posture.md).
4. Verified artifact integrity (earlier baseline): the published
   `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2` tarball is
   `sha256 b0de1779714a822ba712d46bcf71c141807d79d3e3918d3128b22558262917b5` (194 643 bytes),
   integrity
   `sha512-dplRnGGXXsQYFQ1KMHymAM0iaxuE9Z153JHYcGEgOwXNkS3HA20gSi3yMt6fz+zi/cMHYXvY1JQhS54BTc761A==`.
   Not re-fetched in this revision.

Re-pin procedure (mandatory, not optional): re-walk the tree, diff the `RpcMethodMap` keys and the
frame unions against the previous pin, re-run the isolated-Host layer, and record any add/remove/
rename here in the same change. A model cannot be asked to "be careful about versions"; the
capability negotiation and the pinned tables in `src/lib/adapter.ts` do it.

The bridge resolves a Host at runtime (`node_modules`, then `npm root -g`, with `DSH_PILOT_DSH_BIN`
as an override) and installs no DSH package, so the pin governs **what the bridge is tested
against**, not what it links against.

### 2.3 Measured contract drift between published versions

The `/api` surface is **not stable across published versions**. Diffing the published `rpc-map.d.ts`
of `0.0.1-rc.1` against `0.1.1-rc.2` (earlier baseline):

- removed: `command.execute`, `command.list`
- added: `workspace.insertBefore`

Consequences the bridge design absorbs, both now measured rather than assumed:

- capability negotiation happens at runtime (probe + declared support set), never by version
  comparison;
- an operation whose contract is absent fails as **unsupported**, visibly, with the observed reason
  — never silently emulated. Measured on the real Host: `command.execute` is answered
  `HTTP 404 not found` and is **not** reported as `ok:true`.

---

## 3. Transport surface (measured)

| Carrier | Path | Method | Measured result | Verified how |
|---|---|---|---|---|
| Unary RPC | `/api/<method>` | `POST` | 200, body `{type:"server-response", rpcId, result}` | measured (real Host + earlier baseline probe) |
| Approval/question answers | `/api/respond` | `POST` | 200, body is a **carrier receipt**: `{"accepted":false,"reason":"not-pending"}` for an unknown `rpcId` | earlier baseline probe |
| Mux downlink (all sessions) | `/api/events.mux` | `GET` + Upgrade | plain `GET` → **426** `upgrade required`; WebSocket only | **measured (real Host)** |
| Host downlink | `/api/events.host` | `GET` + Upgrade | same carrier; plain `GET` → **426** | **measured (real Host)** |
| Session-log export | `/api/session.export` | `GET`/`HEAD` | route present in `handler.js`; not probed for content | contract read |
| Method absent from the map | `/api/command.execute` | `POST` | **404 `not found`**, and not `ok:true` | **measured (real Host)** |
| Anything else under `/api` | — | — | 404 `not found`; non-`POST` unary requests are rejected | contract read |
| Outside `/api` | — | — | 404 `not found` | contract read |

Structural facts read from the contract types:

- **Upstream traffic is HTTP only.** `WebSocketDownlinks` documents client messages on the
  WebSocket as "a protocol violation"; all client→host traffic rides `POST`.
- The downlinks carry the *whole* host state; there is no per-session subscription method.
- `rpcId` is minted by the initiator. Client requests mint their own; a `client-response`
  **echoes** the server-request's `rpcId` and never mints one.
- Unary methods never throw business errors: they return `result.ok === false` with a
  closed-set `error.code` and details. Transport failures are folded into the same shape via
  `transportError()` with code `internal`.
- Every response is parsed and the `rpcId` echo is verified; a frame that fails either
  parse level is **skipped**, not fatal. A bridge therefore must do its own gap detection — the
  carrier will not tell it that something was dropped.

### 3.1 Trust fence (read from contract, and it matters for tests)

`isTrustedApiRequest` guards **every** `/api` request using the `Host` header (and Origin /
Fetch-Metadata when a browser attaches them). Its own documentation states plainly that it
"is not an auth layer" and that network reachability is out of scope. The bridge therefore:

- connects to loopback (or a declared `trustedHosts` authority) and sends a correct `Host`;
- never treats reachability as authorization, and never claims the bridge "authenticates" to the
  Host;
- records the Host authority in its own durable state, so a later reconnect cannot be silently
  redirected to a different authority.

---

## 4. Operation inventory (at the pin)

**52** client-request methods in `RpcMethodMap` at `0.1.1-rc.2` (counted from the installed
`rpc-map.d.ts`, line by line, in this revision). An earlier revision of this report said "49
methods"; that number did not match its own domain table below, which sums to 52. Corrected here
rather than silently edited.

The bridge stores the same 52 names as its pinned list. Capability state is reported honestly and in
three buckets — `declared` (the pin knows it), `probed` (the Host has actually answered for it) and
`unverified` (declared, never answered for). Measured at attach on the real Host:
`pinned methods=52 unverified=52`, i.e. the whole declared set was unprobed at that moment and is
reported as unverified rather than assumed present. The map is the single source of truth; payload
shapes are derived from these signatures.

| Domain | Methods |
|---|---|
| session (12) | `list`, `search`, `create`, `history`, `models`, `selectModel`, `rename`, `fork`, `prompt`, `attachment`, `updateQueue`, `cancel` |
| subagent (4) | `list`, `history`, `prompt`, `interrupt` |
| host (5) | `describe`, `pickDirectory`, `listDirectory`, `createDirectory`, `openPath` |
| workspace (7) | `list`, `create`, `rename`, `delete`, `insertBefore`, `insertSessionBefore`, `archiveSession` |
| skill (1) | `list` |
| agentPreset (6) | `list`, `select`, `read`, `copy`, `openDocument`, `remove` |
| goal (6) | `create`, `edit`, `pause`, `resume`, `complete`, `clear` |
| settings (5) | `describe`, `openDocument`, `update`, `replace`, `mutate` |
| credentials (3) | `describe`, `set`, `unset` |
| llm (3) | `providers`, `models`, `discoverModels` |
| (not in the map) | `respond` — approval/question answers, on `POST /api/respond` |

Stream frames: `MuxFrame` = `session/event`, `session/subscribed`, `approval/requested`,
`approval/resolved`, `question/requested`, `question/resolved`, `session/queue`,
`session/jobs`, `session/projection`, `stream/error`. `HostFrame` = `host/session-added`,
`host/session-removed`, `host/session-status`, `host/agent-error`, `host/workspace-changed`,
`host/workspace-removed`, `host/workspace-order-changed`, `host/archived-sessions-changed`,
`host/remote-event`, `stream/error`.

Key semantics the bridge depends on (contract text, condensed but not paraphrased into
something stronger than it says):

| Operation | Semantics that matter to the bridge |
|---|---|
| `session.create` | At most one of `workspaceId`/`cwd`. **A caller may preallocate `sessionId`: retries with the same id and cwd return the same session; a different cwd fails `session-conflict`.** This is the only measured upstream idempotency affordance. |
| `session.list` | `updatedAt`-descending. **`cursor` is "a reserved seat, unimplemented"** — v1 returns everything. |
| `session.history` | Windowed by `beforeSeq` + `maxMessages`; page boundaries always align to whole messages, never cut mid-message. Tail page additionally carries the in-flight partial and the `projections` block. Reading history "never resumes or publishes an Agent". |
| `session.prompt` | `mode: 'queue'` \| `'steer'`. Durable host admission **before** the model sees it. A single text block starting with `/` is a slash command executed by the host and **never sent to the model** — a bridge that forwards arbitrary caller text can therefore trigger host commands; that must be a deliberate policy decision. Returns `{accepted:true}`. Subagents reject `agent-busy`. |
| `session.updateQueue` | Mutates one **pending** occurrence by `MessageId` (`edit`/`remove`/`steer`). The id comes from the `session/queue` frame; ids are not durable until the agent claims the message. |
| `session.cancel` | "Stops an ordinary session's active turn, **preserving pending inbox work that resumes in FIFO order after cancellation settles**." Cancelling the queue is a *different* operation (`updateQueue` remove). Measured on a real Host: the bridge reports a **turn-level** acknowledgement, with `processEvidence.observed === false`. |
| `session.fork` | Cuts at the first `turn/end` at or after `atSeq`; open turn → `fork-unavailable` rather than a clipped earlier turn. |
| `session.rename` | Appends a `session/title` event with `user` source, which **pins** the title against regeneration. |
| approvals | `POST /api/respond` echoes the `approval/requested` frame's `rpcId` with `{sessionId, approvalId, outcome:'allowed-once'\|'rejected'}`. The HTTP body is only a receipt: `not-pending` means the request was already resolved/expired/replayed. The *outcome* arrives later in `approval/resolved`. |
| questions | Same carrier; answers one `ask()` as a whole batch. Answer payload carries no resource id — `rpcId` is the correlation. |
| `events.mux` | On open: a `session/subscribed` frame per attached session (`lastSeq`), then **replays each session's still-pending approval/question requested frames with the original `rpcId` reused verbatim**. `since` is "unimplemented in v1 (ignored if passed)"; reconnection = reopen the stream **and refetch history**. |
| event loss | A frame that fails to parse is reported and skipped, and the client's own gap detection "covers whatever the frame carried". Gaps are the bridge's problem. |
| extra model calls | The Host issues additional **tool-free** model calls of its own (session titles), and it **retries** a failed model call by default. Both were discovered by measurement against a real Host and are accounted for in the test fixtures; a test that counts model calls without this knowledge counts fiction. |

---

## 5. Supported / unknown / unsupported matrix

"Supported" means measured against a real Host, or guaranteed by the contract at the pin.
"Unknown" means the contract does not promise it and it was not measured; the bridge treats it as
unsupported until a test proves otherwise. **No row marked Unknown may be claimed as working in any
report.**

### 5.1 Supported — measured on a real Host

| Capability | Observation | Verified how |
|---|---|---|
| `POST /api/<method>` unary RPC + `rpcId` echo | 200 with `result.ok:true` | measured (real Host) |
| `host.describe` | answers, and reports the provider and model the Host resolved (`provider`/`model` in its own response) | **measured (real Host)** |
| `session.list` on a fresh isolated Host | 200, `items: []` | **measured (real Host)** |
| Both event downlinks refuse a plain `GET` | `/api/events.mux` → 426, `/api/events.host` → 426 | **measured (real Host)** |
| Bridge attach on the real downlinks | reaches `ready` with `health.adapterStats.protocolErrors === 0` | **measured (real Host)** |
| A real turn | runs to an authoritative `turn/end`; event kinds observed include `permission/preset`, `sandbox/mode`, `approval/policy`, `agent/inbox/spliced`, `turn/start`, `step/start`, `user/message`, `session/title`, `request/header`, `request/context`, `session/title-llm-request`, `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, `step/end`, `turn/end` | **measured (real Host)** |
| A real tool execution | `bash` executes and **the file it wrote is the oracle** — not the tool's own output | **measured (real Host)** |
| A confined sandbox refusal | carried through as a refusal, never as a silent success | **measured (real Host)** |
| A provider failure | produces no tool call and no model text (no phantom completion) | **measured (real Host)** |
| Two sessions on one Host | stay isolated; each ends on its own turn | **measured (real Host)** |
| Cancel | turn-level acknowledgement with `processEvidence.observed === false` | **measured (real Host)** |

### 5.2 Supported — contract-guaranteed at the pin

| Capability | Evidence | Bridge use |
|---|---|---|
| `session.create` with preallocated `sessionId` | contract read | idempotent session creation/retry |
| `session.history` paging (`beforeSeq`, `maxMessages`) | contract read | incremental event paging |
| `session.prompt` with `mode: queue`/`steer` | contract read | message dispatch |
| `session.cancel` (turn scope) | contract read | turn cancellation |
| `session.updateQueue` (queue scope) | contract read | queue cancellation/mutation |
| Pending-approval replay on mux open (same `rpcId`) | contract read | reconnect recovery baseline |
| `POST /api/respond` echo contract + `not-pending` receipt | earlier baseline probe (`{"accepted":false,"reason":"not-pending"}`) | approval/question answering, stale-response detection |

The isolated-Host fixture itself (throwaway `DSH_HOME`, `dsh web --port 0 --host 127.0.0.1 --no-open`)
is measured and in use by the 10 passing real-Host cases; it is described in §6 rather than here,
because it is a test fixture and not a Host capability.

### 5.3 Unknown — treated as unsupported until a test proves it

| Unknown | Why it is unknown | Consequence |
|---|---|---|
| Whether `session.prompt` survives a bridge crash without duplicate dispatch | no host-side idempotency key beyond the request's `rpcId`, and no dedupe method in the map | the bridge records intent durably **before** sending and reconciles after restart; never blind re-send |
| Whether a `sessionId` can be re-attached by a *different* process and driven concurrently | nothing in the contract arbitrates two live callers on one session | competing-owner protection is local, atomic, and cooperative |
| Whether `attachedSessions` counts prove wakefulness of *our* session | it is a count, not a set | connection state ≠ execution state; needs a per-session oracle |
| Whether cancelling a turn stops tool **subprocesses** | `session.cancel` speaks about the turn and inbox, never about child processes; no Host receipt exists | measured behaviour: the bridge reports `processEvidence.observed === false` and never claims a stop |
| Whether `mux` ordering is total across reconnects, and whether frames can be dropped without a `stream/error` | contract says parse failures are skipped; `since` is unimplemented | bridge-side cursor + gap detection + refetch-history reconciliation |
| Whether `session/queue` item ids are stable across reconnect | ids exist only while the item is pending | queue mutations must be re-derived from a fresh snapshot |
| Whether approval frames can arrive for sessions the bridge does not own | mux is all-session aggregated | approval binding must check task/turn/rpcId, not just sessionId |
| Whether the Host enforces any bound on event/attachment size | not stated anywhere read | the bridge imposes its own caps and treats oversize as a first-class outcome |
| Whether the real Host completes an approval round trip the way the contract describes | no approval-requiring turn was exercised against a real Host in this revision | approvals are covered against the fake Host only; see §7 |

Resolved by measurement since the earlier baseline, listed so the change is visible:

| Was unknown | Now |
|---|---|
| Whether an isolated Host with a mock provider can run a real turn with no paid calls | **yes** — a deterministic loopback mock provider drives the Host's real agent loop; 6 turn-level cases pass |
| Whether the bridge's envelope shapes and downlink usage satisfy the real Host | **yes** — `ready`, `protocolErrors === 0`, real turns to `turn/end` |
| Whether a method absent from the Host's map is refused rather than faked | **yes** — `command.execute` → HTTP 404, not `ok:true` on this build |

### 5.4 Unsupported at this pin (measured absent or explicitly unimplemented, not "not yet tried")

| Unsupported | Evidence | Verified how |
|---|---|---|
| `command.execute` / `command.list` | HTTP **404** on the installed build (present in `0.0.1-rc.1`) | **measured (real Host)** |
| Cursor-based `session.list` pagination | "cursor is a reserved seat, unimplemented" | contract read |
| Mux `since` resume | "unimplemented in v1 (ignored if passed)" | contract read |
| Any upstream channel on the WebSocket | client messages are a protocol violation | contract read |
| Any authentication/authorization layer for `/api` | the trust fence "is not an auth layer" | contract read |
| Any dependency-free protocol-version handshake | `host.d.ts`: "No protocol version: client and host ship together" | contract read |
| A Host-observable stop receipt for tool subprocesses | no such method or frame in the contract | contract read |

### 5.5 Bridge-side capability items that have no Host counterpart

These are *bridge* features whose correctness rests on the bridge's own storage and on
process-level observation; the Host cannot be asked to confirm them:

persistent task/session/turn/operation/interaction IDs; the durable journal and its
reconciliation rules; atomic single-owner protection; storage-corruption / disk-full /
permission behaviour; approval binding to task+turn+rpc; and the distinction between
"connection lost" and "execution unknown".

---

## 6. Fixtures as built (measured)

| Fixture | Status | Evidence |
|---|---|---|
| Isolated official DSH Host, throwaway home | **measured, in use** | `DSH_HOME=<tmp>/home dsh web --port 0 --host 127.0.0.1 --no-open`; the Host reports its own ephemeral URL; 10 cases pass against it |
| Deterministic mock provider on loopback | **measured, in use** | emits a legal Anthropic SSE cycle scripted per test, records every request, never hardcodes an outcome; provider id `dsh-pilot-mock`, model id `dsh-pilot-mock-1`; the credential is referenced by the env-var NAME `DSH_PILOT_MOCK_API_KEY` whose value is an obvious non-credential |
| Per-test-home isolation | measured | the fresh home is created inside a test scratch dir; the rig asserts the home is inside that scratch dir |
| Port safety | measured | `--port 0` delegates to the OS; the rig refuses to adopt a Host reporting `:3080`, so a running operator Host is never contacted |
| DSH CLI discovery | measured | candidates in order: `$DSH_PILOT_DSH_BIN`, `node_modules/@deepseek-ai/dsh/lib/bin.js`, then the same path under `npm root -g` — `lib/bin.js` is the real entry; `bin/dsh.mjs` was an earlier wrong guess |
| Host sandbox backend | **measured absent on this machine** | `/usr/bin/sandbox-exec` exists but fails with `sandbox-exec: sandbox_apply: Operation not permitted`. Under `sandbox-policy mode: workspace-write` every `bash` call is refused with `SANDBOX_UNAVAILABLE`. The tool-effect test reports that refusal as an environment failure, not as a pass and not as a skip, and it is **not** worked around: an earlier revision widened the policy to `danger-full-access` after the refusal was observed and that escalation has been removed at every level, including from the rig's own option surface |

**Fixture vs fake Host are different things and are never interchangeable:** the fake Host
(implemented in-process, over real HTTP and real WebSocket) tests the bridge's own protocol
robustness; this isolated official Host tests that the bridge's assumptions match the real product.
A green fake-Host suite proves nothing about the official Host, and this report does not claim it
does.

**The sandbox-backend finding is an environment limitation, not bridge behaviour.** The bridge's
obligation is narrower and is measured: a refusal stays a refusal, and it never becomes a success.
What has not been observed anywhere is a *successful* confined-mode tool execution.

---

## 7. Open unknowns and what this revision does not cover

1. **No process-level oracle for tool subprocesses.** No Host receipt exists for subprocess
   termination, so the bridge reports `processEvidence.observed === false` on cancel instead of
   claiming a stop. A PID/exit oracle is not built.
2. **Approvals against a real Host are not exercised.** The isolated-Host layer covers turns, tools,
   refusal, isolation and cancel. Approval and question answering is covered against the fake Host,
   which proves our binding and receipt handling, not the real Host's approval flow.
3. **Confined-mode tool execution has never succeeded on this machine** (no usable sandbox backend,
   §6). Only the refusal path is measured.
4. **One Host build has been measured**: `0.1.1-rc.2`. No other published version has been run
   against the bridge, so the drift recorded in §2.3 is a diff of declaration files, not a
   behavioural comparison.
5. **Linux and Windows are unmeasured.** Everything here is `darwin/arm64`, Node v24.15.0, SQLite
   3.51.3. The CI workflow targets Linux and macOS but **has never executed on a runner**, so no
   Linux result exists to cite.
6. **Whether the Host bounds event/attachment size** is still unstated upstream; the bridge's own
   caps are the only bound in play.

None of these block the design; each is listed so it cannot be quietly assumed away.

---

## 8. Sources

- Installed package: `@deepseek-ai/dsh@0.1.1-rc.2` (CLI bin entry `lib/bin.js`), with
  `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2` and `@deepseek-ai/dsh-client-connection` bundled in
  its own `node_modules` (contract `.d.ts` files listed in §1).
- Real-Host measurements from the opt-in layer: `node test/run.mjs test/isolated-host --isolated`
  (10 cases), which boots the Host itself under a throwaway `DSH_HOME` and routes it at a loopback
  mock provider.
- Earlier baseline probe against the operator's local Host `http://127.0.0.1:3080`: `host.describe`,
  `session.list`, `POST /api/respond` with an unknown `rpcId`, and `GET`/`POST` probes of
  `/api/events.mux` (read-only).
- Public npm registry metadata and tarballs for `@deepseek-ai/dsh`,
  `@deepseek-ai/dsh-host-apiproxy`, `@deepseek-ai/dsh-client-connection` (integrity values in §2.2;
  version history in §2.3), fetched in the earlier baseline and not re-fetched here.
- The live provider layer (`node test/run.mjs test/live --live`) is the only layer that measures a
  real provider route; it is opt-in, is never part of default CI, and refers to the route and the
  credential by name only.
