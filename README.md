# dsh-pilot

Persistent DSH session control for AI coordinators, with automated reliability and recovery tests.

`dsh-pilot` is an independently implemented **MCP bridge** that lets an MCP client start, follow,
resume, cancel and answer durable [DSH](https://www.npmjs.com/package/@deepseek-ai/dsh) sessions —
without guessing what happened when something goes wrong.

> **Status: Phase 0 — specification only. There is no implementation yet, and no test has been
> run.** This repository currently contains the requirements, the compatibility baseline, the test
> matrix and the architecture plan. Nothing here is a claim of working software. See
> [Status](#status-honest) before quoting anything from this project.

---

## What it is meant to be

- A **real MCP server process** (stdio), because the intended consumer is DSH's own MCP client
  plugin, which spawns servers and exposes their tools to a model as `mcp__<server>__<tool>`.
- A **durable controller**: task/session/turn/operation/interaction identities that survive a
  bridge crash, a journal written *before* anything is sent, and honest reconciliation instead of
  blind re-sends.
- An **honest reporter**: an unknown outcome is reported as `uncertain`, never as success and
  never as failure. Connection state and execution state are separate facts. A cancelled turn is
  not evidence that a child process stopped.
- **Small.** A thin HTTP + WebSocket client for DSH's documented `/api` surface, a domain layer,
  and crash-safe local state.

## What it is not

- Not a fork of DSH and not a vendor of it; it speaks DSH's public interfaces.
- Not an authorization layer: the Host's request fence is a browser-origin defence and is
  documented upstream as *not* an auth layer. No security story is built on it.
- Not a sandbox for agent worktrees; worktree ownership is cooperative and says so.
- Not a re-implementation of any pre-existing internal project — nothing here depends on one.

---

## Status (honest)

| Item | State |
|---|---|
| Implementation | **not started** |
| Tests executed | **none**, except one fixture feasibility probe (isolated DSH Host booted on an ephemeral port; see below) |
| Live provider suite | **never run** |
| Compatibility baseline | measured on 2026-09-12 against installed DSH `0.1.1-rc.2` |
| Reliability claims | **none** — every requirement has a planned oracle, not a result |

The only measurement performed so far: a throwaway-`DSH_HOME` official DSH Host boots on an
OS-assigned port and answers `host.describe` / `session.list`, and was killed cleanly. That is
recorded in [`docs/host-compatibility.md`](docs/host-compatibility.md) §6. Everything else in the
documents below is a plan.

---

## Documentation

| Document | Contents |
|---|---|
| [`docs/requirements.md`](docs/requirements.md) | every capability the bridge must have, each with an **observable oracle** a test can decide |
| [`docs/test-matrix.md`](docs/test-matrix.md) | requirement → test layer → oracle, with per-row status (`planned` / `blocked` / `measured`) |
| [`docs/host-compatibility.md`](docs/host-compatibility.md) | the measured DSH Host surface: transport, 49 method map, frame unions, supported / unknown / unsupported, and why `host.describe.version` cannot be the version pin |
| [`docs/architecture.md`](docs/architecture.md) | layering, one-operation sequence with its failure paths, state machine, durability spine, and the seams deliberately left open |
| [`docs/adr/`](docs/adr/) | decision records, starting with language/runtime/dependency posture |
| [`AGENTS.md`](AGENTS.md) | binding engineering rules for anyone (human or agent) changing this repo |

---

## Compatibility baseline (measured, 2026-09-12)

| Fact | Value |
|---|---|
| Installed DSH | `@deepseek-ai/dsh@0.1.1-rc.2`, 452 packages walked, 196 `@deepseek-ai/*` |
| `host.describe.version` | `0.0.1` — **a diagnostic string, not a pin** (the installed launcher is `0.1.1-rc.2`) |
| Control carrier | `POST /api/<method>`, `{type:"client-request", rpcId, method, payload}` |
| Event carriers | WebSocket `GET /api/events.mux`, `GET /api/events.host` (plain GET → `426 upgrade required`) |
| Answer carrier | `POST /api/respond`, receipt `{accepted:false,reason:"not-pending"}` for unknown/replayed ids |
| Contract drift already observed | `command.execute`/`command.list` removed and `workspace.insertBefore` added between `0.0.1-rc.1` and `0.1.1-rc.2` |

The pin is the package manifest plus a resolved-tree inventory plus verified artifact hashes —
never a value the Host reports about itself. Full detail and sources:
[`docs/host-compatibility.md`](docs/host-compatibility.md).

---

## Roadmap

Phase 0 (current) is a checkpoint, not a delivery. The steps below are the intended order; each
one lands with its tests, and later phases may not be claimed from earlier ones.

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — spec & baseline** *(current)* | requirements + oracles, test matrix, compatibility baseline, architecture plan, ADR | documents reviewed; open questions named, not hidden |
| **1 — design handoff** | adopt the architecture handoff: fix storage format, ownership primitive, MCP tool surface, retention policy | open seams in `docs/architecture.md` §5 resolved; ADRs recorded for each |
| **2 — skeleton & carriers** | MCP face over stdio, `/api` HTTP client with rpcId echo verification, both WebSocket downlinks, fake Host fixture | L1 + L4 suites green; MCP E2E spawning the real binary (L5) green |
| **3 — durable core** | journal, intent records, replay, schema versioning; ownership lease with atomic claim and automatic reclaim | L2 + L3 suites green, including SIGKILL crash/restart and competing-owner refusal |
| **4 — sessions & events** | session lifecycle, follow-ups, incremental paged events, gap detection + refetch reconciliation | L4 pagination/gap/disconnect rows green; isolation rows green |
| **5 — approvals & cancellation** | interaction binding, pending-until-intent, receipt semantics, turn vs queue cancellation, process evidence | L1/L4 approval rows green; L8 process-oracle rows green or explicitly blocked |
| **6 — official Host capture** | isolated Host fixture with a deterministic mock provider (no paid calls in CI) | L6 turn-level rows unblocked and green; `IH-0` extended into a maintained fixture test |
| **7 — CI & evidence** | Linux + macOS matrix, frozen lockfile, distinct failed/skipped/timeout counts, per-layer JSON artifacts, secret scanning | CI rows green; no workflow path can reach live credentials |
| **8 — live suite** | opt-in `deepseek-flash` suite: 2/4/8 parallel sessions, ≥3 unique-memory rounds, caller/bridge recovery, isolated Host restart | run once, ≤20 min, ≤8 concurrency, no retries; first failures and usage reported verbatim |
| **9 — soak** | resumable runner with real wall time, continuity and gap counters, restart checkpoints | short smoke today; multi-day observation is a **later explicit milestone** and is never claimed from a smoke run |

### Standing non-goals for every phase

- No unsupported reliability claim, and no "all green" statement from a run that skipped or
  blocked tests — the three counts are always reported separately.
- No credentials, company URLs/hostnames, real logs or real session exports in the repository or
  in PR evidence; provider configuration is referenced by environment-variable name only.
- No writes outside the ignored `.local/` scratch directory, task-created isolated temp dirs, and
  declared build output — never a user's real DSH home, never port 3080, never another repository.

---

## License

MIT — see [`LICENSE`](LICENSE).
