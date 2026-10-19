/**
 * Integration test of the Host half without a running Harness.
 *
 * `apply()` is called with a stub context that captures the HTTP route and
 * the registered tool, so the real body parsing, loopback fence, op
 * dispatch, and `action` → `op` mapping run exactly as they do in-process.
 * Storage roots come from DSH_HOME, so every operation stays in a temp dir.
 */
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'dsh-trash-http-'));
process.env.DSH_HOME = home;

const { apply, ROUTE_PATH } = await import('../index.js');

const PROJECT = '--Users-magi-work--';

async function seedSession(sessionId) {
  const dir = join(home, 'sessions', PROJECT, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), 'x'.repeat(32));
  return dir;
}

function fakeResponse() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = body;
    },
  };
}

function fakeRequest(body, { method = 'POST', remoteAddress = '127.0.0.1', origin } = {}) {
  const headers = { host: '127.0.0.1:5123', 'content-type': 'application/json' };
  if (origin !== undefined) headers.origin = origin;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return {
    method,
    headers,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text);
    },
  };
}

test('the plugin registers its route and tool', async () => {
  const routes = [];
  let tool = null;
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
    get(name) {
      return name === 'tools' ? { register(definition) { tool = definition; return () => {}; } } : undefined;
    },
    effect(fn) {
      fn();
      return () => {};
    },
  };

  apply(ctx);

  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, ROUTE_PATH);
  assert.equal(routes[0].kind, 'exact');
  assert.equal(tool.name, 'session_trash');
  assert.ok(tool.parameters.properties.sessionIds, 'the tool exposes the batch parameter');
});

async function callRoute(payload, options) {
  const routes = [];
  const services = (options && options.services) || {};
  const ctx = {
    webServer: { register(route) { routes.push(route); return () => {}; } },
    get(name) {
      return services[name];
    },
    effect(fn) {
      fn();
      return () => {};
    },
  };
  apply(ctx);
  const response = fakeResponse();
  await routes[0].handler(fakeRequest(payload, options), response);
  return { status: response.status, data: JSON.parse(response.body) };
}

test('trash-many removes every removable id and reports the batch totals', async () => {
  const a = await seedSession('session-a');
  const b = await seedSession('session-b');

  const { status, data } = await callRoute({ op: 'trash-many', sessionIds: ['session-a', 'session-b'] });

  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.trashed, 2);
  assert.equal(data.skipped, 0);
  assert.deepEqual(data.results.map((result) => result.ok), [true, true]);
  assert.equal(existsSync(a), false);
  assert.equal(existsSync(b), false);

  const listed = await callRoute({ op: 'list' });
  assert.equal(listed.data.entries.length, 2);
});

test('trash-many keeps going after one id fails', async () => {
  await seedSession('session-c');
  const { data } = await callRoute({ op: 'trash-many', sessionIds: ['session-missing', 'session-c'] });

  assert.equal(data.ok, true);
  assert.equal(data.trashed, 1);
  assert.equal(data.skipped, 1);
  assert.equal(data.results[0].code, 'E_NOT_FOUND');
  assert.equal(data.results[1].ok, true);
});

test('trash-many rejects an empty selection with its own code', async () => {
  const { status, data } = await callRoute({ op: 'trash-many', sessionIds: [] });
  assert.equal(status, 400);
  assert.equal(data.error.code, 'E_EMPTY_BATCH');
});

test('the route refuses a non-loopback caller', async () => {
  const { status, data } = await callRoute({ op: 'list' }, { remoteAddress: '10.0.0.7' });
  assert.equal(status, 403);
  assert.equal(data.error.code, 'E_FORBIDDEN');
});

test('inspect separates a loaded Session from a running one', async () => {
  const loaded = { get: (id) => (id === 'session-loaded' ? { status: 'idle' } : undefined) };
  const running = { get: (id) => (id === 'session-running' ? { status: 'running' } : undefined) };

  const idle = await callRoute(
    { op: 'inspect', sessionId: 'session-loaded' },
    { services: { sessions: loaded, agents: loaded } },
  );
  assert.equal(idle.status, 200);
  assert.equal(idle.data.live, true, 'a loaded Session still reports live');
  assert.equal(idle.data.running, false, 'but it is not running');

  const busy = await callRoute(
    { op: 'inspect', sessionId: 'session-running' },
    { services: { agents: running } },
  );
  assert.equal(busy.data.live, true);
  assert.equal(busy.data.running, true);
});

test('trash-many skips the Session that is generating a reply', async () => {
  const dir = await seedSession('session-busy');
  const agents = { get: (id) => (id === 'session-busy' ? { status: 'running' } : undefined) };

  const { data } = await callRoute(
    { op: 'trash-many', sessionIds: ['session-busy'] },
    { services: { agents } },
  );

  assert.equal(data.trashed, 0);
  assert.equal(data.skipped, 1);
  assert.equal(data.results[0].code, 'E_RUNNING');
  assert.equal(existsSync(dir), true);
});

test('the agent tool maps action to op and can list and trash', async () => {
  const tools = [];
  const ctx = {
    webServer: { register() { return () => {}; } },
    get(name) {
      return name === 'tools'
        ? {
            register(definition) {
              tools.push(definition);
              return () => {};
            },
          }
        : undefined;
    },
    effect(fn) {
      fn();
      return () => {};
    },
  };
  apply(ctx);
  const tool = tools[0];

  const before = await tool.execute({ action: 'list' });
  assert.equal(before.ok, true, 'action must be translated to op');
  assert.ok(Array.isArray(before.entries));

  await seedSession('session-tool');
  const trashed = await tool.execute({ action: 'trash', sessionId: 'session-tool' });
  assert.equal(trashed.ok, true);
  assert.equal(trashed.entry.sessionId, 'session-tool');
});
