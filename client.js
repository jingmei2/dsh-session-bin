/**
 * dsh-session-trash — Client half.
 *
 * Two surfaces, one operation set:
 *   - a "…" menu row on every Session row (physical delete, into the recycle bin)
 *   - a Settings page that lists the bin and restores / purges entries
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-trash',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // The Host's own menu row, resolved through the loader's baseline module
    // table: the row then inherits the shipped height, padding, icon metrics
    // and hover treatment instead of imitating them. A composition without the
    // primitive falls back to a plain button with the same semantics.
    let primitives = null;
    try {
      primitives = require('@deepseek-ai/dsh-client-ui-primitives');
    } catch {
      primitives = null;
    }

    const API = '/api/session-trash';
    const CHANGE_EVENT = 'dsh-session-trash:changed';

    /* ------------------------------------------------------------ locale */

    const STRINGS = {
      zh: {
        menuDelete: '彻底删除…',
        settingsLabel: '会话回收站',
        settingsHint: '被删除的会话日志暂存在这里。恢复后回到原工作区和原位置。',
        empty: '回收站是空的。',
        refresh: '刷新',
        emptyBin: '清空回收站',
        confirmEmpty: '确认清空',
        cancel: '取消',
        loading: '读取中…',
        loadFailed: '读取回收站失败：{message}',
        retry: '重试',
        restore: '恢复',
        purge: '彻底删除',
        confirmPurge: '确认删除',
        restoring: '恢复中…',
        purging: '删除中…',
        unknownTitle: '（无标题会话）',
        unknownWorkspace: '未知工作区',
        subagents: '含 {count} 个子代理会话',
        incomplete: '元数据缺失，只能彻底删除',
        trashedAt: '{time} 移入',
        deleted: '已移入回收站',
        dialogTitle: '彻底删除会话？',
        dialogBody: '「{title}」的会话日志（含所有子代理会话）会移入回收站，并从工作区列表里隐藏。可以在「设置 → 会话回收站」恢复。',
        dialogLoaded: '这个会话仍在你当前的 DSH 实例里加载着（切换会话并不会释放它）。它的日志会移入回收站并从列表隐藏，但那个已打开的标签页不会自己关掉——记得手动关掉它。',
        dialogRunning: '该会话正在生成回复，请先停止（或等这一轮结束）再删除。',
        dialogError: '删除失败：{message}',
        trashBusy: '正在移入回收站…',
        trashAction: '移入回收站',
        restoreFailed: '恢复失败：{message}',
        purgeFailed: '删除失败：{message}',
        restored: '已恢复',
        purged: '已彻底删除',
        tabsBin: '回收站',
        tabsBatch: '批量清理',
        batchTitle: '批量清理会话',
        batchHint: '勾选后一次移入回收站；日志整份搬走，仍可在回收站恢复。正在生成回复的会话会被跳过。',
        selectAll: '全选',
        clearSelection: '清空选择',
        selectedCount: '已选 {count} 个',
        selectWorkspace: '全选本工作区',
        deselectWorkspace: '取消本工作区',
        batchEmpty: '没有可删除的会话。',
        batchTrash: '移入回收站',
        batchConfirm: '确认删除 {count} 个会话？',
        batchRunning: '正在移入 {count} 个…',
        batchDone: '已移入回收站 {count} 个',
        batchSkipped: '跳过 {count} 个',
        batchFailed: '批量删除失败：{message}',
        skipLive: '标签页还开着',
        skipRunning: '正在生成回复',
        skipNotFound: '日志已不存在',
        skipAlready: '已经在回收站里',
        skipArchive: '无法从列表隐藏',
        skipAlready: '已经在回收站里',
        skipAlready: '已经在回收站里了',
        skipAlready: '已在回收站里',
        skipAlready: '已在回收站里',
        skipAlready: '已在回收站里',
        skipAlready: '已经在回收站里了',
        skipConflict: '目标位置已有同名会话',
        skipBusy: '另一个删除正在进行',
        skipOther: '失败',
        archivedTag: '已归档',
        runningTag: '运行中',
        noWorkspace: '未分组',
      },
      en: {
        menuDelete: 'Delete permanently…',
        settingsLabel: 'Session recycle bin',
        settingsHint: 'Deleted Session logs wait here. Restoring puts one back in its workspace and its original position.',
        empty: 'The recycle bin is empty.',
        refresh: 'Refresh',
        emptyBin: 'Empty bin',
        confirmEmpty: 'Empty it',
        cancel: 'Cancel',
        loading: 'Loading…',
        loadFailed: 'Could not read the recycle bin: {message}',
        retry: 'Retry',
        restore: 'Restore',
        purge: 'Delete permanently',
        confirmPurge: 'Delete it',
        restoring: 'Restoring…',
        purging: 'Deleting…',
        unknownTitle: '(untitled Session)',
        unknownWorkspace: 'Unknown workspace',
        subagents: '{count} subagent Sessions included',
        incomplete: 'Metadata is missing; this entry can only be deleted permanently',
        trashedAt: 'moved {time}',
        deleted: 'Moved to the recycle bin',
        dialogTitle: 'Delete this Session permanently?',
        dialogBody: 'The Session log for “{title}” (including its subagent Sessions) moves into the recycle bin and is hidden from the workspace list. Restore it under Settings → Session recycle bin.',
        dialogLoaded: 'This Session is still loaded in the running app (switching away does not release it). Its log moves into the recycle bin and the row disappears, but that open tab does not close itself — close it by hand.',
        dialogRunning: 'This Session is generating a reply. Stop it, or wait for the turn to finish, before deleting.',
        dialogError: 'Delete failed: {message}',
        trashBusy: 'Moving to the recycle bin…',
        trashAction: 'Move to recycle bin',
        restoreFailed: 'Restore failed: {message}',
        purgeFailed: 'Delete failed: {message}',
        restored: 'Restored',
        purged: 'Deleted permanently',
        tabsBin: 'Recycle bin',
        tabsBatch: 'Batch cleanup',
        batchTitle: 'Batch cleanup',
        batchHint: 'Check Sessions and move them to the recycle bin in one go. The whole log moves and can still be restored. Sessions generating a reply are skipped.',
        selectAll: 'Select all',
        clearSelection: 'Clear selection',
        selectedCount: '{count} selected',
        selectWorkspace: 'Select this workspace',
        deselectWorkspace: 'Deselect this workspace',
        batchEmpty: 'No Sessions can be removed.',
        batchTrash: 'Move to recycle bin',
        batchConfirm: 'Delete {count} Sessions?',
        batchRunning: 'Moving {count}…',
        batchDone: 'Moved {count} to the recycle bin',
        batchSkipped: '{count} skipped',
        batchFailed: 'Batch delete failed: {message}',
        skipLive: 'its tab is still open',
        skipRunning: 'it is generating a reply',
        skipNotFound: 'the log is already gone',
        skipAlready: 'already in the recycle bin',
        skipArchive: 'could not be hidden from the list',
        skipAlready: 'it is already in the recycle bin',
        skipAlready: 'already in the recycle bin',
        skipAlready: 'already in the recycle bin',
        skipAlready: 'already in the recycle bin',
        skipAlready: 'already in the recycle bin',
        skipConflict: 'a Session with that name already exists there',
        skipBusy: 'another delete is running',
        skipOther: 'failed',
        archivedTag: 'archived',
        runningTag: 'running',
        noWorkspace: 'Ungrouped',
      },
    };

    let localeCtx = null;
    let lang = 'zh';

    function pickLang(ctx) {
      try {
        const active = ctx?.locale?.getSnapshot?.()?.active;
        if (typeof active === 'string' && active.length > 0) return active.toLowerCase().startsWith('zh') ? 'zh' : 'en';
      } catch {
        /* fall through to the browser */
      }
      const nav = typeof navigator === 'object' && navigator ? String(navigator.language || '') : '';
      return nav.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    function tt(key, vars) {
      const dict = STRINGS[lang] || STRINGS.en;
      let text = dict[key] ?? STRINGS.en[key] ?? key;
      if (vars) {
        for (const name of Object.keys(vars)) text = text.split(`{${name}}`).join(String(vars[name]));
      }
      return text;
    }

    function useLocale() {
      const [, force] = React.useState(0);
      React.useEffect(() => {
        const ctx = localeCtx;
        let off;
        try {
          off = ctx?.locale?.subscribe?.(() => {
            lang = pickLang(ctx);
            force((value) => value + 1);
          });
        } catch {
          off = undefined;
        }
        return () => {
          if (typeof off === 'function') off();
        };
      }, []);
      return tt;
    }

    /* ---------------------------------------------------------------- api */

    function messageOf(error) {
      if (error instanceof Error) return error.message;
      return String(error);
    }

    async function call(op, payload) {
      let response;
      try {
        response = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ op, ...(payload || {}) }),
        });
      } catch (error) {
        throw new Error(messageOf(error));
      }
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok || !data || data.ok !== true) {
        const message = data?.error?.message || `HTTP ${response.status}`;
        const failure = new Error(message);
        failure.code = data?.error?.code;
        throw failure;
      }
      return data;
    }

    function announceChange() {
      try {
        window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
      } catch {
        /* non-fatal */
      }
    }

    /* --------------------------------------------------------------- style */

    const CSS = `
.dst-btn{appearance:none;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);border-radius:6px;padding:4px 10px;font-size:12px;line-height:18px;
  cursor:pointer;font-family:inherit;transition:background .12s ease,border-color .12s ease}
.dst-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dst-btn:disabled{opacity:.55;cursor:default}
.dst-btn.danger{color:var(--dsw-alias-state-error-primary)}
.dst-btn.danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}
.dst-btn.ghost{border-color:transparent;background:transparent}
.dst-menu-item{display:flex;align-items:center;gap:8px;width:100%;height:32px;box-sizing:border-box;
  padding:0 8px;border:0;border-radius:8px;background:transparent;text-align:left;font-family:inherit;
  font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}
.dst-menu-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dst-menu-item svg{width:14px;height:14px;flex:none}
.dst-page{display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary)}
.dst-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dst-title{font-size:14px;font-weight:600;margin:0}
.dst-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dst-list{display:flex;flex-direction:column;border:1px solid var(--dsw-alias-border-l1);
  border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dst-row{display:flex;align-items:center;gap:12px;padding:10px 12px;
  border-top:1px solid var(--dsw-alias-border-l1)}
.dst-row:first-child{border-top:0}
.dst-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.dst-name{font-size:13px;line-height:20px;font-weight:500;white-space:nowrap;overflow:hidden;
  text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.dst-meta{font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dst-actions{display:flex;gap:6px;flex-shrink:0}
.dst-empty{padding:22px 12px;text-align:center;font-size:12.5px;color:var(--dsw-alias-label-secondary)}
.dst-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;margin:0}
.dst-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:18px;margin:0}
.dst-backdrop{position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;
  background:var(--dsw-alias-bg-mask-drop,rgba(0,0,0,.32));padding:16px}
.dst-dialog{width:min(420px,100%);box-sizing:border-box;background:var(--dsw-alias-bg-overlay);
  border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:18px;
  box-shadow:0 18px 48px rgba(0,0,0,.24);display:flex;flex-direction:column;gap:10px;
  color:var(--dsw-alias-label-primary);font-family:inherit}
.dst-dialog-title{font-size:14px;font-weight:600;margin:0;line-height:20px}
.dst-dialog-body{margin:0;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-secondary)}
.dst-dialog-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}
.dst-tabs{display:flex;gap:4px;padding-bottom:10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dst-tab{appearance:none;border:0;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:6px;
  padding:4px 10px;font-size:12.5px;line-height:18px;cursor:pointer;font-family:inherit}
.dst-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dst-tab.active{background:var(--dsw-alias-interactive-bg-active,var(--dsw-alias-interactive-bg-hover));
  color:var(--dsw-alias-label-primary);font-weight:600}
.dst-group{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
  background:var(--dsw-alias-bg-layer-1);overflow:hidden;margin-bottom:10px}
.dst-group-head{display:flex;align-items:center;gap:8px;padding:7px 12px;
  background:var(--dsw-alias-bg-layer-2);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dst-group-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  font-weight:600;color:var(--dsw-alias-label-primary)}
.dst-batch-row{display:flex;align-items:center;gap:10px;padding:7px 12px;cursor:pointer;
  border-top:1px solid var(--dsw-alias-border-l1);font-size:12.5px;line-height:20px}
.dst-batch-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dst-check{accent-color:var(--dsw-alias-brand-primary);width:14px;height:14px;flex-shrink:0;margin:0}
.dst-row-name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dst-tag{flex-shrink:0;font-size:10.5px;line-height:17px;padding:0 6px;border-radius:999px;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dst-batch-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dst-batch-skip{margin:0;padding-left:18px;font-size:11.5px;line-height:18px;
  color:var(--dsw-alias-state-warn-primary)}
`;

    function Style() {
      return h('style', null, CSS);
    }

    function IconTrash({ size = 15, color = 'currentColor' }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true, style: { flexShrink: 0 } },
        h('path', {
          d: 'M3 4.5h10M6.5 4.5V3.2c0-.4.3-.7.7-.7h1.6c.4 0 .7.3.7.7v1.3M4.3 4.5l.6 8.1c0 .5.4.9.9.9h4.4c.5 0 .9-.4.9-.9l.6-8.1',
          stroke: color,
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      );
    }

    /* ------------------------------------------------------- delete dialog */

    let deleteRequest = null;
    const requestListeners = new Set();

    function openDeleteDialog(sessionId, title) {
      deleteRequest = { sessionId, title: title || '' };
      for (const listener of requestListeners) listener();
    }

    function closeDeleteDialog() {
      deleteRequest = null;
      for (const listener of requestListeners) listener();
    }

    function useDeleteRequest() {
      const [request, setRequest] = React.useState(deleteRequest);
      React.useEffect(() => {
        const listener = () => setRequest(deleteRequest);
        requestListeners.add(listener);
        listener();
        return () => {
          requestListeners.delete(listener);
        };
      }, []);
      return request;
    }

    function DeleteDialog() {
      const t = useLocale();
      const request = useDeleteRequest();
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState(null);
      const [probe, setProbe] = React.useState(null);
      const cancelRef = React.useRef(null);

      const key = request ? request.sessionId : null;
      // Ask the Host whether the turn is generating before offering the action:
      // "loaded" is a warning, "running" is a refusal.
      React.useEffect(() => {
        if (!key) return undefined;
        let alive = true;
        setProbe(null);
        call('inspect', { sessionId: key })
          .then((data) => {
            if (alive) setProbe({ live: Boolean(data.live), running: Boolean(data.running) });
          })
          .catch(() => {
            if (alive) setProbe(null);
          });
        return () => {
          alive = false;
        };
      }, [key]);

      React.useEffect(() => {
        if (!key) return undefined;
        setError(null);
        setBusy(false);
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            closeDeleteDialog();
          }
        };
        document.addEventListener('keydown', onKeyDown);
        const focusTimer = setTimeout(() => {
          try {
            cancelRef.current?.focus?.();
          } catch {
            /* ignore */
          }
        }, 0);
        return () => {
          document.removeEventListener('keydown', onKeyDown);
          clearTimeout(focusTimer);
        };
      }, [key]);

      if (!request) return null;

      const title = request.title || t('unknownTitle');
      const running = Boolean(probe && probe.running);
      const loaded = Boolean(probe && probe.live && !running);
      const confirm = async () => {
        if (busy || running) return;
        setBusy(true);
        setError(null);
        try {
          await call('trash', { sessionId: request.sessionId, title: request.title });
          announceChange();
          closeDeleteDialog();
        } catch (failure) {
          setError(t('dialogError', { message: messageOf(failure) }));
          setBusy(false);
        }
      };

      return h(
        React.Fragment,
        null,
        h(Style),
        h(
          'div',
          {
            className: 'dst-backdrop',
            onMouseDown: (event) => {
              if (event.target === event.currentTarget && !busy) closeDeleteDialog();
            },
          },
          h(
            'div',
            { className: 'dst-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dst-dialog-title' },
            h('h2', { className: 'dst-dialog-title', id: 'dst-dialog-title' }, t('dialogTitle')),
            h('p', { className: 'dst-dialog-body' }, t('dialogBody', { title })),
            loaded ? h('p', { className: 'dst-warn' }, t('dialogLoaded')) : null,
            running ? h('p', { className: 'dst-error', role: 'alert' }, t('dialogRunning')) : null,
            error ? h('p', { className: 'dst-error', role: 'alert' }, error) : null,
            h(
              'div',
              { className: 'dst-dialog-actions' },
              h(
                'button',
                { type: 'button', className: 'dst-btn', ref: cancelRef, disabled: busy, onClick: closeDeleteDialog },
                t('cancel'),
              ),
              h(
                'button',
                { type: 'button', className: 'dst-btn danger', disabled: busy || running, onClick: confirm },
                busy ? t('trashBusy') : t('trashAction'),
              ),
            ),
          ),
        ),
      );
    }

    /* ---------------------------------------------------------- menu row */

    function TrashRow(props) {
      const t = useLocale();
      // The slot guarantees the MenuOpenState hook; calling it at the top level
      // keeps the hook order stable across renders.
      const [, setMenuOpen] = props.useMenuOpenState();
      const select = () => {
        try {
          setMenuOpen(false);
        } catch {
          /* the menu may already be closing */
        }
        openDeleteDialog(props.sessionId, props.displayTitle);
      };

      // `MenuItemButton` may be a plain function or a forwardRef/memo object;
      // both render, so test for presence rather than for `typeof function`.
      const MenuItemButton = primitives && primitives.MenuItemButton;
      if (MenuItemButton) {
        const TrashIcon = primitives.IconTrashOutlineRegular || primitives.IconTrashOutline;
        return h(MenuItemButton, {
          icon: TrashIcon ? h(TrashIcon, { size: 14 }) : undefined,
          onSelect: select,
          children: t('menuDelete'),
        });
      }

      return h(
        'button',
        { type: 'button', role: 'menuitem', className: 'dst-menu-item', onClick: select },
        h(IconTrash, null),
        h('span', null, t('menuDelete')),
      );
    }

    /* ------------------------------------------------------------- bin page */

    function formatBytes(bytes) {
      const value = Number(bytes) || 0;
      if (value < 1024) return `${value} B`;
      const units = ['KB', 'MB', 'GB'];
      let scaled = value / 1024;
      let index = 0;
      while (scaled >= 1024 && index < units.length - 1) {
        scaled /= 1024;
        index += 1;
      }
      return `${scaled >= 10 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[index]}`;
    }

    function formatTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '';
      try {
        return new Date(value).toLocaleString();
      } catch {
        return '';
      }
    }

    function BinPanel() {
      const t = useLocale();
      const [state, setState] = React.useState({ status: 'loading', entries: [], error: null });
      const [emptyConfirm, setEmptyConfirm] = React.useState(false);
      const [busyId, setBusyId] = React.useState(null);
      const [confirmId, setConfirmId] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const alive = React.useRef(true);

      const load = React.useCallback(async () => {
        setState((current) => ({ ...current, status: 'loading', error: null }));
        try {
          const data = await call('list');
          if (!alive.current) return;
          setState({ status: 'ready', entries: Array.isArray(data.entries) ? data.entries : [], error: null });
        } catch (failure) {
          if (!alive.current) return;
          setState({ status: 'error', entries: [], error: t('loadFailed', { message: messageOf(failure) }) });
        }
      }, [t]);

      React.useEffect(() => {
        alive.current = true;
        load();
        const onChange = () => load();
        window.addEventListener(CHANGE_EVENT, onChange);
        return () => {
          alive.current = false;
          window.removeEventListener(CHANGE_EVENT, onChange);
        };
      }, [load]);

      const restore = async (entry) => {
        if (busyId) return;
        setBusyId(entry.id);
        setNotice(null);
        try {
          const data = await call('restore', { entryId: entry.id });
          const warnings = Array.isArray(data.warnings) ? data.warnings : [];
          setNotice(warnings.length > 0 ? warnings.join(' ') : t('restored'));
          announceChange();
        } catch (failure) {
          setNotice(t('restoreFailed', { message: messageOf(failure) }));
        } finally {
          setBusyId(null);
          setConfirmId(null);
        }
      };

      const purge = async (entry) => {
        if (busyId) return;
        setBusyId(entry.id);
        setNotice(null);
        try {
          await call('purge', { entryId: entry.id });
          setNotice(t('purged'));
          announceChange();
        } catch (failure) {
          setNotice(t('purgeFailed', { message: messageOf(failure) }));
        } finally {
          setBusyId(null);
          setConfirmId(null);
        }
      };

      const emptyBin = async () => {
        if (busyId) return;
        setBusyId('*');
        setNotice(null);
        try {
          await call('empty');
          setNotice(t('purged'));
          announceChange();
        } catch (failure) {
          setNotice(t('purgeFailed', { message: messageOf(failure) }));
        } finally {
          setBusyId(null);
          setEmptyConfirm(false);
        }
      };

      const rows = state.entries.map((entry) => {
        const name = entry.title || entry.sessionId || t('unknownTitle');
        const parts = [];
        parts.push(entry.workspaceTitle || entry.workspacePath || t('unknownWorkspace'));
        if (entry.trashedAt) parts.push(t('trashedAt', { time: formatTime(entry.trashedAt) }));
        parts.push(formatBytes(entry.bytes));
        if (entry.subagentCount > 0) parts.push(t('subagents', { count: entry.subagentCount }));

        const confirming = confirmId === entry.id;
        return h(
          'div',
          { className: 'dst-row', key: entry.id },
          h(
            'div',
            { className: 'dst-main' },
            h('div', { className: 'dst-name', title: name }, name),
            h('div', { className: 'dst-meta', title: parts.join(' · ') }, parts.join(' · ')),
            entry.incomplete ? h('div', { className: 'dst-meta' }, t('incomplete')) : null,
          ),
          h(
            'div',
            { className: 'dst-actions' },
            confirming
              ? [
                  h(
                    'button',
                    {
                      type: 'button',
                      key: 'yes',
                      className: 'dst-btn danger',
                      disabled: busyId !== null,
                      onClick: () => purge(entry),
                    },
                    busyId === entry.id ? t('purging') : t('confirmPurge'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      key: 'no',
                      className: 'dst-btn ghost',
                      disabled: busyId !== null,
                      onClick: () => setConfirmId(null),
                    },
                    t('cancel'),
                  ),
                ]
              : [
                  entry.incomplete
                    ? null
                    : h(
                        'button',
                        {
                          type: 'button',
                          key: 'restore',
                          className: 'dst-btn',
                          disabled: busyId !== null,
                          onClick: () => restore(entry),
                        },
                        busyId === entry.id ? t('restoring') : t('restore'),
                      ),
                  h(
                    'button',
                    {
                      type: 'button',
                      key: 'purge',
                      className: 'dst-btn danger',
                      disabled: busyId !== null,
                      onClick: () => setConfirmId(entry.id),
                    },
                    t('purge'),
                  ),
                ],
          ),
        );
      });

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dst-head' },
          h('h2', { className: 'dst-title' }, t('settingsLabel')),
          h(
            'button',
            { type: 'button', className: 'dst-btn ghost', disabled: state.status === 'loading', onClick: load },
            t('refresh'),
          ),
          state.entries.length > 0
            ? emptyConfirm
              ? [
                  h(
                    'button',
                    { type: 'button', key: 'yes', className: 'dst-btn danger', disabled: busyId !== null, onClick: emptyBin },
                    busyId === '*' ? t('purging') : t('confirmEmpty'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      key: 'no',
                      className: 'dst-btn ghost',
                      disabled: busyId !== null,
                      onClick: () => setEmptyConfirm(false),
                    },
                    t('cancel'),
                  ),
                ]
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dst-btn danger',
                    disabled: busyId !== null,
                    onClick: () => setEmptyConfirm(true),
                  },
                  t('emptyBin'),
                )
            : null,
        ),
        h('p', { className: 'dst-note' }, t('settingsHint')),
        notice ? h('p', { className: 'dst-error', role: 'status' }, notice) : null,
        state.status === 'error'
          ? h(
              'div',
              null,
              h('p', { className: 'dst-error', role: 'alert' }, state.error),
              h('button', { type: 'button', className: 'dst-btn', onClick: load }, t('retry')),
            )
          : null,
        state.status === 'loading' && state.entries.length === 0
          ? h('div', { className: 'dst-list' }, h('div', { className: 'dst-empty' }, t('loading')))
          : state.entries.length === 0
            ? h('div', { className: 'dst-list' }, h('div', { className: 'dst-empty' }, t('empty')))
            : h('div', { className: 'dst-list', role: 'list' }, rows),
      );
    }

    /* ---------------------------------------------------------- batch page */

    // E_LIVE only reaches us from a Host half that predates the running-only
    // fence (the Host needs an app restart, the client does not), so keep its
    // own wording instead of pretending the turn is generating.
    const SKIP_KEYS = {
      E_RUNNING: 'skipRunning',
      E_LIVE: 'skipLive',
      E_NOT_FOUND: 'skipNotFound',
      E_ALREADY_TRASHED: 'skipAlready',
      E_ARCHIVE: 'skipArchive',
      E_CONFLICT: 'skipConflict',
      E_BLOCKED: 'skipBusy',
      E_BUSY: 'skipBusy',
    };

    function BatchPanel(props) {
      const t = useLocale();
      // One subscription each, like the shipped settings panels: the selector
      // returns the whole snapshot so membership and titles agree per render.
      const workspaceState = props.useWorkspaces((snapshot) => snapshot);
      const sessionState = props.useSessions((snapshot) => snapshot);
      const items = workspaceState ? workspaceState.items : undefined;
      const archivedIds = workspaceState ? workspaceState.archivedSessionIds : undefined;
      const byId = sessionState ? sessionState.byId : undefined;
      const sessionIds = sessionState ? sessionState.ids : undefined;
      const statuses = props.useSessionStatus((snapshot) => snapshot);
      const isRunning = (id) => {
        if (!statuses || typeof statuses.get !== 'function') return false;
        const status = statuses.get(id);
        return Boolean(status && status.running);
      };
      const archived = React.useMemo(() => new Set(Array.isArray(archivedIds) ? archivedIds : []), [archivedIds]);

      const groups = React.useMemo(() => {
        const rows = byId && typeof byId === 'object' ? byId : {};
        // Mirror the shipped list: a trashed Session is archived, and archived
        // rows are hidden from the default view. Keeping them here would let a
        // second pass select a Session whose log has already left its directory.
        const usable = (id) => {
          const row = rows[id];
          return Boolean(row) && row.blank !== true && row.origin !== 'subagent' && !archived.has(id);
        };
        const known = new Set();
        const result = [];
        for (const workspace of Array.isArray(items) ? items : []) {
          const members = (Array.isArray(workspace.sessionIds) ? workspace.sessionIds : []).filter(usable);
          for (const id of members) known.add(id);
          if (members.length > 0) {
            result.push({
              key: workspace.workspaceId,
              label: workspace.title || workspace.cwd || t('unknownWorkspace'),
              ids: members,
            });
          }
        }
        const loose = (Array.isArray(sessionIds) ? sessionIds : []).filter((id) => !known.has(id) && usable(id));
        if (loose.length > 0) result.push({ key: '__ungrouped__', label: t('noWorkspace'), ids: loose });
        return result;
      }, [items, byId, sessionIds, archived, t]);

      const [selected, setSelected] = React.useState(() => new Set());
      const [busy, setBusy] = React.useState(false);
      const [confirming, setConfirming] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const [outcome, setOutcome] = React.useState(null);

      // A row can leave the list (deleted elsewhere, or it started running)
      // while it is checked.
      React.useEffect(() => {
        const valid = new Set();
        for (const group of groups) {
          for (const id of group.ids) if (!isRunning(id)) valid.add(id);
        }
        setSelected((current) => {
          let changed = false;
          const next = new Set();
          for (const id of current) {
            if (valid.has(id)) next.add(id);
            else changed = true;
          }
          return changed ? next : current;
        });
      }, [groups, statuses]);

      const allIds = React.useMemo(
        () => groups.flatMap((group) => group.ids.filter((id) => !isRunning(id))),
        [groups, statuses],
      );
      const count = selected.size;

      const toggle = (id) => {
        setOutcome(null);
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      };

      const setGroup = (ids, on) => {
        setOutcome(null);
        setSelected((current) => {
          const next = new Set(current);
          for (const id of ids) {
            if (on) next.add(id);
            else next.delete(id);
          }
          return next;
        });
      };

      const runBatch = async () => {
        if (busy || selected.size === 0) return;
        setBusy(true);
        setNotice(null);
        try {
          const data = await call('trash-many', { sessionIds: [...selected] });
          const results = Array.isArray(data.results) ? data.results : [];
          const failed = results.filter((result) => !result.ok);
          setOutcome({ trashed: Number(data.trashed) || 0, failed });
          setSelected(new Set());
          setConfirming(false);
          announceChange();
        } catch (failure) {
          setNotice(t('batchFailed', { message: messageOf(failure) }));
        } finally {
          setBusy(false);
        }
      };

      const titleOf = (id) => {
        const row = byId ? byId[id] : undefined;
        const title = row && typeof row.title === 'string' ? row.title.trim() : '';
        return title || id;
      };

      const reasonOf = (result) => {
        const key = SKIP_KEYS[result.code];
        if (key) return t(key);
        return result.message || t('skipOther');
      };

      const groupNodes = groups.map((group) => {
        const selectable = group.ids.filter((id) => !isRunning(id));
        const every = selectable.length > 0 && selectable.every((id) => selected.has(id));
        return h(
          'div',
          { className: 'dst-group', key: group.key },
          h(
            'div',
            { className: 'dst-group-head' },
            h('span', { className: 'dst-group-name', title: group.label }, group.label),
            h('span', null, String(group.ids.length)),
            h(
              'button',
              {
                type: 'button',
                className: 'dst-btn ghost',
                disabled: busy,
                onClick: () => setGroup(selectable, !every),
              },
              every ? t('deselectWorkspace') : t('selectWorkspace'),
            ),
          ),
          group.ids.map((id) => {
            const row = byId ? byId[id] : undefined;
            const name = titleOf(id);
            const when = row ? formatTime(row.createdAt) : '';
            const running = isRunning(id);
            return h(
              'label',
              { className: 'dst-batch-row', key: id },
              h('input', {
                type: 'checkbox',
                className: 'dst-check',
                checked: selected.has(id),
                disabled: busy || running,
                onChange: () => toggle(id),
              }),
              h('span', { className: 'dst-row-name', title: name }, name),
              running ? h('span', { className: 'dst-tag' }, t('runningTag')) : null,
              archived.has(id) ? h('span', { className: 'dst-tag' }, t('archivedTag')) : null,
              when ? h('span', { className: 'dst-tag' }, when) : null,
            );
          }),
        );
      });

      return h(
        React.Fragment,
        null,
        h(
          'div',
          { className: 'dst-head' },
          h('h2', { className: 'dst-title' }, t('batchTitle')),
          h('span', { className: 'dst-note' }, t('selectedCount', { count })),
          h(
            'button',
            {
              type: 'button',
              className: 'dst-btn ghost',
              disabled: busy || count === allIds.length,
              onClick: () => setGroup(allIds, true),
            },
            t('selectAll'),
          ),
          h(
            'button',
            { type: 'button', className: 'dst-btn ghost', disabled: busy || count === 0, onClick: () => setGroup(allIds, false) },
            t('clearSelection'),
          ),
        ),
        h('p', { className: 'dst-note' }, t('batchHint')),
        notice ? h('p', { className: 'dst-error', role: 'alert' }, notice) : null,
        outcome
          ? h(
              'div',
              null,
              h(
                'p',
                { className: 'dst-note', role: 'status' },
                outcome.failed.length > 0
                  ? `${t('batchDone', { count: outcome.trashed })} · ${t('batchSkipped', { count: outcome.failed.length })}`
                  : t('batchDone', { count: outcome.trashed }),
              ),
              outcome.failed.length > 0
                ? h(
                    'ul',
                    { className: 'dst-batch-skip' },
                    outcome.failed.slice(0, 8).map((result) =>
                      h('li', { key: result.sessionId }, `${titleOf(result.sessionId)}：${reasonOf(result)}`),
                    ),
                  )
                : null,
            )
          : null,
        groups.length === 0
          ? h('div', { className: 'dst-list' }, h('div', { className: 'dst-empty' }, t('batchEmpty')))
          : groupNodes,
        h(
          'div',
          { className: 'dst-batch-foot' },
          confirming
            ? [
                h(
                  'button',
                  { type: 'button', key: 'yes', className: 'dst-btn danger', disabled: busy, onClick: runBatch },
                  busy ? t('batchRunning', { count }) : t('batchConfirm', { count }),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    key: 'no',
                    className: 'dst-btn ghost',
                    disabled: busy,
                    onClick: () => setConfirming(false),
                  },
                  t('cancel'),
                ),
              ]
            : h(
                'button',
                {
                  type: 'button',
                  className: 'dst-btn danger',
                  disabled: busy || count === 0,
                  onClick: () => setConfirming(true),
                },
                t('batchTrash'),
              ),
        ),
      );
    }

    /* -------------------------------------------------------------- page tabs */

    function TrashPage(props) {
      const t = useLocale();
      const [tab, setTab] = React.useState('bin');
      const tabButton = (id, label) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            'aria-selected': tab === id,
            className: tab === id ? 'dst-tab active' : 'dst-tab',
            onClick: () => setTab(id),
          },
          label,
        );
      return h(
        'div',
        { className: 'dst-page' },
        h(Style),
        h(
          'div',
          { className: 'dst-tabs', role: 'tablist' },
          tabButton('bin', t('tabsBin')),
          tabButton('batch', t('tabsBatch')),
        ),
        tab === 'bin' ? h(BinPanel, null) : h(BatchPanel, props),
      );
    }

    /* ---------------------------------------------------------------- apply */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        localeCtx = ctx;
        lang = pickLang(ctx);
        try {
          ctx.effect(() => ctx.locale.subscribe(() => {
            lang = pickLang(ctx);
          }), 'session-trash: locale');
        } catch {
          /* locale is optional for this half */
        }

        ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
          name: 'sidebar.workspaces.session.menu.item',
          id: 'session-trash-delete',
          order: 500,
        }, TrashRow));

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'session-trash',
          order: 45,
          label: () => tt('settingsLabel'),
        }, TrashPage));

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'session-trash-dialog',
          order: 60,
        }, DeleteDialog));
      },
    };
  },
});
