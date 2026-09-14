/**
 * The `label` argument of `dsh_task_ensure`, which was accepted and then dropped.
 *
 * Why this file exists: the MCP tool's own schema advertises `label` as an "Optional human label" with a
 * 120-character limit, the handler forwards it, and the daemon ignored it. Every client that set one got
 * a task whose label was the INTERNAL lookup key — `task:default` — back. An argument that appears in a
 * tool's schema and does nothing is worse than one that is absent, because the caller has been told the
 * bridge understands it.
 *
 * The label is not the same thing as the key that makes `task.ensure` idempotent, and that is the part
 * worth testing rather than the string plumbing: if the caller's label were stored in the column the
 * lookup matches on, a second `task.ensure` with the same client key and a different label would fail to
 * find the task it had just created and would create a SECOND one. The cases below hold both halves at
 * once — the label comes back, and the client key still decides identity.
 */

import { join } from 'node:path';
import { assert, ipcClient, scratchDir, startDaemon, waitFor } from '../helpers.mjs';
import { FakeHost } from '../fixtures/fake-host.mjs';

/**
 * A fake Host and a real daemon over a fresh state directory.
 * @param {string} label
 */
async function rig(label) {
  const host = await new FakeHost().start();
  const scratch = scratchDir(`task-label-${label}`);
  const stateDir = join(scratch.dir, 'state');
  const daemon = await startDaemon({ hostBase: host.baseUrl, stateDir });
  const client = await ipcClient(daemon.socketPath);
  await waitFor(async () => (await client.request({ op: 'health' })).connection === 'ready',
    { timeoutMs: 10_000, what: `[${label}] the daemon mux downlink to reach ready` });
  return {
    client,
    stateDir,
    teardown: async () => {
      try { client.close(); } catch { /* already closed */ }
      await daemon.stop();
      await host.stop();
      scratch.cleanup();
    },
  };
}

export default {
  'a task label supplied by the caller comes back on the task, instead of the internal lookup key': async () => {
    const r = await rig('honoured');
    try {
      const label = 'deploy 检查 😀';
      const ensured = /** @type {{task?: {taskId?: string, label?: string}, created?: boolean}} */ (
        await r.client.request({ op: 'task.ensure', clientKey: 'c1', label }));
      assert.equal(ensured.created, true, 'the first call creates the task');
      assert.equal(ensured.task?.label, label, 'and the label the caller supplied is the one it reads back');
      assert.ok(!String(ensured.task?.label).startsWith('task:'),
        'and not the internal key, which is not something a caller asked for');

      // DURABLE, not merely echoed: a second call finds the task and reports the same label.
      const again = /** @type {{task?: {taskId?: string, label?: string}, created?: boolean}} */ (
        await r.client.request({ op: 'task.ensure', clientKey: 'c1', label }));
      assert.equal(again.created, false, 'the second call finds the task');
      assert.equal(again.task?.taskId, ensured.task?.taskId, 'the same task');
      assert.equal(again.task?.label, label, 'with the same label, read from the store rather than from the frame');
    } finally {
      await r.teardown();
    }
  },

  'the client key still decides identity: a second call with a different label returns the same task': async () => {
    // The defect a naive implementation introduces. If the caller's label were written into the column
    // that `task.ensure` matches on, this call would not find the task and would create a second one, so
    // the bridge would report two tasks for one client key — and the client key is the whole basis of the
    // idempotency this operation promises.
    const r = await rig('identity');
    try {
      const first = /** @type {{task?: {taskId?: string, label?: string}}} */ (
        await r.client.request({ op: 'task.ensure', clientKey: 'same-key', label: 'the first label' }));
      const second = /** @type {{task?: {taskId?: string, label?: string}, created?: boolean}} */ (
        await r.client.request({ op: 'task.ensure', clientKey: 'same-key', label: 'a different label' }));
      assert.equal(second.created, false, 'the second call must find the task the first one created');
      assert.equal(second.task?.taskId, first.task?.taskId, 'and it must be the same task');
      // The label is set at creation and not renamed by a later ensure, which is what "ensure" means:
      // it makes the task exist, it does not edit it. Stated here because the reply is where a caller
      // would notice the difference.
      assert.equal(second.task?.label, 'the first label', 'and the label is the one the task was created with');

      // The independent oracle: one task row, not two, read from the durable state rather than a reply.
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(join(r.stateDir, 'state.sqlite'), { readOnly: true });
      try {
        const rows = /** @type {{task_id: string, label: string|null, display_label: string|null}[]} */ (
          db.prepare('select task_id, label, display_label from tasks').all());
        assert.equal(rows.length, 1, `one client key must be one task row, got ${rows.length}`);
        assert.equal(rows[0]?.display_label, 'the first label', 'and the row carries the caller label');
        assert.equal(rows[0]?.label, 'task:same-key',
          'while the internal lookup key is still the client key, which is what makes the next ensure idempotent');
      } finally {
        db.close();
      }
    } finally {
      await r.teardown();
    }
  },

  'a label that cannot be one is refused rather than coerced or silently cut': async () => {
    const r = await rig('refused');
    try {
      // A number is not a label. The frame is parsed JSON, so this is a value of the wrong type rather
      // than a malformed frame, and inventing a string from it would be answering a question the caller
      // did not ask.
      const wrongType = await r.client.request({ op: 'task.ensure', clientKey: 'c1', label: 7 }).then(
        () => { throw new Error('a non-string label must not be accepted'); },
        (thrown) => thrown,
      );
      assert.equal(wrongType.code, 'BAD_REQUEST', `a non-string label must be refused, got ${wrongType.code}`);

      // Longer than the tool schema advertises. Cut silently, a caller would see a label it did not send
      // and would have no way to know the bridge had edited it.
      const long = 'x'.repeat(121);
      const tooLong = await r.client.request({ op: 'task.ensure', clientKey: 'c2', label: long }).then(
        () => { throw new Error('an over-long label must not be accepted'); },
        (thrown) => thrown,
      );
      assert.equal(tooLong.code, 'BAD_REQUEST', `an over-long label must be refused, got ${tooLong.code}`);
      assert.equal(tooLong.details?.length, 121, 'and the refusal must say how long the label was');

      // The positive control: exactly at the limit is accepted, so the limit is a bound and not a ban.
      const atLimit = /** @type {{task?: {label?: string}}} */ (
        await r.client.request({ op: 'task.ensure', clientKey: 'c3', label: 'y'.repeat(120) }));
      assert.equal(atLimit.task?.label, 'y'.repeat(120), 'a label exactly at the limit must be accepted whole');
    } finally {
      await r.teardown();
    }
  },
};
