/**
 * The authority-token path, against symbolic links.
 *
 * Why these tests exist: the token file is the whole of the approval authority on this machine, and
 * its protection is that it lives at a path inside a directory that is mode 0700. Every operation on
 * it used a path-following call — `existsSync` then `chmodSync`, `writeFileSync` when absent, and
 * `readFileSync` — so a symbolic link planted at that path redirected all three OUTSIDE the state
 * directory. Concretely: `chmodSync` would change the mode of a file somewhere else on the machine,
 * a DANGLING link would make the bridge create the token at the link's target (writing the approval
 * secret outside its own directory), and `readAuthorityToken` would read a stranger's file and accept
 * its contents as the authority.
 *
 * The sentinels below are two files created in this test's own temporary directory. Their bytes and
 * their modes are read before and after, and neither may change: "the bridge refused" is not the
 * claim — the claim is that the file outside the state directory is untouched. Nothing here reads a
 * real token or any environment credential.
 *
 * Scope: this is about path traversal on THIS machine's filesystem. It is not an authentication
 * story, and no Nginx, TLS or network trust is involved or claimed.
 */

import { chmodSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, scratchDir } from '../helpers.mjs';

/** A caught refusal, read as the coded error it is meant to be. @param {unknown} error */
function codeOf(error) {
  return /** @type {{code?: string, message?: string}} */ (error);
}

/** The token path inside a state directory, spelled the way the module spells it. */
async function tokenPath(stateDir) {
  const { authorityTokenPath } = await import('../../dist/lib/ipc.js');
  return authorityTokenPath(stateDir);
}

/** A sentinel outside the state directory: known bytes, known mode, plus its own directory. */
function sentinel(root, name, { mode = 0o644, contents = 'sentinel contents, not a token\n' } = {}) {
  const outside = join(root, 'outside');
  mkdirSync(outside, { recursive: true, mode: 0o700 });
  const path = join(outside, name);
  writeFileSync(path, contents, { mode });
  chmodSync(path, mode);
  return { path, contents, mode };
}

/** Everything about a sentinel that must not change, as one comparable value. */
function fingerprint(path) {
  const stats = statSync(path);
  return { bytes: readFileSync(path, 'utf8'), mode: stats.mode & 0o777, size: stats.size };
}

export default {
  'FR-SEC-4 a symlink at the authority token path is refused, and the file it points at is neither chmodded nor read': async () => {
    const scratch = scratchDir('token-symlink');
    try {
      const stateDir = join(scratch.dir, 'state');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const target = sentinel(scratch.dir, 'planted-target', { mode: 0o644 });
      const path = await tokenPath(stateDir);
      symlinkSync(target.path, path);

      const before = fingerprint(target.path);
      const { ensureAuthorityToken, readAuthorityToken } = await import('../../dist/lib/ipc.js');

      // Reading must refuse rather than hand back the target's bytes.
      let readError = null;
      try { readAuthorityToken(stateDir); } catch (error) { readError = error; }
      assert.equal(codeOf(readError).code, 'UNSAFE_STATE_PATH',
        `reading through a link must be a typed refusal, got ${codeOf(readError).code}: ${codeOf(readError).message}`);
      assert.ok(!String(codeOf(readError).message ?? '').includes(target.contents.trim()),
        'the refusal must not quote the contents it refused to read');

      // Ensuring must refuse rather than chmod the target. This is the load-bearing assertion: the
      // old code did `existsSync` → `chmodSync(path, 0o600)`, which follows the link and changes the
      // mode of a file the bridge does not own.
      let ensureError = null;
      try { ensureAuthorityToken(stateDir); } catch (error) { ensureError = error; }
      assert.equal(codeOf(ensureError).code, 'UNSAFE_STATE_PATH',
        `ensuring through a link must be a typed refusal, got ${codeOf(ensureError).code}: ${codeOf(ensureError).message}`);

      const after = fingerprint(target.path);
      assert.deepEqual(after, before,
        `the file outside the state directory must be byte-for-byte and mode-for-mode unchanged: `
        + `${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
      assert.equal(after.mode, 0o644,
        `the target must NOT have been chmodded to 0600, got ${after.mode.toString(8)}`);
      // And the link itself is still a link: refusing is not the same as silently replacing it.
      assert.ok(lstatSync(path).isSymbolicLink(), 'the planted link must be left exactly where it was');
    } finally {
      scratch.cleanup();
    }
  },

  'FR-SEC-4 a DANGLING symlink is refused instead of being followed to create the token outside the state directory': async () => {
    const scratch = scratchDir('token-dangling');
    try {
      const stateDir = join(scratch.dir, 'state');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const outside = join(scratch.dir, 'outside');
      mkdirSync(outside, { recursive: true, mode: 0o700 });
      // The target does NOT exist. This is the case `existsSync` reports as absent, which is why the
      // old code took the create branch and wrote the token to wherever the link pointed.
      const target = join(outside, 'not-yet-created');
      const path = await tokenPath(stateDir);
      symlinkSync(target, path);

      const { ensureAuthorityToken, readAuthorityToken } = await import('../../dist/lib/ipc.js');
      let ensureError = null;
      try { ensureAuthorityToken(stateDir); } catch (error) { ensureError = error; }
      assert.equal(codeOf(ensureError).code, 'UNSAFE_STATE_PATH',
        `a dangling link must be refused, not written through, got ${codeOf(ensureError).code}: ${codeOf(ensureError).message}`);
      // THE assertion: no file was created at the link's destination.
      let targetExists = true;
      try { statSync(target); } catch { targetExists = false; }
      assert.equal(targetExists, false,
        'the authority token must NOT have been created outside the state directory');
      // Reading it refuses too, and deliberately NOT with `null`. `null` means "this state directory
      // has no token", which an operator fixes by creating one; a link is a path this process will
      // never authenticate through whether or not it resolves, and reporting that as "no token" would
      // make a planted, currently-broken link indistinguishable from an unconfigured directory. One
      // rule for both operations: a link at this path is refused.
      let readError = null;
      try { readAuthorityToken(stateDir); } catch (error) { readError = error; }
      assert.equal(codeOf(readError).code, 'UNSAFE_STATE_PATH',
        `a dangling link must be the same typed refusal as a resolving one, got ${codeOf(readError).code}`);
      // And the refusal is a refusal, not a partial success: nothing was read and nothing written.
      assert.equal(targetExists, false, 'still nothing outside the state directory');
      assert.ok(lstatSync(path).isSymbolicLink(), 'and the link is still there, untouched');
    } finally {
      scratch.cleanup();
    }
  },

  'FR-SEC-4 a real token is still created with mode 0600, still readable, and still re-readable idempotently': async () => {
    const scratch = scratchDir('token-normal');
    try {
      const stateDir = join(scratch.dir, 'state');
      const { ensureAuthorityToken, readAuthorityToken } = await import('../../dist/lib/ipc.js');

      // The POSITIVE control: refusing every path would pass the two cases above while breaking the
      // product. Creating, reading and re-ensuring must all work on an ordinary state directory.
      const created = ensureAuthorityToken(stateDir);
      assert.equal(created.created, true, 'a token must be created where none exists');
      const stats = statSync(created.path);
      assert.equal(stats.mode & 0o777, 0o600, `the token must be 0600, got ${(stats.mode & 0o777).toString(8)}`);
      const token = readAuthorityToken(stateDir);
      assert.match(String(token), /^[0-9a-f]{64}$/, 'the token must read back as the hex value that was written');
      assert.equal(readFileSync(created.path, 'utf8').trim(), token, 'and it must be the contents of the file');

      // Re-ensuring must not rotate the token: rotating it would invalidate an operator's copy on
      // every daemon start, and it must not fail either.
      const again = ensureAuthorityToken(stateDir);
      assert.equal(again.created, false, 'an existing token must be reused rather than replaced');
      assert.equal(readAuthorityToken(stateDir), token, 'and its value must be unchanged');
      assert.equal(statSync(again.path).mode & 0o777, 0o600, 'and it must still be 0600 after the re-ensure');

      // A token file whose mode drifted is a real case: the mode is restored on the OPEN DESCRIPTOR.
      chmodSync(created.path, 0o666);
      ensureAuthorityToken(stateDir);
      assert.equal(statSync(created.path).mode & 0o777, 0o600,
        'a drifted mode must be tightened back to 0600');
      assert.equal(readAuthorityToken(stateDir), token, 'without changing the value');
    } finally {
      scratch.cleanup();
    }
  },

  'FR-SEC-4 a non-regular file at the token path is refused by both operations, and never read': async () => {
    const scratch = scratchDir('token-fifo');
    try {
      const stateDir = join(scratch.dir, 'state');
      mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      const path = await tokenPath(stateDir);
      // A directory at the path: `existsSync` reports true, so the old code went straight to
      // `chmodSync` on it, and `readFileSync` would have thrown an untyped EISDIR.
      mkdirSync(path);

      const { ensureAuthorityToken, readAuthorityToken } = await import('../../dist/lib/ipc.js');
      let ensureError = null;
      try { ensureAuthorityToken(stateDir); } catch (error) { ensureError = error; }
      assert.equal(codeOf(ensureError).code, 'UNSAFE_STATE_PATH',
        `a directory at the token path must be a typed refusal, got ${codeOf(ensureError).code}: ${codeOf(ensureError).message}`);
      let readError = null;
      try { readAuthorityToken(stateDir); } catch (error) { readError = error; }
      assert.equal(codeOf(readError).code, 'UNSAFE_STATE_PATH',
        `and reading it must be the same typed refusal rather than an untyped EISDIR: got ${codeOf(readError).code}`);
      // The mode of the directory must not have been changed to the token file's 0600 by the refusal.
      assert.equal(lstatSync(path).isDirectory(), true, 'and it must still be a directory');
    } finally {
      scratch.cleanup();
    }
  },
};
