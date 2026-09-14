# dsh-pilot

Persistent DSH session control for AI coordinators, with automated reliability and recovery tests.

`dsh-pilot` is an independently implemented **MCP bridge** that lets an MCP client start, follow,
resume, cancel and answer durable [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) sessions —
without guessing what happened when something goes wrong.

> **Status: implemented, and measured on one machine.** The bridge — daemon, MCP stdio gateway,
> durable store, Host client — and its test layers exist and run. Every number in this file comes
> from a run on **macOS (darwin/arm64), Node v24.15.0, against installed
> `@deepseek-ai/dsh@0.1.1-rc.2`**. What has *not* run is named as not run: CI has never executed on
> a runner, the multi-day soak has not been attempted, and no confined-mode tool execution has
> succeeded on this machine because it has no usable DSH sandbox backend. See
> [Status](#status-honest) and [Evidence](#evidence-measured) before quoting anything here.

---

## What it is

- A **real MCP server process** (stdio), because the intended consumer is DSH's own MCP client
  plugin, which spawns servers and exposes their tools to a model as `mcp__<server>__<tool>`.
- A **durable controller**: task/session/turn/operation/interaction identities that survive a
  bridge crash, a journal written *before* anything is sent, and honest reconciliation instead of
  blind re-sends.
- An **honest reporter**: an unknown outcome is reported as `uncertain`, never as success and
  never as failure. Connection state and execution state are separate facts. A cancelled turn is
  not evidence that a child process stopped.
- **Small.** TypeScript sources under `src/` compiled by `tsc` to `dist/`, zero runtime
  dependencies, Node 24 built-ins only: a thin HTTP + WebSocket client for DSH's `/api` surface, a
  domain layer, and crash-safe local state in `node:sqlite`.

## What it is not

- Not a fork of DSH and not a vendor of it; it speaks DSH's public interfaces.
- Not an authorization layer: the Host's request fence is a browser-origin defence and is
  documented upstream as *not* an auth layer. No security story is built on it.
- Not a sandbox for agent worktrees; worktree ownership is cooperative and says so.
- Not a re-implementation of any pre-existing internal project — nothing here depends on one.

---

## Status (honest)

| Item | State | Where the evidence is |
|---|---|---|
| Implementation | **implemented**: daemon (owns one state dir + one Host connection), MCP stdio gateway, durable store, Host client, operator CLI | `src/`, compiled to `dist/` |
| Deterministic suite | **`passed=64 failed=0 skipped=10 timedOut=0`**, ~64s | [Evidence](#evidence-measured) |
| Isolated official DSH Host (opt-in) | **10 passed, 0 failed** against a real Host this machine started | [Evidence](#evidence-measured) |
| Live provider suite (opt-in) | **5 passed, 0 failed**, 93s of a 20-minute ceiling — one run | [Evidence](#evidence-measured) |
| Typechecking | three gates: `npm run build`, `npm run typecheck:contract`, `npm run typecheck:tests` — **0 errors** | [Tests](#tests) |
| CI | workflow file exists for Linux + macOS; **never executed on a runner** | [Evidence](#evidence-measured) |
| Soak | bounded smoke only; **multi-day observation not run** | [Tests](#tests) |
| DSH sandbox backend on this machine | **none usable**: `/usr/bin/sandbox-exec` fails with `Operation not permitted` | [Environment limitation](#environment-limitation-sandbox-backend) |
| Compatibility baseline | measured on 2026-09-12 against installed DSH `0.1.1-rc.2` | [`docs/host-compatibility.md`](docs/host-compatibility.md) |

The 10 skips are the whole `test/isolated-host` layer, which is opt-in. Nothing in this repository
reports a skipped test as a pass: the counts are always printed as four distinct numbers.

---

## Running it

```bash
npm ci                        # dev tooling only (typescript, @types/node). The runtime has zero dependencies.
npm run build                 # compile the TypeScript sources in src/ to dist/, which is what everything runs
npm run typecheck:all         # all three type-check configs; 0 errors expected
```

Three processes, deliberately separate. Each runs the compiled `dist/` output, so `npm run build`
comes first:

```bash
# 1. The daemon. It owns exactly one state directory and one Host connection, and it refuses to
#    start if another owner holds the state directory.
node dist/bin/dsh-pilot-daemon.js --state-dir .local/state --host http://127.0.0.1:3080

# 2. The MCP server an MCP client spawns over stdio. It writes nothing but JSON-RPC to stdout and
#    fails closed with an actionable message when the daemon is unreachable.
node dist/bin/dsh-pilot-mcp.js --state-dir .local/state

# 3. The operator CLI: the only channel that can decide an approval. The authority token lives in
#    the daemon's private state directory (0600) and is never reachable through MCP.
node dist/bin/dsh-pilot-ops.js status
node dist/bin/dsh-pilot-ops.js decide --task TASK --interaction INT --decision allowed-once
```

Configuration comes from environment variables with explicit defaults — `DSH_PILOT_STATE_DIR`
(default `~/.local/state/dsh-pilot`), `DSH_PILOT_HOST_URL` (default `http://127.0.0.1:3080`) — or
from the equivalent flags. No endpoint, credential or company hostname is ever compiled in.

---

## Tests

One harness, `test/run.mjs`. It imports every suite in a layer, prints one line per case
(`ok` / `FAIL` / `SKIP` / `TIME`), then the four counts separately, then a per-layer JSON summary.

```bash
node test/run.mjs             # or: npm test  — the deterministic layers, no network, no secrets
```

Measured on this machine: `passed=64 failed=0 skipped=10 timedOut=0`, ~64s, and the run prints
`live suite: SKIPPED (opt-in; not selected on this run)`.

Every layer runs the compiled output under `dist/` — the MCP E2E layer spawns
`dist/bin/dsh-pilot-mcp.js`, and the suites import `dist/lib/*.js` — so `npm run build` must run
first. `test/run.mjs` refuses to start (exit `2`) and names the missing build when `dist/lib/ids.js`
is absent, rather than producing a wall of module-resolution failures that read like broken code.

Three type gates, all runnable by hand:

| Gate | Command | What it checks |
|---|---|---|
| Build | `npm run build` | `src/**/*.ts` → `dist/` under `strict` **and** `noImplicitAny` |
| Contract surface is Node-free | `npm run typecheck:contract` | `src/lib/{errors,mcp-tools,mcp-protocol}.ts` compiled with the Node type surface removed (`types: []`), so a `node:*`/`process`/`Buffer` reference in them is a build failure |
| Test layer against the emitted types | `npm run typecheck:tests` | `test/**/*.mjs` (`allowJs` + `checkJs`, `strict`, `noImplicitAny: false` — a test may have an unannotated local; nullability and `unknown` narrowing are still enforced) |

`npm run typecheck:all` runs all three. (`npm run typecheck` is the same `tsc -p tsconfig.json`
invocation as `npm run build`, so it also writes `dist/`.)

| Layer | Directory | Command | In the default run |
|---|---|---|---|
| unit / contract | `test/unit` | `node test/run.mjs test/unit` | 21 passed |
| seeded property / model | `test/property` | `node test/run.mjs test/property` | 3 passed |
| fake Host (real HTTP + real WebSocket) | `test/fake-host` | `node test/run.mjs test/fake-host` | 17 passed |
| persistence and crash (real processes, `SIGKILL`, `SIGSTOP`) | `test/persistence` | `node test/run.mjs test/persistence` | 6 passed |
| MCP E2E over stdio (a real MCP client spawns the binary) | `test/mcp-e2e` | `node test/run.mjs test/mcp-e2e` | 8 passed |
| security and bounds | `test/security` | `node test/run.mjs test/security` | 9 passed |
| isolated official DSH Host — **opt-in** | `test/isolated-host` | `node test/run.mjs test/isolated-host --isolated` | 10 **skipped** |
| live provider route — **opt-in** | `test/live` | `node test/run.mjs test/live --live` | not selected |

`npm run test:unit` runs unit + property; the other npm scripts are thin wrappers:
`test:contract` (fake Host), `test:persistence`, `test:mcp`, `test:security`, `test:isolated-host`,
`test:live`, `test:mutations`, `test:soak`, `build`, `build:check`, `typecheck`, `typecheck:contract`,
`typecheck:tests`, `typecheck:all`.

The fake Host and the official Host are never conflated: a green fake-Host run is evidence about our
client code only, never about the real product. Only `test/isolated-host` and `test/live` touch a
real DSH Host.

### Opt-in layer 1 — isolated official DSH Host

```bash
node test/run.mjs test/isolated-host --isolated     # or: npm run test:isolated-host
```

- Requires an installed `@deepseek-ai/dsh`. `DSH_PILOT_DSH_BIN` is tried first; otherwise it looks in
  `node_modules`, then under `npm root -g`. With no Host found, every case SKIPs and says so. (The
  CLI's published bin entry is `lib/bin.js` — not `bin/dsh.mjs`.)
- What it starts: a real Host, in a throwaway `DSH_HOME`, on an OS-assigned port (it refuses port
  3080), with the model route pointed at a deterministic mock provider on loopback. No paid calls,
  no network beyond loopback.
- Measured: **10 passed, 0 failed** (4 control-plane cases, 6 turn-level cases).

### Opt-in layer 2 — live provider route

```bash
node test/run.mjs test/live --live                  # or: npm run test:live
```

- Reads the operator's own DSH settings (`DSH_PILOT_SETTINGS_FILE`, else `$DSH_HOME/settings.yaml`,
  else `~/.dsh/settings.yaml`), takes the declared default model route, and resolves that route's
  credential **by environment-variable name only** (`launchctl getenv`, then
  `DSH_PILOT_CREDENTIAL_PROFILE`, default `~/.zshrc`). The operator's route is
  `sx-anthropic/deepseek-flash` and the credential variable is named `SX_API_KEY`. Names only, by
  design: no endpoint URL and no key value appears in this repository, in a fixture, or in a report.
- Spends real provider quota. Whole layer ≤ 20 minutes of wall clock, ≤ 8 concurrent sessions, no
  retry-until-green; a case whose provider call fails is a failure, never a quiet skip. With no
  describable route it SKIPs with the precise reason.
- Measured: **5 passed, 0 failed**, 93s of the 20-minute ceiling — one run, not a repeated result.

### Other runners

```bash
node test/mutation/run.mjs                      # or: npm run test:mutations
node test/soak/run.mjs --smoke --minutes 1      # bounded soak smoke
node test/soak/run.mjs --resume --hours 48      # the multi-day milestone; not run yet
node test/soak/run.mjs --status                 # print recorded segments only
```

The mutation runner introduces one deliberate defect at a time into a **throwaway copy** of the
source (never the working tree) and requires the suite that claims to protect that behaviour to go
red; a surviving mutation fails the runner. The soak runner is resumable and records wall-clock
time, monotonic time and the gaps between records separately, because a soak that hides its gaps is
not evidence.

### Knobs and result semantics

| Variable | Effect |
|---|---|
| `DSH_PILOT_JSON=<path>` | also write the machine-readable per-layer report |
| `DSH_PILOT_SEED=<n>` | replay a seeded property/model run from its printed seed |
| `DSH_PILOT_PROPERTY_ROUNDS=<n>` | number of generated rounds for the property layer |
| `DSH_PILOT_DSH_BIN=<path>` | point the isolated-host layer at a specific DSH CLI |
| `DSH_PILOT_SETTINGS_FILE=<path>` | settings file the live layer reads a route from |
| `DSH_PILOT_CREDENTIAL_PROFILE=<path>` | shell profile the live layer resolves a credential name from |
| `DSH_PILOT_STATE_DIR`, `DSH_PILOT_HOST_URL`, `DSH_PILOT_SOCKET` | daemon/gateway configuration |
| `--filter=<substring>` | run only matching case ids |

The harness exits non-zero **iff** `failed > 0` or `timedOut > 0`. A skip does not fail a run, which
is exactly why the counts are printed and meant to be read instead of the exit code alone.

---

## Evidence (measured)

Environment, all measurements below:

| Item | Value |
|---|---|
| Node | `v24.15.0` |
| Platform | `darwin/arm64` (macOS) |
| `node:sqlite` reports | SQLite `3.51.3` |
| Installed Host | `@deepseek-ai/dsh@0.1.1-rc.2`, CLI bin entry `lib/bin.js` |

| Run | Result |
|---|---|
| Deterministic layers (`node test/run.mjs`) | `passed=64 failed=0 skipped=10 timedOut=0` in ~64s; the 10 skips are the whole `test/isolated-host` layer; the run prints `live suite: SKIPPED (opt-in; not selected on this run)` |
| Typechecking | three gates: `npm run build`, `npm run typecheck:contract`, `npm run typecheck:tests` — **all three re-run after the daemon migration, 0 errors** (`dist/` under `src/lib/daemon.ts` included) |
| Isolated official Host (`--isolated`) | `passed=10 failed=0 skipped=0 timedOut=0` |
| Live provider route (`--live`) | `passed=5 failed=0 skipped=0 timedOut=0`, 93s of a 20-minute ceiling |

What the isolated-Host run verified by actually running a real Host:

| Verified | Observation |
|---|---|
| `POST /api/host.describe` | answers, and reports the provider and model the Host resolved |
| Event downlinks | a plain HTTP `GET` on `/api/events.mux` and on `/api/events.host` returns **`426`** — both are WebSocket downlinks only |
| Unsupported method | a method absent from the Host's method map is refused with HTTP **404** and is *not* reported as `ok:true` (`command.execute` is absent on this build — the concrete example) |
| Attach | the bridge attaches to the real Host and reaches `ready` with `health.adapterStats.protocolErrors === 0` |
| A real turn | runs to an authoritative `turn/end`; observed event kinds include `permission/preset`, `sandbox/mode`, `approval/policy`, `agent/inbox/spliced`, `turn/start`, `step/start`, `user/message`, `session/title`, `request/header`, `request/context`, `session/title-llm-request`, `assistant/chunk`, `assistant/message`, `tool/call`, `tool/result`, `step/end`, `turn/end` |
| A real tool | `bash` executes and **the file it wrote is the oracle**, not the tool's own output |
| A confined refusal | a sandbox refusal is carried through as a refusal, never as a silent success |
| A provider failure | produces no tool call and no model text — no phantom completion |
| Two sessions | stay isolated on one real Host |
| Cancel | reported as a turn-level acknowledgement with `processEvidence.observed === false` |

What the live run measured, on the operator's real default route
(`sx-anthropic/deepseek-flash`, credential by the name `SX_API_KEY`):

- Real turns completed through the bridge, end to end.
- 3 distinct real sessions, each recalling only its own planted fact.
- Parallel sessions at widths 2, 4 and 8: every turn ended on an authoritative event, sessions were
  distinct, and no cross-contamination was observed.
- A `SIGKILL` of the daemon mid-turn left 200 durable events contiguous through seq 2014; the
  restarted owner reattached to the same Host and reported the authoritative `turn/end`.

**Honesty note on that crash case.** The operation had already been acknowledged before the kill, so
the live run proves the **durability and reattach** half of the claim. The other half — "the dispatch
was interrupted while on the wire, so the outcome is uncertain" — is proven at the fake-Host and
persistence layers, where the timing is deterministic. The live run did not prove the
in-flight-uncertainty case, and this file does not claim it did.

Also measured, and stated as a limitation rather than a feature: DSH issues extra **tool-free** model
calls for session titles, and it **retries** a failed model call by default. Both were discovered by
measurement, not by reading, and both are stated in the test fixtures because they change what a test
can assert.

### CI status

`.github/workflows/ci.yml` exists: it runs on `ubuntu-latest` and `macos-latest`, installs dev
tooling with `npm ci`, asserts that `dependencies` is empty (a runtime dependency appearing there is
a design regression), runs `npm run build` and then the `typecheck` and `typecheck:contract` configs
including all three typecheck gates (`build`, `typecheck`, `typecheck:contract`, `typecheck:tests`), runs the deterministic layers with the four counts reported separately, runs the mutation
gate over eleven named obligations, runs a bounded soak smoke, and uploads the JSON reports as
artifacts. The live suite is not reachable from it.

**It has not been executed on Linux or macOS runners yet.** The workflow file exists; no CI run has
happened, so no CI result is claimed here.

### Environment limitation (sandbox backend)

Measured on this machine: `/usr/bin/sandbox-exec` exists but fails with
`sandbox-exec: sandbox_apply: Operation not permitted`. There is therefore **no usable DSH sandbox
backend here**. Under `sandbox-policy mode: workspace-write`, every `bash` call is refused with
`SANDBOX_UNAVAILABLE`. A test that needs a real command to run reports that refusal **as a failure of
the environment**, naming the Host's own words, and the test that exercises a confined-mode tool effect
is reported as failed here rather than skipped or worked around. An earlier revision widened the policy
to `danger-full-access` after observing the refusal; that was escalation-after-refusal, it is removed at
every level, and `test/isolated-host/turns.test.mjs` now also asserts that no widened policy is ever
requested.

That is an **environment limitation, not bridge behaviour**: the bridge carries the refusal through
as a refusal (which is what the isolated-Host layer asserts), and on a machine with a working
sandbox backend the same test would observe a policy refusal instead. What has *not* been observed
anywhere is a successful confined-mode tool execution.

---

## Compatibility baseline (measured 2026-09-12)

| Fact | Value |
|---|---|
| Installed DSH | `@deepseek-ai/dsh@0.1.1-rc.2` |
| `host.describe.version` | `0.0.1` — **a diagnostic string, not a pin** (the installed launcher is `0.1.1-rc.2`) |
| Method map at the pin | 52 client-request methods in `RpcMethodMap` |
| Control carrier | `POST /api/<method>`, `{type:"client-request", rpcId, method, payload}` |
| Event carriers | WebSocket `GET /api/events.mux`, `GET /api/events.host` (plain GET → `426 upgrade required`) |
| Answer carrier | `POST /api/respond`, receipt `{accepted:false,reason:"not-pending"}` for unknown/replayed ids |
| Contract drift already observed | `command.execute`/`command.list` removed and `workspace.insertBefore` added between `0.0.1-rc.1` and `0.1.1-rc.2` |

`host.describe.version` returned `0.0.1` while the installed `@deepseek-ai/dsh` was `0.1.1-rc.2`, so
it must never be used as a compatibility pin. The pin is the package manifest plus a resolved-tree
inventory — never a value the Host reports about itself. Capability negotiation happens at runtime:
the bridge reports which methods the Host has actually answered for, and an operation the Host does
not serve fails visibly with the observed reason (measured: HTTP 404) rather than becoming a
fabricated success. Full detail, per-item verification method, and what remains unknown:
[`docs/host-compatibility.md`](docs/host-compatibility.md).

---

## What remains

| Open item | State |
|---|---|
| CI execution on Linux and macOS | workflow file written, **never run on a runner** |
| Multi-day soak | resumable runner exists; only a bounded smoke has been run, and a smoke is not multi-day evidence |
| Process-level oracle for tool subprocesses | **not built**: no DSH receipt exists for subprocess termination, so cancel is reported with `processEvidence.observed === false` rather than claiming a stop |
| Automated contract-drift diff | **not built**: drift is caught by runtime capability reporting, explicit refusals and the documented manual re-pin procedure in `docs/host-compatibility.md`, not by a test that diffs the pinned method list against the installed declaration files |
| Approvals against a real Host | covered against the fake Host only; the isolated-Host layer exercises turns, tools, refusal, isolation and cancel, not an approval round trip |
| Confined-mode tool execution | never observed successfully on this machine (no usable sandbox backend); only the refusal path is measured |
| Platforms other than macOS | everything measured here is `darwin/arm64` |
| Streamable-HTTP transport | **not offered**; the MCP face is stdio only, and offering a second transport needs its own ADR |

### Standing non-goals for every change

- No unsupported reliability claim, and no "all green" statement from a run that skipped or
  blocked tests — the four counts are always reported separately.
- No credentials, company URLs/hostnames, real logs or real session exports in the repository or
  in PR evidence; provider configuration is referenced by environment-variable name only.
- No writes outside the ignored `.local/` scratch directory, task-created isolated temp dirs, and
  declared build output — never a user's real DSH home, never port 3080, never another repository.
- No dependency on any pre-existing internal project, at runtime or in tests.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/requirements.md`](docs/requirements.md) | every capability the bridge must have, each with an **observable oracle** a test can decide |
| [`docs/test-matrix.md`](docs/test-matrix.md) | requirement → test layer → oracle mapping, including which layers are opt-in (read its own status header) |
| [`docs/host-compatibility.md`](docs/host-compatibility.md) | the measured DSH Host surface, method inventory, supported / unknown / unsupported, and how each item was verified |
| [`docs/architecture.md`](docs/architecture.md) | layering, one-operation sequence with its failure paths, state machine, durability spine |
| [`docs/adr/`](docs/adr/) | decision records: language/runtime/dependency posture, and the owner-exclusion primitive |
| [`AGENTS.md`](AGENTS.md) | binding engineering rules for anyone (human or agent) changing this repo |

---

## License

MIT — see [`LICENSE`](LICENSE).
