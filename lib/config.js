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
import { BridgeError, ERROR_CODES } from './errors.js';

/**
 * @param {object} [env]
 * @returns {object} resolved configuration
 */
export function resolveConfig(env = process.env) {
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
      frameMaxBytes: numberOr(env.DSH_PILOT_FRAME_MAX_BYTES, 1024 * 1024),
      waitDefaultMs: numberOr(env.DSH_PILOT_WAIT_DEFAULT_MS, 30_000),
      waitMaxMs: numberOr(env.DSH_PILOT_WAIT_MAX_MS, 120_000),
      compactResultBytes: numberOr(env.DSH_PILOT_RESULT_MAX_BYTES, 64 * 1024),
    },
  };
}

/**
 * @param {string|undefined} value
 * @param {number} fallback
 * @returns {number}
 */
function numberOr(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new BridgeError(ERROR_CODES.BAD_REQUEST, `configuration value is not a number: ${value}`, {});
  }
  return parsed;
}

/**
 * Guard: refuse to run a suite or tool against a state directory that looks like a real
 * installed one unless the operator says so explicitly.
 * @param {string} stateDir
 * @returns {{safe: boolean, reason?: string}}
 */
export function assertScratchStateDir(stateDir) {
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
