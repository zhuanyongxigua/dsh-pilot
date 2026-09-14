/**
 * Configuration resolution.
 *
 * Why this file exists: every value that could point at a real system (state directory, Host
 * base URL, Host namespace) must come from the environment, with an explicit default, and
 * must never be baked into the code. Provider routing, credentials and endpoints are the
 * operator's business: this project stores a *reference* to a route, never a secret, and no
 * company endpoint appears anywhere in the repository.
 *
 * Precedence: explicit CLI flag > environment variable > default.
 */

import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BridgeError, ERROR_CODES } from './errors.ts';
// The one number both ends of the IPC socket use, so the daemon cannot emit a frame its own gateway
// would refuse to buffer. Imported rather than duplicated: two literals is how the two ends drift.
import { MAX_IPC_REPLY_BYTES } from './ipc.ts';

/** The environment surface this module reads: `process.env` by default, or a test's own map. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Bounds the daemon applies to pages, frames, messages and waits.
 *
 * The three event bounds are separate quantities, not one number in three spellings, and each has a
 * different owner: `eventPageMax` is how many events a reply may carry, `eventPageMaxBytes` is how
 * large that reply may be, `eventMessageMaxBytes` is the largest single downlink message the
 * connection will assemble, and `eventBufferMaxBytes` is the most memory this process will hold for
 * frames it has parsed but not yet consumed.
 */
export interface ConfigLimits {
  readonly eventPageMax: number;
  readonly eventPageMaxBytes: number;
  readonly eventMessageMaxBytes: number;
  readonly eventBufferMaxBytes: number;
  readonly frameMaxBytes: number;
  readonly waitDefaultMs: number;
  readonly waitMaxMs: number;
  readonly compactResultBytes: number;
  /**
   * The unary deadline, including the one on `/api/respond`. It is here rather than hard-coded in the
   * adapter because a bound that cannot be set cannot be tested at the size the test needs, and a
   * 15-second deadline is only reachable in a test by waiting 15 seconds.
   */
  readonly hostTimeoutMs: number;
  /**
   * The most response body the adapter will hold, for both the unary path and `/api/respond`.
   *
   * Configurable for the reason the deadline is: a cap that cannot be set cannot be tested at the size
   * the test needs. Proving that the cap counts BYTES rather than characters means sending a body whose
   * character count is small and whose byte count is over the line, which is only cheap if the line is
   * a few kilobytes instead of eight megabytes.
   */
  readonly hostResponseMaxBytes: number;
  /**
   * The most one IPC reply frame may be, in received bytes, enforced on BOTH ends of the socket.
   *
   * Settable because the two ends must agree and a test has to be able to prove they do at a size it can
   * actually produce: the end-to-end case drives a real oversized event through a real daemon and reads
   * the typed refusal back, which is only cheap if the limit is a few kilobytes.
   */
  readonly ipcReplyMaxBytes: number;
}

/** Resolved configuration. Every field has an environment variable and an explicit default. */
export interface ResolvedConfig {
  readonly stateDir: string;
  readonly hostBase: string;
  readonly hostScope: string;
  /** Explicit socket override; `null` when the caller must derive one from the state directory. */
  readonly socketPath: string | null;
  readonly scratchRoot: string;
  readonly limits: ConfigLimits;
}

/**
 * @returns resolved configuration
 */
export function resolveConfig(env: EnvSource = process.env): ResolvedConfig {
  const stateDir = resolve(
    env.DSH_PILOT_STATE_DIR
    || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'dsh-pilot'),
  );
  const hostBase = (env.DSH_PILOT_HOST_URL || 'http://127.0.0.1:3080').replace(/\/+$/, '');
  return {
    stateDir,
    hostBase,
    hostScope: env.DSH_PILOT_HOST_SCOPE || hostBase,
    socketPath: env.DSH_PILOT_SOCKET || null,
    /** Test-only scratch root; keeps suites out of any real state directory. */
    scratchRoot: env.DSH_PILOT_SCRATCH || join(tmpdir(), 'dsh-pilot'),
    limits: {
      eventPageMax: numberOr(env.DSH_PILOT_EVENT_PAGE_MAX, 200),
      eventPageMaxBytes: numberOr(env.DSH_PILOT_EVENT_PAGE_MAX_BYTES, 256 * 1024),
      eventMessageMaxBytes: numberOr(env.DSH_PILOT_EVENT_MESSAGE_MAX_BYTES, 4 * 1024 * 1024),
      eventBufferMaxBytes: numberOr(env.DSH_PILOT_EVENT_BUFFER_MAX_BYTES, 32 * 1024 * 1024),
      frameMaxBytes: numberOr(env.DSH_PILOT_FRAME_MAX_BYTES, 1024 * 1024),
      waitDefaultMs: numberOr(env.DSH_PILOT_WAIT_DEFAULT_MS, 30_000),
      waitMaxMs: numberOr(env.DSH_PILOT_WAIT_MAX_MS, 120_000),
      compactResultBytes: numberOr(env.DSH_PILOT_RESULT_MAX_BYTES, 64 * 1024),
      hostTimeoutMs: numberOr(env.DSH_PILOT_HOST_TIMEOUT_MS, 15_000),
      hostResponseMaxBytes: numberOr(env.DSH_PILOT_HOST_RESPONSE_MAX_BYTES, 8 * 1024 * 1024),
      ipcReplyMaxBytes: numberOr(env.DSH_PILOT_IPC_REPLY_MAX_BYTES, MAX_IPC_REPLY_BYTES),
    },
  };
}

function numberOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, `configuration value is not a number: ${value}`, {});
  }
  return parsed;
}

/** Verdict of the real-state guard: a refusal carries the reason it refused. */
export type ScratchDirVerdict =
  | { readonly safe: true }
  | { readonly safe: false; readonly reason: string };

/**
 * Guard: refuse to run a suite or tool against a state directory that looks like a real
 * installed one unless the operator says so explicitly.
 */
export function assertScratchStateDir(stateDir: string): ScratchDirVerdict {
  const forbidden = [join(homedir(), '.dsh'), join(homedir(), '.local', 'state')];
  for (const path of forbidden) {
    if (stateDir === path || stateDir.startsWith(`${path}/`)) {
      // Allowed only when the operator opted in: a real state directory is never a test target.
      if (process.env.DSH_PILOT_ALLOW_REAL_STATE === '1') return { safe: true };
      return { safe: false, reason: `refusing to use ${stateDir} without DSH_PILOT_ALLOW_REAL_STATE=1` };
    }
  }
  return { safe: true };
}
