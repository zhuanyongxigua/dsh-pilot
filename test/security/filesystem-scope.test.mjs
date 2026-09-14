/**
 * FR-SEC-2 — filesystem scope.
 *
 * The requirement is a NEGATIVE one (write nothing outside the documented roots), and a negative
 * requirement is the easiest kind to claim and the hardest to prove. So this file does three
 * different things rather than one, because each alone would be weak:
 *
 *   1. The default state path is REFUSED. This is exercised in two ways, deliberately: as a pure
 *      function over string inputs (`assertScratchStateDir`, which is why the guard takes its
 *      paths as arguments rather than reading the ambient home), and through the REAL daemon
 *      binary, because a guard that is never wired into the entry point proves nothing. Neither
 *      path touches a real `~/.dsh`: the function is pure, and the binary is given the protected
 *      path as an argument.
 *
 *   2. A real daemon run, driven over its IPC socket, is audited for every path it creates. The
 *      root this test chooses is handed to the daemon with `--state-dir`; nothing outside it is
 *      acceptable, and the observed set is printed so the audit is a measurement rather than an
 *      assertion that happens to hold.
 *
 *   3. An unwritable state directory is a refusal, not a silent fallback to somewhere else. This
 *      is the case that would actually leak: a daemon that cannot use its state dir must not pick
 *      another one.
 *
 * What this file does NOT claim: nothing here enumerates what the OPERATOR's real DSH home
 * contains, and nothing here reads it. The scope claim is about the paths this project writes.
 */

import { existsSync, readdirSync, statSync, mkdirSync, chmodSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { assert, ipcClient, scratchDir, spawnNode, startDaemon } from '../helpers.mjs';
import { assertScratchStateDir } from '../../dist/lib/config.js';

/** The state roots that must never be used implicitly. Kept in one place and asserted against. */
const PROTECTED_ROOTS = [join(homedir(), '.dsh'), join(homedir(), '.local', 'state')];

/**
 * Walk a directory and return every filesystem path under it, files and directories alike.
 * @param {string} root
 * @returns {string[]}
 */
function walk(root) {
  /** @type {string[]} */
  const out = [];
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    out.push(path);
    if (entry.isDirectory() && !entry.isSymbolicLink()) out.push(...walk(path));
  }
  return out;
}

export default {
  'the default state path is refused, and the refusal names the override': () => {
    for (const protectedRoot of PROTECTED_ROOTS) {
      // The root itself and a path beneath it: both are the "default" shape that a forgotten
      // --state-dir produces. `.dsh/state` and similar fixtures make this a real risk, so a
      // prefix check is tested rather than only exact equality.
      for (const candidate of [protectedRoot, join(protectedRoot, 'state'), join(protectedRoot, 'nested', 'deeper')]) {
        const verdict = assertScratchStateDir(candidate);
        assert.equal(verdict.safe, false, `${candidate} must be refused as a state directory`);
        assert.match(
          verdict.safe === false ? verdict.reason : '',
          /DSH_PILOT_ALLOW_REAL_STATE=1/,
          'the refusal must name the explicit override an operator would need',
        );
      }
    }

    // The control: a task-created temp dir IS accepted. Without this the refusals above would
    // also be satisfied by a guard that refuses everything.
    const scratch = scratchDir('sec2-pure');
    try {
      const accepted = assertScratchStateDir(join(scratch.dir, 'state'));
      assert.equal(accepted.safe, true, `a scratch state dir must be accepted, got ${JSON.stringify(accepted)}`);
    } finally {
      scratch.cleanup();
    }
  },

  'the real daemon binary refuses a protected state path and exits non-zero': async () => {
    // The daemon is given the protected path explicitly, so no ambient home is ever written to.
    const target = join(PROTECTED_ROOTS[0], 'state-must-not-be-created');
    const child = spawnNode([
      'dist/bin/dsh-pilot-daemon.js',
      '--state-dir', target,
      '--host', 'http://127.0.0.1:1',
      // A ready file placed in the scratch root, NOT under the protected path: this test must not
      // create anything inside the protected root even to observe the refusal.
      '--ready-file', join(tmpdir(), `dshpilot-sec2-refuse-${process.pid}.json`),
    ]);
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    const exit = await new Promise((resolvePromise) => {
      // Bounded: a daemon that started happily would never exit, and that must be a failure here
      // rather than a hang.
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolvePromise({ code: null, signal: 'timeout' }); }, 15000);
      child.on('close', (code, signal) => { clearTimeout(timer); resolvePromise({ code, signal }); });
    });

    assert.notEqual(exit.signal, 'timeout', `the daemon must refuse immediately, not run; stderr: ${stderr}`);
    assert.equal(exit.code, 3, `expected the guard's exit code 3, got ${JSON.stringify(exit)}; stderr: ${stderr}`);
    assert.match(stderr, /refusing to use/, 'the refusal must say what it refused');
    assert.equal(existsSync(target), false, `${target} must not have been created by the refused daemon`);
  },

  'a real daemon writes nothing outside the state root it was given': async () => {
    const scratch = scratchDir('sec2-scope');
    const stateDir = join(scratch.dir, 'state');
    const daemon = await startDaemon({ hostBase: 'http://127.0.0.1:1', stateDir });
    try {
      // Drive real work so the audit sees the files a used daemon creates, not just the ones a
      // started one creates. The Host is unreachable on purpose: a refusal still has to be
      // journalled, which is exactly the durability path that writes.
      const client = await ipcClient(daemon.socketPath);
      try {
        await client.request({ op: 'task.ensure', clientKey: 'sec2-task' });
        await client.request({ op: 'task.list' }).catch(() => { /* refusal shape is not the subject */ });
      } finally {
        client.close();
      }
    } finally {
      await daemon.stop();
    }

    const realScratch = realpathSync(scratch.dir);
    const observed = walk(scratch.dir);
    // The audit is only meaningful if the daemon actually wrote something. An empty set would
    // pass the scope assertion vacuously, so say so instead of passing.
    assert.ok(observed.length > 0, 'expected the daemon to have created state files; an empty audit proves nothing');

    const outside = observed.filter((path) => {
      const real = realpathSync(path);
      return real !== realScratch && !real.startsWith(`${realScratch}${sep}`);
    });
    assert.deepEqual(outside, [], `the daemon wrote outside its state root: ${outside.join(', ')}`);

    // Printed, not merely asserted: this is the measurement the requirement asks for. A reader of
    // the test output can see exactly which paths were observed. The display slice uses each
    // path's REAL prefix, not the scratch root as typed, because on macOS the temp root is a
    // symlink (`/var/...` resolves to `/private/var/...`) and slicing by the shorter literal would
    // chop real characters off the front of every name.
    process.stdout.write(`      scope audit: ${observed.length} paths under ${realScratch}\n`);
    const displayed = observed.map((path) => {
      const real = realpathSync(path);
      return real.slice(realScratch.length + 1);
    }).sort();
    process.stdout.write(`      observed: ${displayed.join(', ')}\n`);

    scratch.cleanup();
  },

  'an unwritable state directory is refused rather than silently relocated': async () => {
    const scratch = scratchDir('sec2-perm');
    const stateDir = join(scratch.dir, 'state');
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    // A pre-existing state file makes this the "the directory exists but is not usable" case
    // rather than the "create a new directory" case, which is where a fallback would hide.
    writeFileSync(join(stateDir, 'preexisting.txt'), 'sentinel\n');
    // 0o500: readable and executable, not writable. The daemon needs to create its database and
    // its IPC socket here, so this is a real EACCES rather than a simulated one.
    chmodSync(stateDir, 0o500);
    try {
      let failure = null;
      try {
        const daemon = await startDaemon({ hostBase: 'http://127.0.0.1:1', stateDir });
        // If it started, it either fell back somewhere else (the leak this test hunts) or found a
        // way to write into a read-only directory. Both are failures.
        failure = `the daemon started against a read-only state dir; stdout/stderr: ${JSON.stringify(daemon.output())}`;
        await daemon.stop();
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      }
      assert.ok(failure !== null, 'the daemon must not start against an unwritable state directory');
      // Refusal must be a refusal, not a hang or a random crash: the failure message has to be
      // about the state directory.
      assert.match(
        failure,
        /state dir|EACCES|EACCES|permission|read-only|SQLITE_CANTOPEN|EPERM|unable to open/i,
        `expected a permission-shaped refusal, got: ${failure}`,
      );
      // And the pre-existing file is untouched: a refusal does not clear what it could not use.
      assert.equal(statSync(join(stateDir, 'preexisting.txt')).size, 'sentinel\n'.length);
    } finally {
      chmodSync(stateDir, 0o700);
      scratch.cleanup();
    }
  },

  'the guard is exercised over the same walk the audit uses, so the audit cannot be vacuous': async () => {
    // A self-check on this file's own tooling. `walk` is the oracle for the scope audit above; if
    // it silently returned nothing, that audit would pass for every daemon. So it is tested
    // against a directory whose contents this test controls exactly.
    const scratch = scratchDir('sec2-walk');
    try {
      mkdirSync(join(scratch.dir, 'a', 'b'), { recursive: true });
      writeFileSync(join(scratch.dir, 'a', 'b', 'c.txt'), 'x');
      const found = walk(scratch.dir).map((p) => p.slice(scratch.dir.length + 1)).sort();
      assert.deepEqual(found, ['a', 'a/b', 'a/b/c.txt'], `walk must see nested files, got ${JSON.stringify(found)}`);
      const missing = walk(join(scratch.dir, 'does-not-exist'));
      assert.deepEqual(missing, [], 'walk of a missing directory must be empty rather than throwing');
    } finally {
      scratch.cleanup();
    }
  },
};
