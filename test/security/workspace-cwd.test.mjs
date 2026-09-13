/**
 * The workspace (`cwd`) boundary: WORK item 9, FR-SEC-4's `cwd` half and FR-SESS-6.
 *
 * Why these tests exist: `cwd` is the one caller-supplied value this bridge hands to a component that runs
 * tools inside it, and a path is a NAME, not a directory. A recorded path can be deleted, replaced by a
 * file, or replaced by a SYMLINK to somewhere else between the moment a session is created and the moment
 * work is dispatched into it — and then the Host runs the turn in a directory the bridge never recorded and
 * the caller never chose. This is the escape the requirement is about, and it is reachable entirely with a
 * real filesystem and no Host cooperation, so every case below is a real symlink in this task's own temp
 * directory.
 *
 * The oracle for "no prompt was sent" is the fake Host's received-request log, not our own reply: a
 * refusal that still dispatched would produce the same error message and a different Host, which is exactly
 * the failure mode this layer must be able to see.
 */

import { join } from 'node:path';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { assert, ipcClient, scratchDir, startDaemon } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/**
 * A refusal from the daemon is a coded BridgeError; these assertions read that code.
 * @typedef {import('../../dist/lib/errors.js').BridgeError} BridgeError
 */

/** @param {unknown} error */
function codeOf(error) {
  return /** @type {BridgeError} */ (error);
}

async function rig(label) {
  const host = await new FakeHost().start();
  const scratch = scratchDir(label);
  const stateDir = join(scratch.dir, 'state');
  const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir });
  const teardown = async () => {
    await daemon.stop();
    await host.stop();
    scratch.cleanup();
  };
  return { host, daemon, scratch, teardown };
}

export default {
  'a cwd that is a symlink is recorded and dispatched as the directory it resolves to': async () => {
    const { host, daemon, scratch, teardown } = await rig('ws-resolve');
    let client = null;
    try {
      const real = join(scratch.dir, 'real-workspace');
      const link = join(scratch.dir, 'link-to-workspace');
      mkdirSync(real);
      symlinkSync(real, link, 'dir');

      client = await ipcClient(daemon.socketPath);
      const task = await client.request({ op: 'task.ensure', clientKey: 'ws-task' });
      const session = await client.request({
        op: 'session.start', taskId: task.task.taskId, clientKey: 'ws-session', cwd: link,
      });

      // The Host is told the DIRECTORY, not the name that pointed at it. This is the "resolved safely" half
      // of the requirement: what the turn will run inside is the directory, whichever name was used.
      const creates = host.requestsFor('session.create');
      assert.equal(creates.length >= 1, true, 'session.create must have reached the Host');
      /** @type {{payload?: {cwd?: string}}} */
      const last = creates[creates.length - 1] ?? {};
      const sent = last.payload ?? {};
      assert.equal(sent.cwd, realpathSync(real),
        `the Host must receive the resolved directory, got ${String(sent.cwd)}`);
      assert.equal(sent.cwd === link, false, 'the Host must not be handed the symlink itself');
      // And the bridge records the same thing it sent, so the re-verification below has something to compare.
      assert.equal(session.session.cwd, realpathSync(real),
        'the recorded workspace must be the resolved directory too');
      assert.equal(sent.cwd === session.session.cwd, true, 'the record and the request must agree');
    } finally {
      if (client) client.close();
      await teardown();
    }
  },

  'a cwd that does not exist, is relative, or is not a directory is refused before anything is sent': async () => {
    const { host, daemon, scratch, teardown } = await rig('ws-refuse');
    let client = null;
    try {
      const file = join(scratch.dir, 'not-a-directory.txt');
      writeFileSync(file, 'a file, not a workspace\n');
      client = await ipcClient(daemon.socketPath);
      const task = await client.request({ op: 'task.ensure', clientKey: 'ws-task' });

      const cases = [
        { key: 'missing', label: 'a path that does not exist', cwd: join(scratch.dir, 'does-not-exist'), refusal: 'not-found' },
        { key: 'file', label: 'a file, not a directory', cwd: file, refusal: 'not-a-directory' },
        { key: 'relative', label: 'a relative path', cwd: 'relative/path', refusal: 'not-absolute' },
      ];
      for (const one of cases) {
        const before = host.requestsFor('session.create').length;
        const error = await client.request({
          op: 'session.start', taskId: task.task.taskId, clientKey: `ws-${one.key}`, cwd: one.cwd,
        }).then(() => { throw new Error(`${one.label}: an unusable cwd must be refused`); }, (thrown) => thrown);
        assert.equal(codeOf(error).code, 'WORKSPACE_UNSAFE',
          `${one.label}: expected WORKSPACE_UNSAFE, got ${codeOf(error).code}: ${codeOf(error).message}`);
        assert.equal(/** @type {{details?: {refusal?: string}}} */ (error).details?.refusal, one.refusal,
          `${one.label}: the refusal must say why, so a caller can fix the argument`);
        // Nothing reached the Host: the check happens before the intent is reserved or sent, so there is no
        // half-created session on the Host for a later call to trip over.
        assert.equal(host.requestsFor('session.create').length, before,
          `${one.label}: a refused cwd must not produce a session.create`);
      }
    } finally {
      if (client) client.close();
      await teardown();
    }
  },

  'a workspace replaced by a symlink to another directory is refused before dispatch, and no prompt is sent': async () => {
    // THE REGRESSION for FR-SEC-4's cwd half. The directory the session was created in still EXISTS under
    // the same name — it is just no longer the same directory. A check that only asked "does this path
    // exist?" would pass, and the turn would run in the attacker-chosen target with the caller's text.
    const { host, daemon, scratch, teardown } = await rig('ws-swap');
    let client = null;
    try {
      const workspace = join(scratch.dir, 'workspace');
      const elsewhere = join(scratch.dir, 'elsewhere');
      mkdirSync(workspace);
      mkdirSync(elsewhere);
      client = await ipcClient(daemon.socketPath);
      const task = await client.request({ op: 'task.ensure', clientKey: 'ws-task' });
      const session = await client.request({
        op: 'session.start', taskId: task.task.taskId, clientKey: 'ws-session', cwd: workspace,
      });
      assert.equal(session.session.cwd, realpathSync(workspace), 'the workspace must start out resolved');

      // The swap: the recorded name is removed and replaced by a link to a different real directory.
      rmSync(workspace, { recursive: true, force: true });
      symlinkSync(elsewhere, workspace, 'dir');
      assert.equal(realpathSync(workspace), realpathSync(elsewhere),
        'the fixture must actually be pointing somewhere else, or this case proves nothing');

      const promptsBefore = host.requestsFor('session.prompt').length;
      const error = await client.request({
        op: 'session.prompt', taskId: task.task.taskId, sessionId: session.session.sessionId,
        text: 'run something in the workspace', clientKey: 'ws-prompt',
      }).then(() => { throw new Error('a swapped workspace must refuse the dispatch'); }, (thrown) => thrown);
      assert.equal(codeOf(error).code, 'WORKSPACE_CHANGED',
        `expected WORKSPACE_CHANGED, got ${codeOf(error).code}: ${codeOf(error).message}`);
      assert.equal(/** @type {{details?: {refusal?: string}}} */ (error).details?.refusal, 'path-changed',
        'the refusal must distinguish "a different directory" from "gone"');
      assert.equal(host.requestsFor('session.prompt').length, promptsBefore,
        'NO prompt may reach the Host when the workspace moved');
      // And the session is still usable for the calls that do not dispatch work into the workspace, so the
      // refusal is narrowly about the dispatch rather than a session-wide wedge.
      const state = await client.request({ op: 'session.state', taskId: task.task.taskId, sessionId: session.session.sessionId });
      assert.equal(typeof state.connection, 'string', 'reading session state must still work');
    } finally {
      if (client) client.close();
      await teardown();
    }
  },

  'a workspace that was deleted, or replaced by a file, is refused before dispatch and no prompt is sent': async () => {
    const { host, daemon, scratch, teardown } = await rig('ws-gone');
    let client = null;
    try {
      client = await ipcClient(daemon.socketPath);
      const task = await client.request({ op: 'task.ensure', clientKey: 'ws-task' });
      const shapes = [
        { key: 'deleted', label: 'the directory was deleted', refusal: 'not-found', damage: (dir) => rmSync(dir, { recursive: true, force: true }) },
        {
          key: 'file',
          label: 'the directory was replaced by a file',
          // A file at the same name still RESOLVES to that name, so it is not a path change: it is the
          // directory check that catches it, and the refusal says so. Asserted as measured rather than as
          // guessed, because the distinction is what a caller branches on.
          refusal: 'no-longer-a-directory',
          damage: (dir) => { rmSync(dir, { recursive: true, force: true }); writeFileSync(dir, 'now a file\n'); },
        },
      ];
      for (const shape of shapes) {
        const workspace = join(scratch.dir, `workspace-${shape.key}`);
        mkdirSync(workspace);
        const session = await client.request({
          op: 'session.start', taskId: task.task.taskId, clientKey: `ws-${shape.key}`, cwd: workspace,
        });
        shape.damage(workspace);
        const promptsBefore = host.requestsFor('session.prompt').length;
        const error = await client.request({
          op: 'session.prompt', taskId: task.task.taskId, sessionId: session.session.sessionId,
          text: 'work', clientKey: `ws-prompt-${shape.key}`,
        }).then(() => { throw new Error(`${shape.label}: the dispatch must be refused`); }, (thrown) => thrown);
        assert.equal(codeOf(error).code, 'WORKSPACE_CHANGED',
          `${shape.label}: expected WORKSPACE_CHANGED, got ${codeOf(error).code}`);
        assert.equal(/** @type {{details?: {refusal?: string}}} */ (error).details?.refusal, shape.refusal,
          `${shape.label}: the refusal must say which way it changed`);
        assert.equal(host.requestsFor('session.prompt').length, promptsBefore,
          `${shape.label}: no prompt may reach the Host`);
      }
    } finally {
      if (client) client.close();
      await teardown();
    }
  },

  'a workspace that is still the same directory dispatches normally, and a session with no recorded cwd is unaffected': async () => {
    // The control for the three cases above. A refusal check that also refuses the ordinary path would make
    // the previous cases pass while breaking the product, and the only way to tell those apart is to assert
    // that the ordinary path still works — end to end, with the prompt actually reaching the Host.
    const { host, daemon, scratch, teardown } = await rig('ws-ok');
    let client = null;
    try {
      const workspace = join(scratch.dir, 'workspace');
      mkdirSync(workspace);
      client = await ipcClient(daemon.socketPath);
      const task = await client.request({ op: 'task.ensure', clientKey: 'ws-task' });

      const withCwd = await client.request({
        op: 'session.start', taskId: task.task.taskId, clientKey: 'ws-with', cwd: workspace,
      });
      await client.request({
        op: 'session.prompt', taskId: task.task.taskId, sessionId: withCwd.session.sessionId,
        text: 'ordinary work', clientKey: 'ws-prompt-with',
      });
      assert.equal(host.requestsFor('session.prompt').length, 1, 'an unchanged workspace must dispatch');

      const withoutCwd = await client.request({
        op: 'session.start', taskId: task.task.taskId, clientKey: 'ws-without',
      });
      assert.equal(withoutCwd.session.cwd, null, 'a session created without a cwd records none');
      await client.request({
        op: 'session.prompt', taskId: task.task.taskId, sessionId: withoutCwd.session.sessionId,
        text: 'ordinary work', clientKey: 'ws-prompt-without',
      });
      assert.equal(host.requestsFor('session.prompt').length, 2,
        'a session with no recorded workspace must not be blocked by a check about a workspace it never had');
    } finally {
      if (client) client.close();
      await teardown();
    }
  },
};
