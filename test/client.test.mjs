/**
 * Client-half contract test without a browser.
 *
 * The module loader is stubbed, `react` is replaced by a tiny element
 * factory, and every registered component is rendered once (functions are
 * expanded recursively). That catches the two failures that matter for a
 * slot entry: a module that does not load, and a component that throws on
 * its first render.
 */
import { strict as assert } from 'node:assert';
import test from 'node:test';

const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  Fragment: Symbol('Fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (value) => ({ current: value }),
  useCallback: (fn) => fn,
};

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
};
Object.defineProperty(globalThis, 'navigator', { value: { language: 'zh-CN' }, configurable: true });

await import('../client.js');

test('the client module loads and registers its three surfaces', () => {
  assert.ok(loaded, 'the module registered a factory');
  assert.equal(loaded.id, 'dsh-session-trash');

  const module = loaded.factory((name) => {
    if (name === 'react') return React;
    throw new Error(`unexpected module: ${name}`);
  });
  assert.deepEqual(module.inject, ['slots', 'locale']);

  const registrations = [];
  const ctx = {
    locale: { getSnapshot: () => ({ active: 'zh-CN' }), subscribe: () => () => {} },
    effect: (fn) => {
      fn();
      return () => {};
    },
    slots: {
      inject(key, callback) {
        registrations.push({ key, entry: callback() });
        return () => {};
      },
      register(options, Component) {
        return { ...options, Component };
      },
    },
  };
  module.apply(ctx);

  assert.deepEqual(
    registrations.map((registration) => registration.key),
    ['sidebar.workspaces.session.menu.item', 'settings.section', 'shell.overlay'],
  );
  assert.equal(registrations[0].entry.id, 'session-trash-delete');
  assert.equal(registrations[1].entry.id, 'session-trash');
  assert.equal(registrations[2].entry.id, 'session-trash-dialog');
  for (const registration of registrations) assert.equal(typeof registration.entry.Component, 'function');
});

/** Expand function components until only host elements remain. */
function expand(node) {
  if (Array.isArray(node)) return node.flatMap((child) => expand(child));
  if (node === null || node === undefined || typeof node !== 'object') return node;
  if (typeof node.type === 'function') return expand(node.type(node.props));
  return { ...node, children: (node.children || []).flatMap((child) => expand(child)) };
}

function texts(node, out = []) {
  if (Array.isArray(node)) {
    for (const child of node) texts(child, out);
    return out;
  }
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (typeof node === 'object') texts(node.children, out);
  return out;
}

function countByClass(node, className) {
  if (Array.isArray(node)) return node.reduce((total, child) => total + countByClass(child, className), 0);
  if (!node || typeof node !== 'object') return 0;
  const own = node.props && String(node.props.className || '').split(/\s+/).includes(className) ? 1 : 0;
  return own + countByClass(node.children, className);
}

function settingsComponent() {
  return componentFor('settings.section');
}

/** Load the module with a given require stub and return one slot's Component. */
function componentFor(slotKey, requireImpl) {
  const module = loaded.factory(requireImpl || ((name) => (name === 'react' ? React : undefined)));
  let entry = null;
  module.apply({
    locale: { getSnapshot: () => ({ active: 'zh-CN' }), subscribe: () => () => {} },
    effect: (fn) => {
      fn();
      return () => {};
    },
    slots: {
      inject(key, callback) {
        const value = callback();
        if (key === slotKey) entry = value;
        return () => {};
      },
      register(options, Component) {
        return { ...options, Component };
      },
    },
  });
  return entry.Component;
}

test('the session menu row is the Host primitive, not a look-alike button', () => {
  const seen = [];
  const MenuItemButton = (props) => {
    seen.push(props);
    return React.createElement('button', { role: 'menuitem' }, props.children);
  };
  const IconTrashOutlineRegular = () => React.createElement('svg', { viewBox: '0 0 16 16' });
  const primitives = { MenuItemButton, IconTrashOutlineRegular };

  const Row = componentFor('sidebar.workspaces.session.menu.item', (name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    return undefined;
  });
  const tree = expand(React.createElement(Row, {
    sessionId: 'session-a',
    displayTitle: 'Alpha',
    useMenuOpenState: () => [false, () => {}],
  }));

  assert.equal(seen.length, 1, 'the menu entry renders through MenuItemButton');
  assert.equal(typeof seen[0].onSelect, 'function');
  assert.ok(seen[0].icon, 'the trash icon is passed as the primitive icon');
  assert.equal(seen[0].icon.props.size, 14, 'shipped menu icon metric');
  assert.match(texts(tree).join(' '), /彻底删除/);
});

test('a forwardRef-style primitive is used instead of the fallback button', () => {
  const objectComponent = { $$typeof: Symbol.for('react.forward_ref'), render: () => null };
  const Row = componentFor('sidebar.workspaces.session.menu.item', (name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { MenuItemButton: objectComponent };
    return undefined;
  });
  const tree = expand(React.createElement(Row, {
    sessionId: 'session-a',
    displayTitle: 'Alpha',
    useMenuOpenState: () => [false, () => {}],
  }));
  assert.equal(tree.type, objectComponent, 'an object-typed component is still the primitive');
  assert.equal(countByClass(tree, 'dst-menu-item'), 0, 'the fallback button is not rendered');
});

test('the menu row stays a menuitem when the primitive is unavailable', () => {  const Row = componentFor('sidebar.workspaces.session.menu.item');
  const tree = expand(React.createElement(Row, {
    sessionId: 'session-a',
    displayTitle: 'Alpha',
    useMenuOpenState: () => [false, () => {}],
  }));
  const buttons = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.type === 'button') buttons.push(node);
    walk(node.children);
  };
  walk(tree);
  assert.equal(buttons.length, 1);
  assert.equal(buttons[0].props.role, 'menuitem');
  assert.match(texts(tree).join(' '), /彻底删除/);
});

test('the batch tab renders one row per deletable Session and skips subagents', () => {
  const rows = {
    'session-a': { id: 'session-a', title: 'Alpha', createdAt: 1 },
    'session-b': { id: 'session-b', title: 'Beta', createdAt: 2, origin: 'subagent' },
    'session-c': { id: 'session-c', title: '', blank: true, createdAt: 3 },
    'session-d': { id: 'session-d', title: 'Delta', createdAt: 4 },
  };
  const workspaceSnapshot = {
    items: [{ workspaceId: 'ws-1', title: 'Work', sessionIds: ['session-a', 'session-b', 'session-c', 'session-d'] }],
    archivedSessionIds: [],
  };
  const sessionSnapshot = { ids: Object.keys(rows), byId: rows };
  const statuses = new Map([['session-d', { running: true }]]);

  // Force the settings page onto its batch tab for this render.
  const realUseState = React.useState;
  React.useState = (initial) => {
    if (initial === 'bin') return ['batch', () => {}];
    return realUseState(initial);
  };
  try {
    const Page = settingsComponent();
    const tree = expand(
      React.createElement(Page, {
        useWorkspaces: (selector) => selector(workspaceSnapshot),
        useSessions: (selector) => selector(sessionSnapshot),
        useSessionStatus: (selector) => selector(statuses),
        close: () => {},
      }),
    );
    const all = texts(tree).join(' ');
    assert.match(all, /批量清理/);
    assert.equal(countByClass(tree, 'dst-batch-row'), 2, 'subagent and blank rows are not listed');
    assert.match(all, /Alpha/);
    assert.match(all, /Delta/);
    assert.doesNotMatch(all, /Beta/);
    assert.match(all, /运行中/, 'a running Session is marked instead of silently failing later');
    assert.equal(countByClass(tree, 'dst-group'), 1);
  } finally {
    React.useState = realUseState;
  }
});

test('the recycle-bin tab renders its header and loading state', () => {
  const Page = settingsComponent();
  const tree = expand(
    React.createElement(Page, {
      useWorkspaces: (selector) => selector({ items: [], archivedSessionIds: [] }),
      useSessions: (selector) => selector({ ids: [], byId: {} }),
      useSessionStatus: (selector) => selector(new Map()),
      close: () => {},
    }),
  );
  const all = texts(tree).join(' ');
  assert.match(all, /会话回收站/);
  assert.match(all, /回收站/);
  assert.match(all, /读取中/);
  assert.equal(countByClass(tree, 'dst-tabs'), 1);
});
