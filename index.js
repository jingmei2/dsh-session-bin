/**
 * dsh-session-bin — Host half.
 *
 * Exposes one operation set (list / trash / restore / purge / empty) through
 * two callers: the browser UI's loopback HTTP route and the agent's
 * `session_trash` tool. Both call the same core functions.
 */
import {
  emptyTrash,
  listEntries,
  purgeEntry,
  resolveRoots,
  restoreEntry,
  trashBatch,
  trashSession,
  TrashError,
} from './core.js';

export const inject = ['webServer'];

export const ROUTE_PATH = '/api/session-trash';
const MAX_BODY_BYTES = 64 * 1024;

function readService(ctx, name) {
  try {
    return ctx.get(name);
  } catch {
    return undefined;
  }
}

function makeDeps(ctx) {
  const registry = () => readService(ctx, 'workspaceRegistry');

  const headers = async () => {
    const query = readService(ctx, 'sessionQuery');
    if (query && typeof query.listSessions === 'function') {
      const records = await query.listSessions();
      return records.map((record) => record.header).filter(Boolean);
    }
    const persistence = readService(ctx, 'sessionPersistence');
    if (persistence && typeof persistence.list === 'function') {
      const snapshots = await persistence.list();
      return snapshots.map((snapshot) => snapshot.header).filter(Boolean);
    }
    return [];
  };

  const workspaceFor = (sessionId) => {
    const reg = registry();
    if (!reg) return undefined;
    for (const workspace of reg.list()) {
      if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) return workspace;
    }
    return undefined;
  };

  const archivedIds = () => {
    const reg = registry();
    const ids = reg ? reg.archivedSessionIds : [];
    return Array.isArray(ids) ? ids : [];
  };

  const pinnedIds = () => {
    const reg = registry();
    const ids = reg ? reg.pinnedSessionIds : [];
    return Array.isArray(ids) ? ids : [];
  };

  return {
    async isLive(sessionId) {
      const live = readService(ctx, 'sessions')?.get(sessionId);
      if (live) return true;
      return Boolean(readService(ctx, 'agents')?.get(sessionId));
    },
    /**
     * A turn is generating right now. DSH keeps a Session "live" (loaded) long
     * after you switch away, so liveness alone cannot decide whether its log can
     * move — only an in-flight turn can.
     */
    async isRunning(sessionId) {
      const agent = readService(ctx, 'agents')?.get(sessionId);
      return agent?.status === 'running';
    },
    allHeaders: headers,
    workspaceFor,
    workspaceById(sessionId) {
      const reg = registry();
      return reg && typeof reg.get === 'function' ? reg.get(sessionId) : undefined;
    },
    async detach(workspaceId, sessionId) {
      const workspace = this.workspaceById(workspaceId);
      if (!workspace) return;
      if (typeof workspace.detachSession !== 'function') {
        throw new Error('workspace registry does not expose detachSession');
      }
      await workspace.detachSession(sessionId);
    },
    async attach(workspaceId, sessionId) {
      const workspace = this.workspaceById(workspaceId);
      if (!workspace) throw new Error(`unknown workspace ${workspaceId}`);
      if (typeof workspace.attachSession !== 'function') {
        throw new Error('workspace registry does not expose attachSession');
      }
      await workspace.attachSession(sessionId);
    },
    async insertBefore(workspaceId, sessionId, beforeSessionId) {
      const workspace = this.workspaceById(workspaceId);
      if (!workspace || typeof workspace.insertSessionBefore !== 'function') return;
      await workspace.insertSessionBefore(sessionId, beforeSessionId ?? undefined);
    },
    archivedIds,
    pinnedIds,
    /**
     * Hide the Session's row without touching its Workspace accounting slot.
     * This is the removal-hiding primitive: `detachSession` would strip the slot
     * and leave the still-live row orphaned into "未分组".
     */
    async archive(sessionId) {
      const reg = registry();
      // No registry means no Workspace surface to hide the row on; the log can
      // still move, so this degrades instead of blocking the removal.
      if (!reg || typeof reg.archiveSession !== 'function') return;
      await reg.archiveSession(sessionId);
    },
    async unarchive(sessionId) {
      const reg = registry();
      if (reg && archivedIds().includes(sessionId)) await reg.unarchiveSession(sessionId);
    },
    async pin(sessionId) {
      const reg = registry();
      if (reg) await reg.pinSession(sessionId);
    },
    async readTitle(sessionId) {
      const query = readService(ctx, 'sessionQuery');
      if (!query || typeof query.readTitle !== 'function') return undefined;
      return await query.readTitle(sessionId);
    },
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(body);
}

/** Loopback + same-origin fence, the same posture the shipped loopback routes use. */
function isLoopbackRequest(request) {
  const address = request.socket?.remoteAddress;
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function createOperations(ctx) {
  const deps = makeDeps(ctx);
  const roots = resolveRoots();

  return async function run(request) {
    switch (request.op) {
      case 'list':
        return { entries: await listEntries(roots) };
      case 'trash':
        return await trashSession({
          sessionId: request.sessionId,
          title: request.title,
          workspaceId: request.workspaceId,
          roots,
          deps,
        });
      case 'trash-many':
        return await trashBatch({
          sessionIds: Array.isArray(request.sessionIds) ? request.sessionIds : request.ids,
          roots,
          deps,
        });
      case 'inspect':
        return {
          sessionId: request.sessionId,
          live: await deps.isLive(request.sessionId),
          running: await deps.isRunning(request.sessionId),
        };
      case 'restore':
        return await restoreEntry({ entryId: request.entryId, roots, deps });
      case 'purge':
        return await purgeEntry({ entryId: request.entryId, roots });
      case 'empty':
        return await emptyTrash({ roots });
      default:
        throw new TrashError('E_BAD_OP', `unknown operation: ${JSON.stringify(request.op)}`, 400);
    }
  };
}

function makeHandler(ctx) {
  const run = createOperations(ctx);

  return async function handle(request, response) {
    if (!isLoopbackRequest(request)) {
      sendJson(response, 403, { ok: false, error: { code: 'E_FORBIDDEN', message: 'loopback only' } });
      return;
    }

    let body;
    if (request.method === 'GET') {
      body = { op: 'list' };
    } else if (request.method === 'POST') {
      body = await readJsonBody(request);
      if (!body) {
        sendJson(response, 400, { ok: false, error: { code: 'E_BAD_BODY', message: 'invalid JSON body' } });
        return;
      }
    } else {
      sendJson(response, 405, { ok: false, error: { code: 'E_METHOD', message: `method not allowed: ${request.method}` } });
      return;
    }

    try {
      const value = await run(body);
      sendJson(response, 200, { ok: true, ...value });
    } catch (error) {
      if (error instanceof TrashError) {
        sendJson(response, error.status, {
          ok: false,
          error: { code: error.code, message: error.message, details: error.details },
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { ok: false, error: { code: 'E_INTERNAL', message } });
    }
  };
}

const TOOL_OUTPUT = {
  schema: { type: 'object', additionalProperties: true, properties: {} },
  render(_args, value) {
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return [{ type: 'text', text }];
  },
};

function createTool(ctx) {
  const run = createOperations(ctx);
  return {
    name: 'session_trash',
    description:
      'Physically remove Session logs from this machine, or manage the recycle bin that makes removal undoable. '
      + 'action=trash moves one Session directory (plus its subagent child Sessions) out of ~/.dsh/sessions into ~/.dsh/session-trash '
      + 'and hides the Session from its workspace list; action=trash with sessionIds (or many single calls) removes several; '
      + 'action=restore puts one back; action=purge permanently deletes one trash entry; '
      + 'action=empty permanently deletes the whole recycle bin; action=list shows what is in the bin. '
      + 'A Session that is generating a reply right now is refused (stop it first); a Session merely still loaded in the app is allowed. '
      + 'A batch reports each id separately. '
      + 'Prefer action=trash: it is reversible. Never claim a deletion succeeded unless the tool result says ok.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'trash', 'restore', 'purge', 'empty'],
          description: 'Operation to perform.',
        },
        sessionId: {
          type: 'string',
          description: 'Target Session id for action=trash (e.g. session-<uuid>).',
        },
        sessionIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Several Session ids for action=trash, removed one by one with a per-id result (max 200).',
        },
        entryId: {
          type: 'string',
          description: 'Recycle-bin entry id for action=restore or action=purge (from action=list).',
        },
        title: {
          type: 'string',
          description: 'Optional display title recorded with the trash entry (cosmetic).',
        },
        workspaceId: {
          type: 'string',
          description: 'Optional workspace id; omitted, the owning workspace is detected automatically.',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TOOL_OUTPUT,
    async execute(args) {
      const input = args && typeof args === 'object' ? { ...args } : {};
      // The tool speaks `action`; the operation table speaks `op`.
      if (typeof input.op !== 'string' && typeof input.action === 'string') input.op = input.action;
      try {
        const value = await run(input);
        return { ok: true, ...value };
      } catch (error) {
        if (error instanceof TrashError) {
          return { ok: false, error: { code: error.code, message: error.message } };
        }
        return { ok: false, error: { code: 'E_INTERNAL', message: error instanceof Error ? error.message : String(error) } };
      }
    },
  };
}

export function apply(ctx) {
  ctx.effect(
    () => ctx.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: makeHandler(ctx) }),
    'session-trash: http route',
  );

  const tools = readService(ctx, 'tools');
  if (tools && typeof tools.register === 'function') {
    ctx.effect(() => tools.register(createTool(ctx)), 'session-trash: session_trash tool');
  }
}
