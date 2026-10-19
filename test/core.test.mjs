import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  emptyTrash,
  listEntries,
  purgeEntry,
  resolveRoots,
  restoreEntry,
  trashBatch,
  MAX_BATCH,
  trashSession,
  TrashError,
} from '../core.js';

const PROJECT = '--Users-magi-work--';

async function scratch() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-trash-'));
  const roots = resolveRoots({ DSH_HOME: home });
  await mkdir(join(roots.sessionsRoot, PROJECT), { recursive: true });
  return { home, roots };
}

async function seedSession(roots, sessionId, { projectDir = PROJECT, bytes = 100 } = {}) {
  const dir = join(roots.sessionsRoot, projectDir, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x'.repeat(bytes));
  await writeFile(join(dir, 'session.lock'), '');
  return dir;
}

function fakeDeps({ headers = [], live = [], running = [], workspaces = [], archived = [], pinned = [] } = {}) {
  const log = { attached: [], detached: [], inserted: [], archived: [], unarchived: [], pinned: [] };
  return {
    log,
    deps: {
      async isLive(id) {
        return live.includes(id);
      },
      async isRunning(id) {
        return running.includes(id);
      },
      async allHeaders() {
        return headers;
      },
      workspaceFor(id) {
        return workspaces.find((workspace) => workspace.sessionIds.includes(id));
      },
      workspaceById(id) {
        return workspaces.find((workspace) => workspace.id === id);
      },
      async detach(workspaceId, id) {
        log.detached.push([workspaceId, id]);
        const workspace = workspaces.find((entry) => entry.id === workspaceId);
        workspace.sessionIds = workspace.sessionIds.filter((value) => value !== id);
      },
      async attach(workspaceId, id) {
        log.attached.push([workspaceId, id]);
        const workspace = workspaces.find((entry) => entry.id === workspaceId);
        if (!workspace.sessionIds.includes(id)) workspace.sessionIds.unshift(id);
      },
      async insertBefore(workspaceId, id, beforeId) {
        log.inserted.push([workspaceId, id, beforeId]);
        const workspace = workspaces.find((entry) => entry.id === workspaceId);
        const without = workspace.sessionIds.filter((value) => value !== id);
        const at = beforeId ? without.indexOf(beforeId) : without.length;
        workspace.sessionIds = [...without.slice(0, at), id, ...without.slice(at)];
      },
      archivedIds() {
        return archived;
      },
      pinnedIds() {
        return pinned;
      },
      async archive(id) {
        log.archived.push(id);
        // Archive keeps every Workspace accounting slot exactly as it was.
        if (!archived.includes(id)) archived.push(id);
      },
      async unarchive(id) {
        log.unarchived.push(id);
        const at = archived.indexOf(id);
        if (at >= 0) archived.splice(at, 1);
      },
      async pin(id) {
        log.pinned.push(id);
      },
      async readTitle() {
        return undefined;
      },
    },
  };
}

test('trash moves the log, archives the row and records a restorable entry', async () => {
  const { roots } = await scratch();
  const dir = await seedSession(roots, 'session-aaa', { bytes: 2048 });
  const workspaces = [{ id: 'ws-1', title: 'work', path: '/work', sessionIds: ['session-aaa', 'session-bbb'] }];
  const { deps, log } = fakeDeps({
    headers: [{ id: 'session-aaa', cwd: '/work', parentSession: undefined }],
    workspaces,
  });

  const result = await trashSession({ sessionId: 'session-aaa', title: 'A title', roots, deps });

  assert.equal(existsSync(dir), false);
  assert.deepEqual(log.archived, ['session-aaa']);
  // The accounting slot survives: that is what keeps the row out of "未分组"
  // and what lets a restore land in its recorded position.
  assert.deepEqual(log.detached, []);
  assert.deepEqual(workspaces[0].sessionIds, ['session-aaa', 'session-bbb']);

  const entries = await listEntries(roots);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, result.entry.id);
  assert.equal(entries[0].sessionId, 'session-aaa');
  assert.equal(entries[0].title, 'A title');
  assert.equal(entries[0].workspacePath, '/work');
  assert.ok(entries[0].bytes > 2000);
  assert.equal(entries[0].incomplete, false);
});

test('trash carries subagent descendants and restore puts every directory back', async () => {
  const { roots } = await scratch();
  const parent = await seedSession(roots, 'session-parent');
  const child = await seedSession(roots, 'child-1');
  const grandchild = await seedSession(roots, 'child-2');
  const workspaces = [{ id: 'ws-1', title: 'work', path: '/work', sessionIds: ['session-parent', 'child-1', 'child-2'] }];
  const { deps, log } = fakeDeps({
    headers: [
      { id: 'session-parent', cwd: '/work' },
      { id: 'child-1', cwd: '/work', parentSession: 'session-parent' },
      { id: 'child-2', cwd: '/work', parentSession: 'child-1' },
    ],
    workspaces,
  });

  const { entry } = await trashSession({ sessionId: 'session-parent', roots, deps });
  assert.equal(entry.sessionCount, 3);
  assert.equal(entry.subagentCount, 2);
  for (const dir of [parent, child, grandchild]) assert.equal(existsSync(dir), false);
  assert.deepEqual(log.archived, ['session-parent', 'child-1', 'child-2']);
  assert.deepEqual(log.detached, []);

  const restored = await restoreEntry({ entryId: entry.id, roots, deps });
  assert.deepEqual(restored.warnings, []);
  for (const dir of [parent, child, grandchild]) assert.equal(existsSync(dir), true);
  // The slot was never removed, so nothing needs re-attaching.
  assert.deepEqual(log.attached, []);
  // The children were hidden too, so a restore must unhide the whole lineage.
  assert.deepEqual(log.unarchived, ['session-parent', 'child-1', 'child-2']);
  assert.equal((await listEntries(roots)).length, 0);
});

test('a Session generating a reply is refused and nothing moves', async () => {
  const { roots } = await scratch();
  const dir = await seedSession(roots, 'session-live');
  const { deps } = fakeDeps({ live: ['session-live'], running: ['session-live'] });

  await assert.rejects(
    trashSession({ sessionId: 'session-live', roots, deps }),
    (error) => error instanceof TrashError && error.code === 'E_RUNNING',
  );
  assert.equal(existsSync(dir), true);
  assert.equal((await listEntries(roots)).length, 0);
});

test('a loaded but idle Session is removable and reports that it was loaded', async () => {
  const { roots } = await scratch();
  const dir = await seedSession(roots, 'session-loaded');
  const { deps } = fakeDeps({ live: ['session-loaded'] });

  const value = await trashSession({ sessionId: 'session-loaded', roots, deps });

  assert.equal(existsSync(dir), false);
  assert.deepEqual(value.loaded, ['session-loaded']);
  assert.equal((await listEntries(roots)).length, 1);
});

test('a running subagent refuses the whole removal', async () => {
  const { roots } = await scratch();
  const parentDir = await seedSession(roots, 'session-parent');
  const childDir = await seedSession(roots, 'session-child', { projectDir: PROJECT });
  const { deps } = fakeDeps({
    headers: [
      { id: 'session-parent', cwd: '/work' },
      { id: 'session-child', cwd: '/work', parentSession: 'session-parent' },
    ],
    running: ['session-child'],
  });

  await assert.rejects(
    trashSession({ sessionId: 'session-parent', roots, deps }),
    (error) => error instanceof TrashError && error.code === 'E_RUNNING',
  );
  assert.equal(existsSync(parentDir), true);
  assert.equal(existsSync(childDir), true);
});

test('an unknown session reports not-found', async () => {
  const { roots } = await scratch();
  const { deps } = fakeDeps();
  await assert.rejects(
    trashSession({ sessionId: 'session-nope', roots, deps }),
    (error) => error instanceof TrashError && error.code === 'E_NOT_FOUND',
  );
});

test('a second delete of the same Session says it is already in the bin', async () => {
  const { roots } = await scratch();
  await seedSession(roots, 'session-aaa');
  const { deps } = fakeDeps({ headers: [{ id: 'session-aaa', cwd: '/work' }] });

  const first = await trashSession({ sessionId: 'session-aaa', roots, deps });
  await assert.rejects(
    trashSession({ sessionId: 'session-aaa', roots, deps }),
    (error) => error instanceof TrashError && error.code === 'E_ALREADY_TRASHED' && error.status === 409
      && error.details.entryId === first.entry.id,
  );
});

test('restore refuses to overwrite a session recreated at the same path', async () => {
  const { roots } = await scratch();
  await seedSession(roots, 'session-aaa');
  const { deps } = fakeDeps({ headers: [{ id: 'session-aaa', cwd: '/work' }] });
  const { entry } = await trashSession({ sessionId: 'session-aaa', roots, deps });

  await seedSession(roots, 'session-aaa');
  await assert.rejects(
    restoreEntry({ entryId: entry.id, roots, deps }),
    (error) => error instanceof TrashError && error.code === 'E_CONFLICT',
  );
  // The conflicting original is untouched and the entry is still restorable later.
  assert.equal((await listEntries(roots)).length, 1);
  assert.equal(existsSync(join(roots.sessionsRoot, PROJECT, 'session-aaa')), true);
});

test('restore re-applies pinned state and clears a stale archive flag', async () => {
  const { roots } = await scratch();
  await seedSession(roots, 'session-aaa');
  const workspaces = [{ id: 'ws-1', title: 'work', path: '/work', sessionIds: ['session-aaa'] }];
  const { deps, log } = fakeDeps({
    headers: [{ id: 'session-aaa', cwd: '/work' }],
    workspaces,
    pinned: ['session-aaa'],
    archived: [],
  });
  const { entry } = await trashSession({ sessionId: 'session-aaa', roots, deps });
  await restoreEntry({ entryId: entry.id, roots, deps });
  assert.deepEqual(log.unarchived, ['session-aaa']);
  assert.deepEqual(log.pinned, ['session-aaa']);
});

test('a failing archive leaves the log and the list untouched', async () => {
  const { roots } = await scratch();
  const dir = await seedSession(roots, 'session-aaa');
  const base = fakeDeps({ headers: [{ id: 'session-aaa', cwd: '/work' }] });
  const deps = {
    ...base.deps,
    async archive() {
      throw new Error('session is active');
    },
  };

  await assert.rejects(
    trashSession({ sessionId: 'session-aaa', roots, deps }),
    (error) => error instanceof TrashError && error.code === 'E_ARCHIVE'
      && error.status === 409 && /session is active/.test(error.message),
  );
  assert.equal(existsSync(dir), true, 'the log must not move when the row cannot be hidden');
  assert.equal((await listEntries(roots)).length, 0);
});

test('an entry without metadata is listed as incomplete and cannot be restored', async () => {
  const { roots } = await scratch();
  const broken = join(roots.trashRoot, '20260101-000000-abcdef');
  await mkdir(join(broken, 'data'), { recursive: true });
  await writeFile(join(broken, 'data', 'junk.txt'), 'x');

  const entries = await listEntries(roots);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].incomplete, true);

  await assert.rejects(
    restoreEntry({ entryId: entries[0].id, roots, deps: fakeDeps().deps }),
    (error) => error instanceof TrashError && error.code === 'E_INCOMPLETE',
  );
  await purgeEntry({ entryId: entries[0].id, roots });
  assert.equal((await listEntries(roots)).length, 0);
});

test('emptyTrash removes every entry', async () => {
  const { roots } = await scratch();
  await seedSession(roots, 'session-a');
  await seedSession(roots, 'session-b');
  const { deps } = fakeDeps({ headers: [{ id: 'session-a' }, { id: 'session-b' }] });
  await trashSession({ sessionId: 'session-a', roots, deps });
  await trashSession({ sessionId: 'session-b', roots, deps });
  assert.equal((await listEntries(roots)).length, 2);

  const result = await emptyTrash({ roots });
  assert.equal(result.purged, 2);
  assert.equal((await listEntries(roots)).length, 0);
  assert.deepEqual(await readdir(roots.trashRoot), []);
});

test('ids that could escape the storage roots are rejected', async () => {
  const { roots } = await scratch();
  const { deps } = fakeDeps();
  for (const sessionId of ['../etc', 'a/b', '', 'session-../x']) {
    await assert.rejects(
      trashSession({ sessionId, roots, deps }),
      (error) => error instanceof TrashError && error.code.startsWith('E_BAD_'),
    );
  }
  await assert.rejects(
    purgeEntry({ entryId: '../../tmp', roots }),
    (error) => error instanceof TrashError && error.code === 'E_BAD_ENTRY_ID',
  );
});

test('a partially failed trash rolls the moved directories back', async () => {
  const { roots } = await scratch();
  const parent = await seedSession(roots, 'session-parent');
  await seedSession(roots, 'session-child');
  const workspaces = [{ id: 'ws-1', title: 'work', path: '/work', sessionIds: ['session-parent', 'session-child'] }];
  const base = fakeDeps({
    headers: [
      { id: 'session-parent', cwd: '/work' },
      { id: 'session-child', cwd: '/work', parentSession: 'session-parent' },
    ],
    workspaces,
  });
  let archiveCalls = 0;
  const deps = {
    ...base.deps,
    async archive(id) {
      archiveCalls += 1;
      if (archiveCalls === 2) throw new Error('workspace write failed');
      return base.deps.archive(id);
    },
  };

  await assert.rejects(trashSession({ sessionId: 'session-parent', roots, deps }), /workspace write failed/);
  assert.equal(existsSync(parent), true);
  assert.equal(existsSync(join(roots.sessionsRoot, PROJECT, 'session-child')), true);
  assert.equal((await listEntries(roots)).length, 0);
  // The parent was archived before the failure, so the rollback must unhide it.
  assert.deepEqual(base.log.archived, ['session-parent']);
  assert.deepEqual(base.log.unarchived, ['session-parent']);
});

test('metadata written into the bin is plain JSON with the original paths', async () => {
  const { roots } = await scratch();
  await seedSession(roots, 'session-aaa');
  const { deps } = fakeDeps({ headers: [{ id: 'session-aaa', cwd: '/work' }] });
  const { entry } = await trashSession({ sessionId: 'session-aaa', roots, deps });
  const meta = JSON.parse(await readFile(join(roots.trashRoot, entry.id, 'meta.json'), 'utf8'));
  assert.equal(meta.format, 1);
  assert.equal(meta.files[0].projectDir, PROJECT);
  assert.equal(meta.files[0].dirName, 'session-aaa');
  // Restore needs to know which rows this entry hid, children included.
  assert.deepEqual(meta.hidden, ['session-aaa']);
});

test('restore puts the Session back beside the neighbour it used to follow', async () => {
  const { roots } = await scratch();
  await seedSession(roots, 'session-a');
  await seedSession(roots, 'session-b');
  await seedSession(roots, 'session-c');
  const workspaces = [{ id: 'ws-1', title: 'work', path: '/work', sessionIds: ['session-a', 'session-b', 'session-c'] }];
  const { deps } = fakeDeps({
    headers: [{ id: 'session-a' }, { id: 'session-b' }, { id: 'session-c' }],
    workspaces,
  });

  const { entry } = await trashSession({ sessionId: 'session-b', roots, deps });
  // Archiving leaves the neighbour list untouched, which is exactly why the
  // Session reappears in its own slot instead of at the top.
  assert.deepEqual(workspaces[0].sessionIds, ['session-a', 'session-b', 'session-c']);

  await restoreEntry({ entryId: entry.id, roots, deps });
  assert.deepEqual(workspaces[0].sessionIds, ['session-a', 'session-b', 'session-c']);
});

test('trashBatch removes the removable Sessions and reports the running one separately', async () => {
  const { roots } = await scratch();
  const a = await seedSession(roots, 'session-a');
  const b = await seedSession(roots, 'session-b');
  const c = await seedSession(roots, 'session-c');
  const workspaces = [{ id: 'ws-1', title: 'work', path: '/work', sessionIds: ['session-a', 'session-b', 'session-c'] }];
  const { deps } = fakeDeps({
    headers: [{ id: 'session-a' }, { id: 'session-b' }, { id: 'session-c' }],
    live: ['session-b'],
    running: ['session-b'],
    workspaces,
  });

  const report = await trashBatch({ sessionIds: ['session-a', 'session-b', 'session-c'], roots, deps });

  assert.equal(report.trashed, 2);
  assert.equal(report.skipped, 1);
  assert.deepEqual(
    report.results.map((result) => [result.sessionId, result.ok, result.code]),
    [
      ['session-a', true, undefined],
      ['session-b', false, 'E_RUNNING'],
      ['session-c', true, undefined],
    ],
  );
  assert.equal(existsSync(a), false);
  assert.equal(existsSync(b), true, 'a running Session keeps its directory');
  assert.equal(existsSync(c), false);
  assert.deepEqual(workspaces[0].sessionIds, ['session-a', 'session-b', 'session-c']);
  assert.equal((await listEntries(roots)).length, 2);
});

test('trashBatch dedupes ids and rejects an empty, oversized, or malformed list', async () => {
  const { roots } = await scratch();
  await seedSession(roots, 'session-a');
  const { deps } = fakeDeps({ headers: [{ id: 'session-a' }] });

  const report = await trashBatch({ sessionIds: ['session-a', 'session-a'], roots, deps });
  assert.equal(report.trashed, 1);
  assert.equal(report.results.length, 1);

  await assert.rejects(() => trashBatch({ sessionIds: [], roots, deps }), (error) => error.code === 'E_EMPTY_BATCH');
  await assert.rejects(() => trashBatch({ sessionIds: 'session-a', roots, deps }), (error) => error.code === 'E_BAD_ARGS');
  const tooMany = Array.from({ length: MAX_BATCH + 1 }, (_, index) => `session-${index}`);
  await assert.rejects(() => trashBatch({ sessionIds: tooMany, roots, deps }), (error) => error.code === 'E_TOO_MANY');
});
