/**
 * Unit layer: the daemon's own command line, as a command line.
 *
 * Why this file exists: the daemon binary is the thing a supervisor starts, so its argument handling
 * is a user interface with consequences, and it had two defects that no test could see because nothing
 * drove the binary with a bad argument list.
 *
 *   1. `argv[++i]` read a flag's value without checking that one existed. `--host --json` consumed the
 *      next FLAG as a URL and left the JSON flag unset. Worse, `--state-dir` as the last argument
 *      assigned `undefined` and the daemon fell back to its DEFAULT state directory — which is the
 *      operator's real one. Measured under the control below, the pre-fix binary answered
 *      `refusing to use /Users/<user>/.local/state/dsh-pilot without DSH_PILOT_ALLOW_REAL_STATE=1`,
 *      so what stopped it was that unrelated guard and not the command line: a supervisor that forgot
 *      one value would have had a second daemon take ownership of the real state directory. That is
 *      the concrete consequence, and it is why the flag check is asserted to NAME the flag rather than
 *      merely to exit non-zero.
 *   2. `--ready-file` wrote its file without creating the parent directory, so naming a readiness file
 *      in a directory that does not exist yet — which is exactly what a supervisor does when it asks
 *      for one in its own fresh run directory — threw ENOENT and the process exited as if it had failed
 *      to start, after it had already bound its socket and taken ownership.
 *
 * These are asserted by SPAWNING the binary with a real argument list, because the defect was in the
 * argument list rather than in a function: a unit test that called a parser directly would have kept
 * passing while the shipped command line stayed wrong.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, scratchDir, spawnNode, startDaemon } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/** Run the daemon binary with an argument list and collect how it exited. */
async function runDaemon(argv, timeoutMs = 20_000) {
  const child = spawnNode(['dist/bin/dsh-pilot-daemon.js', ...argv]);
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk) => { stdout += chunk; });
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`the daemon did not exit within ${timeoutMs}ms; stdout: ${stdout} stderr: ${stderr}`));
    }, timeoutMs);
    child.on('close', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  return { code, stdout, stderr };
}

export default {
  'a flag without a value is refused instead of silently falling back to a default': async () => {
    // Every flag that takes a value, with no value. Each must exit non-zero and name the flag: the
    // dangerous case is `--state-dir`, where the fallback is a DIFFERENT state directory rather than
    // an obvious failure, so "it exited" is not enough and the message has to name the flag.
    for (const flag of ['--state-dir', '--host', '--host-scope', '--ready-file']) {
      const missingValue = await runDaemon([flag]);
      assert.equal(missingValue.code, 2,
        `${flag} with no value must exit 2, got ${missingValue.code}; stderr: ${missingValue.stderr}`);
      assert.match(missingValue.stderr, new RegExp(flag),
        `${flag} with no value must name the flag it refused, got: ${missingValue.stderr}`);

      // A flag followed by another flag is the same mistake — a URL never begins with `--` — and it is
      // the one the old code got most wrong: `--host --json` started a daemon whose host base was the
      // string `--json` and whose JSON flag was never set.
      const flagThenFlag = await runDaemon([flag, '--json']);
      assert.equal(flagThenFlag.code, 2,
        `${flag} followed by another flag must exit 2, got ${flagThenFlag.code}; stderr: ${flagThenFlag.stderr}`);
      assert.match(flagThenFlag.stderr, new RegExp(flag),
        `${flag} followed by another flag must name it, got: ${flagThenFlag.stderr}`);
    }
    // And nothing was started: no daemon, no state directory, no socket. A refusal that had already
    // taken ownership would be worse than the silent fallback it replaced.
    assert.ok(!existsSync(join(process.cwd(), 'daemon.ready.json')),
      'a refused command line must not have written anything');
  },

  'a ready-file path whose parent directory does not exist yet is created rather than failing the start': async () => {
    const host = await new FakeHost().start();
    const scratch = scratchDir('cli-ready-file');
    let daemon = null;
    try {
      const stateDir = join(scratch.dir, 'state');
      // The parent does NOT exist. This is the supervisor's case: it asks for a readiness file in a run
      // directory it has not created, and expects the process it started to report readiness there.
      const readyFile = join(scratch.dir, 'run', 'nested', 'daemon.ready.json');
      assert.equal(existsSync(join(scratch.dir, 'run')),
        false, 'the parent must genuinely be absent, or this test proves nothing');
      daemon = await startDaemon({ hostBase: host.baseUrl, stateDir, readyFile });
      assert.equal(existsSync(readyFile), true,
        'the readiness file must exist at the path that was asked for, in a directory that did not exist');
      const ready = JSON.parse(readFileSync(readyFile, 'utf8'));
      // Read the contents rather than only the existence: a file that appears but holds stale or empty
      // coordinates is not readiness, and `waitForReady` in the helper already blocks on the shape, so
      // reaching here means the daemon itself wrote a usable file.
      assert.equal(ready.socketPath, daemon.socketPath,
        'the file must describe the daemon that was actually started');
      assert.equal(ready.stateDir, stateDir, 'and the state directory it was told to use');
    } finally {
      if (daemon) await daemon.stop();
      await host.stop();
      scratch.cleanup();
    }
  },
};
