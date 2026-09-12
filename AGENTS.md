# AGENTS.md - engineering rules for dsh-pilot

These rules bind everyone who writes code, tests, docs, or issues here, human or agent. They are
meant to be checkable: a rule nobody can check is a bug in the rule. If a task instruction conflicts
with one, stop and surface the conflict instead of picking a side. Read the whole file before your
first change; sections 2, 4, and 7 are the ones newcomers get wrong.

## 1. Project identity and purpose

- **dsh-pilot** is an independently implemented MCP (Model Context Protocol) server/bridge that lets
  an MCP client discover and control durable sessions on a DSH Host ("DeepSeek Harness", npm package
  `@deepseek-ai/dsh`, MIT licensed). License: MIT. It speaks DSH's public interfaces, without forking or
  vendoring them.
- The **downstream consumer** is DSH's own MCP client plugin, `@deepseek-ai/dsh-mcp-client`, which spawns
  MCP servers over `stdio` or `streamable-http` and exposes their tools as `mcp__<serverName>__<toolName>`.
  So the bridge must be a **real MCP server process** speaking the official MCP protocol, not a lookalike.

## 2. Architecture in one paragraph

Three faces, one spine. The **MCP face** is a real MCP server speaking the official MCP wire
protocol directly — newline-delimited JSON-RPC 2.0 over stdio, hand-implemented, because this project
has zero runtime dependencies and no MCP SDK is used — exposing tools to whatever client spawns it.
(There are no MCP resources or prompts: the surface is tools only.)

The **Host client face** is a locally implemented HTTP + WebSocket client for the DSH `/api` surface: control traffic is `POST /api/<method>`, two WebSocket
downlinks stream events, and approvals and user-questions are answered with `POST /api/respond`. The
**durable local state** records every intent before it is sent and reconciles after a restart, since
most host methods have no idempotency key. The **domain layer** between the faces is the only place
MCP tool semantics and Host wire semantics meet, and owns lifecycle, queue, and cancellation meaning.

| Face / layer | Owns | Must not |
| --- | --- | --- |
| MCP face | MCP protocol wiring, tool schemas, JSON-RPC framing, client-facing errors | Contain HTTP, WebSocket, or session semantics |
| Domain layer | Session lifecycle, intent records, reconciliation, cancellation scopes, capability negotiation | Speak raw HTTP/WS; know MCP tool names |
| Host client face | `/api` envelopes, rpcId minting, WS downlinks, `/api/respond`, `session.export` | Decide business meaning; retry non-idempotent calls on its own initiative |
| Durable state | Journal, intent records, replay, durable-before-accepted ordering | Hold credentials or secrets; be treated as an optional cache |

## 3. The Host control surface we bridge

Verified contract facts, not guesses. Code and tests must match them.

| Surface | Shape |
| --- | --- |
| Control | `POST /api/<method>`, body `{type:"client-request", rpcId, method, payload}`; response body `{type:"server-response", rpcId, result:{ok:true,value}\|{ok:false,error:{code,message,details}}}` |
| Event downlinks | WebSocket `GET /api/events.mux` (all-session aggregated) and `GET /api/events.host` (host level) |
| Downlink misuse | Plain HTTP GET on those two paths returns `426 upgrade required`; sending client messages on the WebSocket is a protocol violation |
| Answers | `POST /api/respond` carrying a `client-response` envelope; HTTP body is a receipt `{accepted:true}` or `{accepted:false,reason:"not-pending"\|"bad-response"}` |
| Export | `GET` and `HEAD` on `/api/session.export` return a session-log ZIP |
| Fence | A browser-trust fence (Host header / Origin) guards every `/api` request |

All upstream traffic is HTTP; the WebSocket is a downlink only. The fence is a browser-origin defence,
**not** an auth layer; network reachability is out of scope, so do not build or claim auth/TLS stories.

## 4. Layering and dependency rules

Allowed dependency direction is one way: `mcp face -> domain -> host client -> durable state`.
Anything pointing backwards is a review blocker.

- **Contract and protocol code stays free of Node-only APIs.** No `node:*`, `Buffer`, `process`, or
  filesystem/socket access where wire shapes, schemas, or capability tables are defined. This is no
  longer a convention: `tsconfig.contract.json` compiles `src/lib/errors.ts`, `src/lib/mcp-tools.ts` and
  `src/lib/mcp-protocol.ts` with the Node type surface REMOVED (`"types": []`), so such an access is a
  build failure. `npm run typecheck:contract` is a CI gate. `src/lib/gateway.ts` is the stdio transport and
  is excluded on purpose — it legitimately needs streams, which is why the Node-free protocol surface
  lives in `src/lib/mcp-protocol.ts` and the loop receives its process facilities as values instead of
  reading the Node global object.
- **The MCP face and the Host client face meet only in the domain layer.** A tool handler never
  builds an HTTP request, mints an `rpcId`, or touches the WebSocket; the Host client never imports a
  tool definition or an MCP type.
- **No reaching into another layer's internals.** Import through each layer's public entry point
  only: no deep cross-layer relative imports, no poking at another module's private fields.
- **No dependency on `@deepseek-ai/dsh-host-apiproxy`, not even for types.** An earlier revision of
  this file required it as a types-only source of truth. That was never adopted and is not the
  delivered posture: the package is not a dependency in any form, and the Host's payload types, error
  codes and capability shape are modelled in `src/lib/adapter.ts` and `src/lib/errors.ts` and pinned by
  `PINNED_METHODS` (52 names) and `PINNED_ERROR_CODES` (39 codes). Written out deliberately rather
  than silently deleted, because a stale rule that contradicts the code is worse than no rule. See
  `docs/adr/0001-language-runtime-and-dependency-posture.md` and
  `docs/host-compatibility.md` for the measured contract.
- **No dependency on any pre-existing "Agentlink" project**, runtime or dev time. Fixtures, helpers,
  and protocol code are ours.
- **Type checking is part of the design, and it is a gate.** The implementation is **TypeScript**
  under `src/`, compiled by `tsc` to `dist/`; the suites and the shipped binaries run the compiled
  output. Three gates, all run in CI and all runnable by hand:

  | Gate | Command | Covers |
  | --- | --- | --- |
  | Build | `npm run build` | `src/**/*.ts` → `dist/` with `strict` **and `noImplicitAny`** on |
  | Contract surface is Node-free | `npm run typecheck:contract` | `src/lib/{errors,mcp-tools,mcp-protocol}.ts` compiled with the Node type surface removed (`types: []`) |
  | Test layer against the emitted types | `npm run typecheck:tests` | `test/**/*.mjs` (`allowJs`+`checkJs`, `strict`, `noImplicitAny: false` — tests may have unannotated locals; nullability and `unknown` narrowing are still enforced) |

  A green suite with an unchecked type surface is not acceptable, and an environment problem
  installing a devDependency is never a reason to ship unchecked code: fix the install (a
  task-owned cache or prefix is usually enough) or report a concrete blocker.
- **`dist/` is generated, gitignored, and rebuilt — never committed and never edited.** Every gate
  above and the mutation runner rebuild it, and `test/run.mjs` refuses to start without it. A change
  that only exists in `dist/` does not exist.
- **`src/` uses no `any`, and no type-check suppression of any kind.** `@ts-ignore`,
  `@ts-expect-error` and `@ts-nocheck` appear nowhere in `src/` or `test/` — a suppressed error is a
  deleted check, and this repository does not delete checks. Where a value is genuinely of unknown
  type it is `unknown` and the code narrows it; `any` is never the answer, because `any` silently
  disables checking rather than documenting uncertainty.
- **A narrowing cast is permitted only at a documented dynamic boundary, and nowhere else.** The
  honest cases are the ones where data crosses into this process from something that cannot promise a
  shape: a `JSON.parse` result (the Host's reply envelope and `/api/respond` receipt in
  `src/lib/adapter.ts`, a peer's parsed payload in `src/lib/mcp-tools.ts` and `src/lib/ids.ts`), and a
  `node:sqlite` row read through a generic helper that cannot know its caller's row type
  (`src/lib/store.ts`). Each such site carries a comment naming the boundary, and the runtime
  validation that guards the value is a real check elsewhere in the same flow rather than the cast.
  **The rule that matters: a cast must never be used to silence an error the type system just
  found.** If a cast looks like the cheapest way to make something compile, that is the signal that
  the code is wrong, not that the cast is needed — prefer a runtime check plus a type predicate,
  which is what the ban on `any` exists to force.
- The one permitted untyped view outside `src/` is the documented single cast in
  `test/helpers.mjs`'s `ipcClient`, which exists because the test layer is the oracle for the
  daemon's JSON reply frames and an oracle that must first be told the answer is not an oracle.

## 5. Compatibility and pinning

- **`host.describe.version` is not a compatibility pin.** It is documented as the host app's package
  version, but on the live host it reported `0.0.1` while the installed `@deepseek-ai/dsh` was `0.1.1-rc.2`.
  The cause is not established; treat the field as a diagnostic string only, never a version check.
- **Pinning comes from the package manifest plus a checked-in inventory of the resolved dependency
  tree**: exact versions, a committed lockfile, and a generated inventory a test can assert against.
  The re-pin procedure is in ADR 0001.
- **The `/api` contract has already changed across published versions**, verified between the
  `0.0.1-rc.1` and `0.1.1-rc.2` resolved trees:

  | Change | Direction |
  | --- | --- |
  | `command.execute`, `command.list` | present in `0.0.1-rc.1`, absent from the `0.1.1-rc.2` method map |
  | `workspace.insertBefore` | absent from the `0.0.1-rc.1` method map, present in `0.1.1-rc.2` |

  So **capability negotiation and explicit unsupported-operation reporting are mandatory**: a method
  missing from the negotiated set must produce a clear, specific error to the MCP client. Never
  silently no-op, never fake a success value, never fall back to a plausible default.

## 6. Durability, idempotency, and cancellation

- **Every state transition is durable before it is reported as accepted**: persist the intent, flush,
  then answer the MCP client. An accepted call that cannot be replayed after a crash is a bug.
- **Never blind-re-send a non-idempotent upstream call.** Only `session.create` accepts a caller-preallocated
  `sessionId`: retrying with the same id and cwd returns the same session, while a different cwd fails
  `session-conflict`. `session.prompt`, `session.cancel`, `session.updateQueue`, and `respond` have **no
  host-side idempotency key beyond `rpcId`**: record durable intent, then reconcile against observed state.
- **An unknown outcome surfaces as an explicitly uncertain state.** Never map uncertainty to success
  or failure: the MCP client must tell "not sent", "sent, confirmed", and "sent, outcome unknown"
  apart, and later reconciliation must be able to resolve it.
- **Two nested cancellation scopes, and they are different operations.** `session.cancel` stops the
  active turn while preserving pending inbox work in FIFO order; a queued item is removed separately
  with `session.updateQueue` (`action.kind: "remove"`). Connection state and execution state are
  distinct: losing a WebSocket says nothing about whether a turn or child process is still running.
- **Never claim a tool subprocess stopped without process-level evidence.** "We sent a cancel" and
  "we dropped the connection" are not evidence. Report what was observed, with the observation.

## 7. Test rules

Every reliability claim in code, docs, or an issue needs an **observable oracle**. No claim ships
without a test that could fail.

| Layer | What it proves | Default CI |
| --- | --- | --- |
| Unit / contract | schema parsing, envelope shapes, capability tables, error mapping | yes |
| Property / model (seeded) | invariants over generated sequences, replayable from a printed seed | yes |
| Persistence and crash | real multi-process persistence, SIGKILL crash and restart, replay, reconciliation | yes |
| Fake-Host contract | real HTTP and real WebSocket against a locally started fake Host, including the `426` upgrade behaviour and receipt shapes | yes |
| MCP E2E (stdio) | the built binary spawned as a real MCP server over `stdio`, driven by a real MCP client | yes |
| Isolated official DSH Host | a real Host booted by the test in its own `DSH_HOME` on an ephemeral port, with the model route closed to a loopback fixture | opt-in |
| Live Host | the operator's real provider route, bounded by constants (a total wall-clock ceiling, a concurrency ceiling, a minimum number of isolation rounds); the credential is referenced by environment-variable NAME only and never read back | never |
| Negative controls | one deliberate defect at a time, applied to a scratch copy: a `production` control mutates `src/` and evidences this bridge, a `fixture` control mutates our own fake Host and evidences fixture fidelity only. A control that survives, or a run that executes no tests at all, fails the runner | yes |

- **MCP is never replaced by direct internal function calls in E2E.** A test claiming to prove MCP
  behaviour must spawn the built binary and speak MCP over a real transport; calling the handler
  directly is a unit test wearing an E2E label and proves nothing about the protocol face.
- **Fake Host and official-Host fixtures must not be conflated.** Separate directories, distinct
  names, distinct labels in output. A passing fake-Host run is evidence about our client code only,
  never evidence about the official Host, and no doc may present it as such.
- **Skipped, timeout, and failed counts are reported distinctly.** Never collapse them into one "not
  passing" number, and never let a skip be reported as a pass.
- **A green run must never be produced by skipping the live suite.** Live tests are opt-in behind an
  environment flag and excluded from default CI; when not selected, the run must say so loudly and the
  summary must show the live suite as skipped rather than absent.
- **Worktree ownership is cooperative, not an OS sandbox.** Tests must not assume they own a
  worktree, port, or directory. Claim, isolate, clean up.

## 8. Determinism

- **Seeded randomness only, seed printed and replayable.** Every property/model test prints its seed
  at start (not only on failure) and accepts it back through an environment variable. A failure that
  cannot be replayed from its seed is not a fixed failure.
- **No wall-clock or timezone flakiness.** Inject the clock; do not assert on local time, DST
  boundaries, or the machine's zone. The host contract has a real `invalid-time-zone` error, so
  timezone handling is part of the surface, not an accident.
- **No retry-until-green and no sleep-based synchronization.** A test that passes on the second attempt is
  flaky, not passing; never add retries or sleeps to bury a failure, and wait on an observable condition
  with a bounded timeout instead of sleeping, reporting a timeout as a timeout.

## 9. Secrets, privacy, and evidence

- **Never commit** a credential, API key, token, company URL or hostname, internal endpoint, or a real
  session log.
- **Provider and credential references are by environment variable NAME only.** Never read a value
  from one, print one, echo it in a failure message, or write one into a fixture, snapshot, or
  recorded HTTP/WS transcript.
- **Redact at the boundary.** Logging, error details, and exported evidence pass through a redaction
  step; assume any string can contain a secret and test redaction as a code path.
- **Only synthetic evidence is published.** Anything quoted in an issue, PR, doc, or screenshot comes
  from our own fixtures or fabricated data; real artifacts stay uncommitted (section 10) and are quoted
  only in reduced, synthetic form.
- **`session.export` output is a real session log by definition.** Any produced ZIP is sensitive:
  never commit it, never attach it to a PR, never publish it.
- **Live tests are opt-in and never run in default CI**, and they read no credential value beyond the
  environment variable names they require.

## 10. Filesystem boundaries

| Allowed to write | Purpose |
| --- | --- |
| The repo-ignored `.local/` directory | scratch state, local databases, captured local artifacts |
| Task-created isolated temp dirs (for example a fresh `mkdtemp` under the OS temp root) | per-test isolation, crash-test working sets |
| Build output directories declared by the project config | compiled artifacts |

Forbidden, always: a user's real DSH home or config (tests get their own home root via an environment
override, never the ambient one); port `3080` or any port where a real DSH Host or the DSH Web GUI may
already be listening (bind an ephemeral port and record what you got); another project's repository or
worktree; and any host process you did not start - never point a destructive test at a running host.

## 11. Documentation index

| Path | Contents |
| --- | --- |
| `docs/requirements.md` | what the bridge must do, with the observable oracle for each requirement |
| `docs/test-matrix.md` | requirement -> test layer mapping, including which layers are opt-in |
| `docs/host-compatibility.md` | resolved-tree inventory, negotiated capability set, per-version contract drift |
| `docs/architecture.md` | layered design, sequence diagrams, state machine, durability model |
| `docs/adr/` | decision records; start with `0001-language-runtime-and-dependency-posture.md` |

## 12. Commit and pull request hygiene

- Work on a **feature branch**; never commit or push directly to `main`, and never force-push a branch
  under review or rewrite its history after review comments arrive - add commits instead.
- Every commit carries a `Signed-off-by:` trailer with the contributor's real name and email, matching
  the commit author. No shared, role, or synthetic identities.
- Open a **draft pull request** early, and mark it ready only once the evidence below is attached.
- **Do not merge your own pull request**; review and merge belong to a maintainer.
- A PR states: which requirement it addresses, the oracle that proves it, any newly claimed reliability
  property, the seed of any stochastic test, whether the live suite ran (and if not, that it was skipped),
  the distinct skipped/timeout/failed counts, and any pinning or capability-set impact.
- Some tasks explicitly forbid committing (write-files-only tasks, for example): obey the task over your
  default habits, and never commit as a side effect of tidying up. Keep secrets, real logs, and real
  hostnames out of commit messages, PR bodies, and screenshots.
