/**
 * Session trash core: physical session removal with an undo window.
 *
 * Nothing here touches Cordis. Every Host capability arrives through `deps`,
 * so the filesystem behaviour (move / rollback / list / restore / purge) is
 * testable against a scratch directory with no Harness running.
 */
import { randomBytes } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const ENTRY_ID = /^\d{8}-\d{6}-[a-z0-9]{6}$/;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
/** One batch call removes at most this many Sessions, so a stray select-all cannot stall the Host. */
export const MAX_BATCH = 200;

export class TrashError extends Error {
  constructor(code, message, status = 400, details) {
    super(message);
    this.name = 'TrashError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export function resolveRoots(env = process.env) {
  const home = env.DSH_HOME
    || (env.DSH_PROFILE_DIR ? dirname(dirname(env.DSH_PROFILE_DIR)) : join(homedir(), '.dsh'));
  return {
    home,
    sessionsRoot: env.DSH_SESSIONS_ROOT || join(home, 'sessions'),
    trashRoot: env.DSH_SESSION_TRASH_ROOT || join(home, 'session-trash'),
    projectCacheRoot: env.DSH_SESSION_CACHE_ROOT || join(home, 'storages', 'session_projcache', 'sessions'),
  };
}

export function assertSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || sessionId.includes('..')) {
    throw new TrashError('E_BAD_SESSION_ID', `invalid session id: ${JSON.stringify(sessionId)}`, 400);
  }
  return sessionId;
}

export function assertEntryId(entryId) {
  if (typeof entryId !== 'string' || !ENTRY_ID.test(entryId)) {
    throw new TrashError('E_BAD_ENTRY_ID', `invalid trash entry id: ${JSON.stringify(entryId)}`, 400);
  }
  return entryId;
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Every on-disk location of one session id (normally exactly one, but a cwd move can leave two). */
export async function findSessionDirs(sessionsRoot, sessionId) {
  assertSessionId(sessionId);
  let projects;
  try {
    projects = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const found = [];
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const abs = join(sessionsRoot, project.name, sessionId);
    if (await isDirectory(abs)) found.push({ projectDir: project.name, dirName: sessionId, abs });
  }
  return found;
}

/** Recursive byte total; unreadable children are skipped rather than failing the listing. */
export async function dirSize(path) {
  let total = 0;
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await dirSize(child);
    else if (entry.isFile()) {
      try {
        total += (await stat(child)).size;
      } catch {
        /* raced deletion */
      }
    }
  }
  return total;
}

/** Root session plus every descendant reachable through `parentSession`, root first. */
export function collectLineage(headers, rootId) {
  const byParent = new Map();
  for (const header of headers) {
    if (!header || typeof header.id !== 'string') continue;
    const parent = header.parentSession;
    if (typeof parent !== 'string' || parent.length === 0) continue;
    const bucket = byParent.get(parent);
    if (bucket) bucket.push(header.id);
    else byParent.set(parent, [header.id]);
  }
  const ordered = [rootId];
  const seen = new Set(ordered);
  for (let index = 0; index < ordered.length; index += 1) {
    for (const child of byParent.get(ordered[index]) || []) {
      if (seen.has(child)) continue;
      seen.add(child);
      ordered.push(child);
    }
  }
  return ordered;
}

function newEntryId(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${stamp}-${randomBytes(3).toString('hex')}`;
}

async function movePath(source, destination) {
  await mkdir(dirname(destination), { recursive: true });
  try {
    await rename(source, destination);
  } catch (error) {
    if (!error || error.code !== 'EXDEV') throw error;
    // Different filesystem: copy, then remove the source only after a full copy.
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false });
    await rm(source, { recursive: true, force: true });
  }
}

async function writeMeta(entryDir, meta) {
  const target = join(entryDir, 'meta.json');
  const temp = join(entryDir, 'meta.json.tmp');
  await writeFile(temp, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  await rename(temp, target);
}

async function readMeta(entryDir) {
  try {
    const raw = await readFile(join(entryDir, 'meta.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the recycle bin.
 * A directory without readable metadata is reported (never silently dropped) as
 * an incomplete entry whose only safe operation is permanent deletion.
 */
export async function listEntries(roots) {
  let dirents;
  try {
    dirents = await readdir(roots.trashRoot, { withFileTypes: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    throw error;
  }
  const entries = [];
  for (const dirent of dirents) {
    if (!dirent.isDirectory() || !ENTRY_ID.test(dirent.name)) continue;
    const entryDir = join(roots.trashRoot, dirent.name);
    const meta = await readMeta(entryDir);
    if (!meta || typeof meta.sessionId !== 'string') {
      entries.push({
        id: dirent.name,
        incomplete: true,
        sessionId: null,
        title: null,
        trashedAt: null,
        bytes: await dirSize(entryDir),
        sessionCount: 0,
      });
      continue;
    }
    entries.push({
      id: dirent.name,
      incomplete: false,
      sessionId: meta.sessionId,
      title: typeof meta.title === 'string' ? meta.title : null,
      workspaceId: meta.workspaceId ?? null,
      workspaceTitle: meta.workspaceTitle ?? null,
      workspacePath: meta.workspacePath ?? null,
      cwd: meta.cwd ?? null,
      trashedAt: typeof meta.trashedAt === 'number' ? meta.trashedAt : null,
      bytes: typeof meta.bytes === 'number' ? meta.bytes : await dirSize(entryDir),
      sessionCount: Array.isArray(meta.files) ? meta.files.length : 0,
      subagentCount: Array.isArray(meta.files) ? Math.max(0, meta.files.length - 1) : 0,
    });
  }
  entries.sort((left, right) => (right.trashedAt ?? 0) - (left.trashedAt ?? 0) || right.id.localeCompare(left.id));
  return entries;
}

/**
 * Move a session (and its subagent descendants) into the recycle bin.
 *
 * `deps` supplies the live workspace facts:
 *   isLive(id), isRunning(id) (optional; absent falls back to "never running"),
 *   allHeaders(), workspaceFor(id), workspaceById(id),
 *   archive(id), unarchive(id), attach(workspaceId, id),
 *   archivedIds(), pinnedIds(), readTitle(id) — see host/index.js.
 *
 * Hiding the row is done with `archive`, never with `detachSession`: detaching
 * strips the Workspace's accounting slot, and the group builder then files the
 * Session under the "未分组" group while the still-live row stays on screen.
 * Archiving keeps the slot and only removes the row from the default view, so
 * an unarchive puts it back in its recorded position.
 */
export async function trashSession({ sessionId, title, workspaceId, roots, deps, headers: prefetched, now = new Date() }) {
  assertSessionId(sessionId);

  const headers = prefetched ?? (await deps.allHeaders());
  const lineage = collectLineage(headers, sessionId);

  // Two different states, two different answers. "Loaded" only means this app
  // instance still holds the Session — DSH does not release one when you switch
  // away, so almost every row you have visited is loaded; its log can still be
  // moved while nothing is appending to it. "Running" means a turn is
  // generating right now: moving the log underneath it would strand its writes,
  // so that is the only state we refuse.
  const live = [];
  const running = [];
  for (const id of lineage) {
    if (await deps.isLive(id)) live.push(id);
    if (typeof deps.isRunning === 'function' && (await deps.isRunning(id))) running.push(id);
  }
  if (running.length > 0) {
    throw new TrashError(
      'E_RUNNING',
      running.length === 1
        ? '该会话正在生成回复，请先停止（或等这一轮结束）再删除。'
        : '该会话或其子会话正在生成回复，请先停止再删除。',
      409,
      { running },
    );
  }

  const located = [];
  for (const id of lineage) {
    for (const hit of await findSessionDirs(roots.sessionsRoot, id)) located.push({ ...hit, sessionId: id });
  }
  if (located.length === 0) {
    // A second delete of the same Session is the common case here: its log is
    // already sitting in the bin, so say that instead of claiming it vanished.
    const already = (await listEntries(roots)).find((entry) => entry.sessionId === sessionId);
    if (already) {
      throw new TrashError('E_ALREADY_TRASHED', '这个会话已经在回收站里了，不需要再删除一次。', 409, {
        entryId: already.id,
      });
    }
    throw new TrashError('E_NOT_FOUND', '没有找到该会话的日志目录，它可能已被删除。', 404);
  }

  const workspace = (workspaceId ? deps.workspaceById(workspaceId) : undefined) || deps.workspaceFor(sessionId);
  const archived = new Set(deps.archivedIds());
  const pinned = new Set(deps.pinnedIds());

  // The row's neighbours, so a restore can land in the same place instead of at the top.
  let order = null;
  if (workspace && Array.isArray(workspace.sessionIds)) {
    const index = workspace.sessionIds.indexOf(sessionId);
    if (index >= 0) {
      order = { index, successorId: workspace.sessionIds[index + 1] ?? null };
    }
  }

  let resolvedTitle = typeof title === 'string' && title.trim().length > 0 ? title.trim() : '';
  if (!resolvedTitle && typeof deps.readTitle === 'function') {
    try {
      const snapshot = await deps.readTitle(sessionId);
      if (snapshot && typeof snapshot.title === 'string') resolvedTitle = snapshot.title;
    } catch {
      /* the title is cosmetic */
    }
  }

  const entryId = newEntryId(now);
  const entryDir = join(roots.trashRoot, entryId);
  const dataDir = join(entryDir, 'data');
  await mkdir(dataDir, { recursive: true });

  const files = [];
  const hidden = [];
  try {
    // Hide the rows first: the registry's archive admission checks that the
    // Session still exists, so this has to run before the log leaves its
    // directory. Archiving keeps every Workspace accounting slot intact, which
    // is what stops the row from landing in "未分组" — and what lets a restore
    // return it to its recorded position.
    if (typeof deps.archive === 'function') {
      for (const id of lineage) {
        if (archived.has(id)) continue;
        try {
          await deps.archive(id);
        } catch (error) {
          // Archiving is the step that makes the row disappear. If it fails the
          // log must stay put, otherwise the list keeps a row pointing at a
          // directory that is no longer there — the exact bug this replaces.
          const detail = error instanceof Error ? error.message : String(error);
          throw new TrashError('E_ARCHIVE', `无法把该会话从列表里隐藏：${detail}`, 409, { sessionId: id });
        }
        hidden.push(id);
      }
    }

    for (const location of located) {
      const destination = join(dataDir, location.projectDir, location.dirName);
      await movePath(location.abs, destination);
      files.push({ sessionId: location.sessionId, projectDir: location.projectDir, dirName: location.dirName });
    }

    const meta = {
      format: 1,
      id: entryId,
      sessionId,
      title: resolvedTitle || null,
      cwd: (headers.find((header) => header && header.id === sessionId) || {}).cwd ?? null,
      workspaceId: workspace ? workspace.id : null,
      workspaceTitle: workspace ? workspace.title : null,
      workspacePath: workspace ? workspace.path : null,
      trashedAt: now.getTime(),
      wasArchived: archived.has(sessionId),
      wasPinned: pinned.has(sessionId),
      // Every id this entry hid, so a restore can unhide the whole lineage and
      // not just the Session the user clicked (children are archived too).
      hidden: [...hidden],
      order,
      bytes: await dirSize(dataDir),
      files,
    };
    await writeMeta(entryDir, meta);

    // The projection cache is derived state; a restore rebuilds it from the log.
    for (const id of lineage) {
      await rm(join(roots.projectCacheRoot, `${id}.json`), { force: true }).catch(() => {});
    }

    return {
      // Still loaded in this app instance: the caller warns instead of refusing.
      loaded: live,
      entry: {
        id: entryId,
        sessionId,
        title: meta.title,
        workspaceTitle: meta.workspaceTitle,
        workspacePath: meta.workspacePath,
        trashedAt: meta.trashedAt,
        bytes: meta.bytes,
        sessionCount: files.length,
        subagentCount: Math.max(0, files.length - 1),
        incomplete: false,
      },
    };
  } catch (error) {
    // Put the files back, then unhide whatever this attempt archived.
    for (const file of [...files].reverse()) {
      const source = join(dataDir, file.projectDir, file.dirName);
      const destination = join(roots.sessionsRoot, file.projectDir, file.dirName);
      await movePath(source, destination).catch(() => {});
    }
    for (const id of hidden) {
      await deps.unarchive(id).catch(() => {});
    }
    await rm(entryDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Remove several Sessions in one request, reporting each one separately.
 *
 * One unremovable Session (a tab still holding it, a log already gone) must
 * not cancel the rest: every id is attempted, failures are collected with
 * their own code, and the caller gets a per-id result list.
 */
export async function trashBatch({ sessionIds, roots, deps, now = new Date() }) {
  if (!Array.isArray(sessionIds)) {
    throw new TrashError('E_BAD_ARGS', 'sessionIds 必须是数组。', 400);
  }
  const unique = [];
  for (const sessionId of sessionIds) {
    assertSessionId(sessionId);
    if (!unique.includes(sessionId)) unique.push(sessionId);
  }
  if (unique.length === 0) {
    throw new TrashError('E_EMPTY_BATCH', '没有选中任何会话。', 400);
  }
  if (unique.length > MAX_BATCH) {
    throw new TrashError('E_TOO_MANY', `一次最多删除 ${MAX_BATCH} 个会话（收到 ${unique.length} 个）。`, 400);
  }

  // One corpus listing for the whole batch: every per-Session lookup would
  // otherwise re-list the entire history (O(n²) for a large selection).
  const headers = await deps.allHeaders();

  const results = [];
  for (const sessionId of unique) {
    try {
      const value = await trashSession({ sessionId, roots, deps, headers, now });
      results.push({
        sessionId,
        ok: true,
        entryId: value.entry.id,
        title: value.entry.title,
        subagentCount: value.entry.subagentCount,
      });
    } catch (error) {
      if (error instanceof TrashError) {
        results.push({ sessionId, ok: false, code: error.code, message: error.message });
      } else {
        results.push({
          sessionId,
          ok: false,
          code: 'E_INTERNAL',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const trashed = results.filter((result) => result.ok).length;
  return { results, trashed, skipped: results.length - trashed };
}

/** Put one trash entry back where it came from and re-register it in its workspace. */
export async function restoreEntry({ entryId, roots, deps }) {
  assertEntryId(entryId);
  const entryDir = join(roots.trashRoot, entryId);
  if (!(await isDirectory(entryDir))) {
    throw new TrashError('E_NO_ENTRY', '回收站中没有这一项。', 404);
  }
  const meta = await readMeta(entryDir);
  if (!meta || !Array.isArray(meta.files) || typeof meta.sessionId !== 'string') {
    throw new TrashError('E_INCOMPLETE', '这一项的元数据缺失，无法自动恢复；只能彻底删除。', 409);
  }

  const dataDir = join(entryDir, 'data');
  for (const file of meta.files) {
    const source = join(dataDir, file.projectDir, file.dirName);
    const destination = join(roots.sessionsRoot, file.projectDir, file.dirName);
    if (!(await pathExists(source))) {
      throw new TrashError('E_INCOMPLETE', `回收站文件缺失：${file.projectDir}/${file.dirName}`, 409);
    }
    if (await pathExists(destination)) {
      throw new TrashError(
        'E_CONFLICT',
        '原位置已存在同名会话（可能已恢复或重建）。请先移走现有会话，或直接彻底删除此项。',
        409,
      );
    }
  }

  const moved = [];
  try {
    for (const file of meta.files) {
      const source = join(dataDir, file.projectDir, file.dirName);
      const destination = join(roots.sessionsRoot, file.projectDir, file.dirName);
      await movePath(source, destination);
      moved.push(file);
    }
  } catch (error) {
    for (const file of [...moved].reverse()) {
      await movePath(
        join(roots.sessionsRoot, file.projectDir, file.dirName),
        join(dataDir, file.projectDir, file.dirName),
      ).catch(() => {});
    }
    throw error;
  }

  const warnings = [];
  const workspace = typeof meta.workspaceId === 'string' ? deps.workspaceById(meta.workspaceId) : undefined;
  // Archiving never touched the Workspace accounting slot, so the Session is
  // usually still accounted for and simply reappears where it was. Only an
  // entry written by the older detach-based version needs re-attaching.
  const accounted = Boolean(workspace && Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(meta.sessionId));
  if (workspace && !accounted) {
    try {
      await deps.attach(workspace.id, meta.sessionId);
      const successorId = meta.order && typeof meta.order.successorId === 'string' ? meta.order.successorId : null;
      if (successorId && typeof deps.insertBefore === 'function') {
        // Attach prepends; move the Session back beside the row it used to follow.
        await deps.insertBefore(workspace.id, meta.sessionId, successorId).catch(() => {});
      }
    } catch (error) {
      warnings.push(`会话日志已恢复，但未能自动归回工作区：${error instanceof Error ? error.message : String(error)}`);
    }
  } else if (!workspace) {
    warnings.push('会话日志已恢复；原工作区已不存在，下次启动后它会重新出现在列表中。');
  }

  // Unhide the whole lineage: trashing archived every child too, and a child
  // left archived would have its later steps blocked by the archive gate.
  const toUnhide = Array.isArray(meta.hidden) && meta.hidden.length > 0
    ? meta.hidden.filter((id) => typeof id === 'string')
    : meta.wasArchived ? [] : [meta.sessionId];
  for (const id of toUnhide) {
    try {
      await deps.unarchive(id);
    } catch (error) {
      warnings.push(`未能清除归档状态：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (meta.wasPinned) {
    try {
      await deps.pin(meta.sessionId);
    } catch (error) {
      warnings.push(`未能恢复置顶：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  await rm(entryDir, { recursive: true, force: true });
  return { restored: { id: entryId, sessionId: meta.sessionId, title: meta.title ?? null }, warnings };
}

/** Permanently delete one trash entry. */
export async function purgeEntry({ entryId, roots }) {
  assertEntryId(entryId);
  const entryDir = join(roots.trashRoot, entryId);
  if (!(await isDirectory(entryDir))) {
    throw new TrashError('E_NO_ENTRY', '回收站中没有这一项。', 404);
  }
  await rm(entryDir, { recursive: true, force: true });
  return { purged: entryId };
}

/** Permanently delete everything in the recycle bin. */
export async function emptyTrash({ roots }) {
  const entries = await listEntries(roots);
  for (const entry of entries) {
    await rm(join(roots.trashRoot, entry.id), { recursive: true, force: true });
  }
  return { purged: entries.length };
}
