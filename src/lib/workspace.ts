/**
 * Workspace (cwd) boundary for a session.
 *
 * Why this module exists: `cwd` is the one caller-supplied value this bridge hands to a component that
 * runs tools inside it, and the value is a PATH — a name that can be re-pointed between the moment a
 * session is created and the moment work is dispatched into it. A recorded path is therefore not evidence
 * about a directory. Two facts have to be established instead:
 *
 * 1. At create time, the path names a real directory. If it is a symlink, the directory it RESOLVES to is
 *    what gets recorded and what the Host is told, so the session's workspace is a directory rather than
 *    whatever a name points at later.
 * 2. Before work is dispatched, the recorded directory is still the SAME directory. Because what was
 *    recorded is already a resolved path, this is a realpath comparison: if the path was replaced by a
 *    symlink to somewhere else, deleted, or turned into a file, the comparison fails and the dispatch is
 *    refused before anything is sent.
 *
 * What this is NOT: a sandbox, and not an authorization check. This bridge does not own the Host's
 * filesystem and cannot confine what a turn does there — the Host is the component with that authority.
 * What it can do is refuse to dispatch work into a workspace that is not the one it recorded, which is a
 * real hazard and a real boundary, and it does not claim to be more than that.
 *
 * No `node:*` import appears at the top of this file on purpose: the two operations are INJECTED so that
 * the decision logic can be exercised without a filesystem, and so that the only place a path is followed
 * is the one deliberate call the caller supplies.
 */

import { ERROR_CODES } from './errors.js';
import { BridgeError } from './errors.js';

/** The filesystem operations this module needs, as values rather than globals. */
export interface WorkspaceFs {
  /**
   * Resolve a path to the real directory it names, following every symlink. Throws when the path does
   * not exist or cannot be resolved.
   */
  readonly realpath: (path: string) => string;
  /** True when the path exists AND names a directory. False for a missing path and for a file. */
  readonly isDirectory: (path: string) => boolean;
}

/** Why a workspace was refused. Named so a caller can tell the cases apart without parsing a message. */
export type WorkspaceRefusal =
  | 'not-absolute'
  | 'not-found'
  | 'not-a-directory'
  | 'path-changed'
  | 'no-longer-a-directory';

/** A workspace that passed. `resolved` is the directory to record and to hand to the Host. */
export interface ResolvedWorkspace {
  readonly resolved: string;
}

/**
 * Resolve a caller-supplied `cwd` to the real directory it names.
 *
 * Refusing a path that does not exist is deliberate, and it is a real requirement on callers rather than
 * an accident: a session's workspace is a directory this bridge can verify, and a name that resolves to
 * nothing is a name whose target is decided by whoever creates it later. A missing path is refused with
 * `not-found`, a path that is a file with `not-a-directory`, and a relative path with `not-absolute`, all
 * before anything is reserved or sent, so no half-created session is left on the Host.
 *
 * This is a contract, so it is enforced by the fixtures too: the MCP E2E and multi-caller suites were
 * passing a workspace they never created, and each now creates its own real directory. That is how a real
 * caller behaves, and it is what makes "dispatch refused when the workspace is gone" testable at all —
 * there has to be a real directory to remove.
 *
 * @param cwd the caller's path, as it arrived in the request frame
 * @param fs the filesystem operations to use
 * @returns the resolved directory, or a typed refusal
 */
export function resolveWorkspace(cwd: string, fs: WorkspaceFs): ResolvedWorkspace | { readonly refusal: WorkspaceRefusal } {
  if (!cwd.startsWith('/')) {
    // Relative paths are refused rather than resolved against this process's own working directory: the
    // daemon's cwd is an implementation detail, and a session that silently meant "wherever the daemon
    // was started" is a workspace nobody chose.
    return { refusal: 'not-absolute' };
  }
  let resolved: string;
  try {
    resolved = fs.realpath(cwd);
  } catch {
    return { refusal: 'not-found' };
  }
  if (!fs.isDirectory(resolved)) return { refusal: 'not-a-directory' };
  return { resolved };
}

/**
 * Check that a recorded workspace is still the directory it was when it was recorded.
 *
 * The recorded value is a resolved path, so "still the same directory" is exactly "this path still
 * resolves to itself and is still a directory". A symlink planted in its place resolves to its target
 * instead, a deleted path does not resolve at all, and a file is not a directory: all three are refusals.
 *
 * @param recorded the resolved path stored on the session row
 * @param fs the filesystem operations to use
 */
export function verifyWorkspace(recorded: string, fs: WorkspaceFs): { readonly ok: true } | { readonly ok: false, readonly refusal: WorkspaceRefusal } {
  let resolved: string;
  try {
    resolved = fs.realpath(recorded);
  } catch {
    return { ok: false, refusal: 'not-found' };
  }
  if (resolved !== recorded) return { ok: false, refusal: 'path-changed' };
  if (!fs.isDirectory(resolved)) return { ok: false, refusal: 'no-longer-a-directory' };
  return { ok: true };
}

/** The refusal a caller sees at create time. */
export function workspaceUnsafe(cwd: string, refusal: WorkspaceRefusal): BridgeError {
  return new BridgeError(ERROR_CODES.WORKSPACE_UNSAFE, 'the workspace path cannot be used', {
    refusal,
    // The caller's own path, echoed back so it can see which argument was refused. `cwd` comes from the
    // caller and is not a secret from the caller.
    cwd,
  });
}

/**
 * The refusal a caller sees when a session's recorded workspace is no longer that directory.
 *
 * The distinction from `workspaceUnsafe` matters to a caller: this is not a bad argument, it is a session
 * whose workspace moved underneath it, and the answer is to create a session for the current directory
 * rather than to retry this call.
 */
export function workspaceChanged(recorded: string, refusal: WorkspaceRefusal): BridgeError {
  return new BridgeError(ERROR_CODES.WORKSPACE_CHANGED, 'the session workspace is no longer the directory it was created in', {
    refusal,
    workspace: recorded,
  });
}
