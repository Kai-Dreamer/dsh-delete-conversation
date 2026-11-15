/**
 * Delete Conversation — Client half.
 *
 * Adds the first row of the Session "..." menu, asks for confirmation in a
 * portalled dialog, and calls the Host route that removes the session log from
 * disk. Only top-level conversations expose the action; a subagent row is
 * deleted together with its parent instead of on its own.
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-delete-conversation',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = 'delete-conversation'
    /** Keyed glyph rendered by the shared context-menu icon slot. */
    const ICON_KEY = 'delete-conversation.trash'
    /** Document-relative Host route; the page is served at the document root. */
    const ROUTE = 'api/conversation-delete'
    /** Menu position ahead of the first built-in action (pin, order 100). */
    const MENU_ORDER = 10
    /** How long the success notice stays on screen. */
    const TOAST_MS = 3500
    /** Delay before the first reconciliation, so the initial list pull can land. */
    const STALE_SWEEP_MS = 1200
    /** Reconciliation passes after a delete; the last settles a slow Agent teardown. */
    const SWEEP_DELAYS = [300, 1200, 3000]
    /** Local-storage key remembering the ids this browser deleted for good. */
    const TOMBSTONE_KEY = 'delete-conversation.deleted-ids'
    /** Upper bound on remembered ids so the record cannot grow without limit. */
    const TOMBSTONE_LIMIT = 200
    /** Local list poll that keeps a re-introduced tombstoned row out of the sidebar. */
    const TOMBSTONE_POLL_MS = 2000
    /** Delay before taking focus, after the closing menu returns it to the row trigger. */
    const FOCUS_DELAY_MS = 220

    const zh = {
      'menu.delete': '删除会话',
      'dialog.title': '删除会话？',
      'dialog.description': '确定要永久删除“{title}”吗？本机上的会话日志将被移除。',
      'dialog.warning': '此操作无法撤销。该会话的本机日志、子代理会话以及指向它的提醒都会被永久删除；其中正在运行的任务会先被停止。',
      'dialog.warningOpen': '当前打开的就是这个会话；确认后会先切换到新会话，再执行删除。',
      'dialog.close': '关闭',
      'dialog.cancel': '取消',
      'dialog.confirm': '删除会话',
      'dialog.deleting': '删除中…',
      'dialog.active': '该会话中仍有任务未能停止，暂时无法删除。请稍后重试。',
      'dialog.notFound': '该会话已不存在。',
      'dialog.unavailable': '当前环境不支持删除会话。',
      'dialog.closeCurrentFailed': '无法关闭当前打开的会话。请先取消，切换到其他会话后再试。',
      'dialog.failed': '删除会话失败，请重试。',
      'toast.deleted': '会话已删除',
      'toast.partial': '会话已删除，但部分子代理文件未能移除',
    }

    const en = {
      'menu.delete': 'Delete session',
      'dialog.title': 'Delete session?',
      'dialog.description': 'Permanently delete “{title}”? Its local session log will be removed from this device.',
      'dialog.warning': 'This cannot be undone. The session\'s local logs, its subagent sessions, and reminders targeting it are permanently removed; running work in the session is stopped first.',
      'dialog.warningOpen': 'This is the session on screen; it will be closed and replaced by a new session before the delete runs.',
      'dialog.close': 'Close',
      'dialog.cancel': 'Cancel',
      'dialog.confirm': 'Delete session',
      'dialog.deleting': 'Deleting…',
      'dialog.active': 'Some work in this session could not be stopped, so it cannot be deleted yet. Try again shortly.',
      'dialog.notFound': 'This session no longer exists.',
      'dialog.unavailable': 'Deleting sessions is not available in this environment.',
      'dialog.closeCurrentFailed': 'The open session could not be closed. Cancel, switch to another session, then try again.',
      'dialog.failed': 'Deleting the session failed. Try again.',
      'toast.deleted': 'Session deleted',
      'toast.partial': 'Session deleted, but some subagent files could not be removed',
    }

    // Scoped under .dsh-dc-* and referencing only host theme tokens. The
    // stylesheet travels inside the overlay entry, so unmounting removes it.
    const CSS = `
      .dsh-dc-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35));backdrop-filter:var(--dsw-mask-blur,none)}
      .dsh-dc-dialog{box-sizing:border-box;display:flex;flex-direction:column;width:min(440px,100%);max-height:calc(100dvh - 48px);overflow:auto;border-radius:var(--dsw-radius-panel,16px);background:var(--dsw-alias-bg-layer-2,#fff);box-shadow:var(--dsw-elevation-prominent,0 16px 48px rgba(0,0,0,.24));color:var(--dsw-alias-label-primary,#1f2329);animation:dsh-dc-enter .16s ease-out}
      @keyframes dsh-dc-enter{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
      @media (prefers-reduced-motion: reduce){.dsh-dc-dialog,.dsh-dc-toast{animation:none}}
      .dsh-dc-header{display:flex;align-items:center;gap:8px;padding:22px 14px 8px 24px}
      .dsh-dc-title{flex:1;margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary,#1f2329)}
      .dsh-dc-close{flex:none;display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-secondary,#5c6370);cursor:pointer}
      .dsh-dc-close:disabled{cursor:not-allowed;opacity:.4}
      .dsh-dc-close:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
      .dsh-dc-description{margin:0;padding:0 24px;font-size:14px;line-height:22px;color:var(--dsw-alias-label-secondary,#5c6370)}
      .dsh-dc-warning{margin:14px 24px 0;padding:10px 12px;border-radius:var(--dsw-radius-sm,8px);background:var(--dsw-alias-state-warn-tertiary,#fff7e6);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary,#1f2329)}
      .dsh-dc-warning-open{display:block;margin-top:4px;color:var(--dsw-alias-label-secondary,#5c6370)}
      .dsh-dc-error{margin:12px 24px 0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#d33)}
      .dsh-dc-footer{display:flex;justify-content:flex-end;gap:8px;padding:20px 24px 24px}
      .dsh-dc-button{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md,10px);font:inherit;font-size:14px;line-height:22px;cursor:pointer;background:transparent;color:var(--dsw-alias-label-primary,#1f2329)}
      .dsh-dc-button:disabled{cursor:not-allowed;opacity:.4}
      .dsh-dc-button:focus-visible,.dsh-dc-close:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d6bfe));outline-offset:2px}
      .dsh-dc-secondary{box-shadow:inset 0 0 0 var(--dsh-hairline-width,.5px) var(--dsw-alias-border-l3,#d9d9d9)}
      .dsh-dc-secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
      .dsh-dc-danger{box-shadow:inset 0 0 0 var(--dsh-hairline-width,.5px) var(--dsw-alias-state-error-primary,#d33);color:var(--dsw-alias-state-error-primary,#d33)}
      .dsh-dc-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#d33) 8%,transparent)}
      .dsh-dc-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
      .dsh-dc-toast{position:fixed;left:50%;bottom:28px;z-index:1001;transform:translateX(-50%);max-width:min(420px,calc(100vw - 48px));padding:10px 16px;border-radius:var(--dsw-radius-md,10px);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));background:var(--dsw-alias-bg-overlay,#fff);box-shadow:var(--dsw-elevation-prominent,0 16px 48px rgba(0,0,0,.24));color:var(--dsw-alias-label-primary,#1f2329);font-size:13px;line-height:20px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}
    `

    /**
     * Minimal observable snapshot store: the slot machinery turns an injected
     * `hooks` entry into a selector hook with the same contract built-in
     * controllers use.
     * @param {object} initial - immutable initial state.
     * @returns {{ getSnapshot: () => object, subscribe: (listener: () => void) => (() => void), set: (next: object) => void }}
     */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set(next) {
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    /**
     * Menu glyph: the harness's own `trash-outline` regular geometry (16 unit
     * grid, one-unit stroke, butt caps), so it matches the built-in action
     * icons instead of inventing a second trash silhouette.
     */
    function TrashIcon() {
      return h('svg', {
        width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none',
        strokeWidth: 1, 'aria-hidden': 'true', style: { display: 'block' },
      },
      h('path', { d: 'M1.28149 3.88831H14.7187', stroke: 'currentColor' }),
      h('path', {
        d: 'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
        stroke: 'currentColor',
      }),
      h('path', {
        d: 'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
        stroke: 'currentColor',
      }),
      h('path', { d: 'M6.44946 6.98926V11.1238', stroke: 'currentColor' }),
      h('path', { d: 'M9.55054 6.98926V11.1238', stroke: 'currentColor' }))
    }

    /** Close glyph for the dialog header. */
    function CloseIcon() {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M4 4l8 8M12 4l-8 8',
          stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
        }))
    }

    /**
     * The portalled confirmation surface and success notice. One request is
     * active at a time; the dialog owns keyboard dismissal, a focused
     * three-control cycle, and the error line, while the store owns the
     * operation itself.
     * @param {{ useDeleteConversation: Function, cancelDelete: () => void, confirmDelete: () => void, t: Function }} props
     * @returns {object | null} the portalled dialog and/or notice, or null when idle.
     */
    function DeleteOverlay({ useDeleteConversation, cancelDelete, confirmDelete, t }) {
      const state = useDeleteConversation(snapshot => snapshot)
      const request = state.request
      const busy = state.busy
      const error = state.error
      const toast = state.toast
      const open = request !== null
      const dialogRef = React.useRef(null)
      const cancelRef = React.useRef(null)
      const returnFocusRef = React.useRef(null)
      const titleId = React.useId()
      const bodyId = React.useId()
      const warningId = React.useId()

      // Focus moves into the dialog after the closing context menu has
      // returned focus to its trigger, and back to that trigger on close.
      React.useEffect(() => {
        if (!open) return undefined
        const timer = setTimeout(() => {
          if (returnFocusRef.current === null) {
            returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          }
          if (!busy) cancelRef.current?.focus()
        }, FOCUS_DELAY_MS)
        return () => {
          clearTimeout(timer)
          const target = returnFocusRef.current
          if (target !== null && target.isConnected) target.focus()
        }
      }, [open])

      // Escape and Tab are captured before the rest of the application sees
      // them, because this surface is the topmost interaction. While the
      // delete is pending every control is disabled, so Tab is contained on
      // the dialog itself instead of escaping into the page behind.
      React.useEffect(() => {
        if (!open) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') {
            if (busy) return
            event.preventDefault()
            event.stopImmediatePropagation()
            cancelDelete()
            return
          }
          if (event.key !== 'Tab') return
          const dialog = dialogRef.current
          if (dialog === null) return
          const focusable = [...dialog.querySelectorAll('button:not(:disabled)')]
          if (focusable.length === 0) {
            event.preventDefault()
            dialog.focus()
            return
          }
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          const active = document.activeElement
          const inside = active instanceof Node && dialog.contains(active)
          if (event.shiftKey && (!inside || active === first)) {
            event.preventDefault()
            event.stopImmediatePropagation()
            last.focus()
          } else if (!event.shiftKey && (!inside || active === last)) {
            event.preventDefault()
            event.stopImmediatePropagation()
            first.focus()
          }
        }
        window.addEventListener('keydown', onKeyDown, true)
        return () => window.removeEventListener('keydown', onKeyDown, true)
      }, [open, busy, cancelDelete])

      // The page behind a modal must not scroll under it.
      React.useEffect(() => {
        if (!open) return undefined
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => { document.body.style.overflow = previous }
      }, [open])

      if (!open && toast === null) return null
      const content = h(React.Fragment, null,
        h('style', null, CSS),
        open
          ? h('div', {
            className: 'dsh-dc-backdrop',
            onPointerDown: (event) => {
              if (event.target === event.currentTarget && !busy) cancelDelete()
            },
          },
          h('div', {
            ref: dialogRef,
            className: 'dsh-dc-dialog',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-busy': busy || undefined,
            'aria-labelledby': titleId,
            'aria-describedby': `${bodyId} ${warningId}`,
            tabIndex: -1,
          },
          h('div', { className: 'dsh-dc-header' },
            h('h2', { id: titleId, className: 'dsh-dc-title' }, t('dialog.title')),
            h('button', {
              type: 'button',
              className: 'dsh-dc-close',
              'aria-label': t('dialog.close'),
              title: t('dialog.close'),
              disabled: busy,
              onClick: cancelDelete,
            }, h(CloseIcon))),
          h('p', { id: bodyId, className: 'dsh-dc-description' }, t('dialog.description', { title: request.displayTitle })),
          h('div', { id: warningId, className: 'dsh-dc-warning' },
            t('dialog.warning'),
            request.wasMainView
              ? h('span', { className: 'dsh-dc-warning-open' }, t('dialog.warningOpen'))
              : null),
          h('div', { className: 'dsh-dc-sr', role: 'status', 'aria-live': 'polite' }, busy ? t('dialog.deleting') : ''),
          error !== null ? h('div', { className: 'dsh-dc-error', role: 'alert' }, error) : null,
          h('div', { className: 'dsh-dc-footer' },
            h('button', {
              ref: cancelRef,
              type: 'button',
              className: 'dsh-dc-button dsh-dc-secondary',
              disabled: busy,
              onClick: cancelDelete,
            }, t('dialog.cancel')),
            h('button', {
              type: 'button',
              className: 'dsh-dc-button dsh-dc-danger',
              disabled: busy,
              onClick: confirmDelete,
            }, busy ? t('dialog.deleting') : t('dialog.confirm')),
          )))
          : null,
        toast === null ? null : h('div', { className: 'dsh-dc-toast', role: 'status' }, toast),
      )
      return ReactDOM.createPortal(content, document.body)
    }

    /**
     * Read the ids this browser deleted permanently from local storage.
     * @returns {Set<string>} remembered Session ids; empty when storage is unusable.
     */
    function loadTombstones() {
      try {
        const raw = window.localStorage?.getItem(TOMBSTONE_KEY)
        const parsed = raw === null || raw === undefined ? [] : JSON.parse(raw)
        return new Set(Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [])
      } catch {
        return new Set()
      }
    }

    return {
      inject: ['slots', 'locale', 'contextMenus'],

      /**
       * Register dictionaries, the first Session-menu action, its glyph, and
       * the confirmation overlay.
       * @param {import('@deepseek-ai/cordis').Context} ctx - Client context.
       * @returns {void}
       */
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'delete-conversation: dictionaries')

        const store = createStore({ request: null, busy: false, error: null, toast: null })
        let toastTimer
        /** Pending post-delete reconciliation timers, cleared when the bundle unloads. */
        const sweepTimers = new Set()
        /**
         * Ids this page deleted for good. The Host derives its list from persisted
         * logs *and* live Session objects, so a Session whose files are gone can
         * still be announced or listed again while its Agent finishes tearing
         * down; a tombstone keeps that row out of the sidebar meanwhile.
         */
        const tombstones = loadTombstones()

        /**
         * Remember one deleted Session and persist the record for the next load.
         * @param {string} sessionId - the Session whose files were removed.
         * @returns {void}
         */
        const rememberDeleted = (sessionId) => {
          tombstones.add(sessionId)
          while (tombstones.size > TOMBSTONE_LIMIT) {
            const oldest = tombstones.values().next().value
            if (oldest === undefined) break
            tombstones.delete(oldest)
          }
          try {
            window.localStorage?.setItem(TOMBSTONE_KEY, JSON.stringify([...tombstones]))
          } catch {
            // The in-memory set still suppresses the row for this page.
          }
        }

        /** Remove every tombstoned id from the page's Session list again. */
        const reassertDeleted = () => {
          const sessions = ctx.get('sessions')
          if (sessions?.handleSessionRemoved === undefined) return
          for (const id of tombstones) {
            try {
              sessions.handleSessionRemoved(id)
            } catch {
              // The next pass retries the same removal.
            }
          }
        }

        // A re-introduced row does not always arrive as an event: a list
        // refresh merges whatever the Host still lists, and the Host keeps a
        // Session whose Agent has not been disposed. Re-apply the tombstone
        // from the local list, which needs no Host round-trip.
        ctx.effect(() => {
          const timer = setInterval(() => {
            if (tombstones.size > 0) reassertDeleted()
          }, TOMBSTONE_POLL_MS)
          return () => clearInterval(timer)
        }, 'delete-conversation: tombstone poll')

        /** Clear the success notice after its display window. */
        const armToastClear = () => {
          clearTimeout(toastTimer)
          toastTimer = setTimeout(() => {
            const current = store.getSnapshot()
            if (current.toast !== null) store.set({ ...current, toast: null })
          }, TOAST_MS)
        }
        ctx.effect(() => () => clearTimeout(toastTimer), 'delete-conversation: toast timer')

        // Reconcile once after this bundle loads, so a row left behind by an
        // older delete (or a Session deleted while this page was not watching)
        // disappears without the user reloading the page.
        ctx.effect(() => {
          const timer = setTimeout(() => {
            reassertDeleted()
            void pruneUnknownRows()
          }, STALE_SWEEP_MS)
          return () => clearTimeout(timer)
        }, 'delete-conversation: stale row sweep')

        // A Session the Host still holds as live can be announced again after its
        // row was removed; suppress every id this browser deleted immediately.
        // `ctx.remote` is read through `get` because the property form is only
        // available to a plugin that injected the Remote service.
        let remote
        try {
          remote = ctx.get('remote')
        } catch {
          remote = undefined
        }
        if (typeof remote?.$on === 'function') {
          try {
            ctx.effect(() => remote.$on('api-session/added', (summary) => {
              const id = summary?.sessionId
              if (typeof id === 'string' && tombstones.has(id)) reassertDeleted()
            }), 'delete-conversation: tombstone gate')
          } catch {
            // The reconciliation passes below still suppress a re-announced row.
          }
        }

        /**
         * Drop the deleted row from this page's Session list immediately.
         *
         * A list refresh merges instead of replacing, so an identity the page
         * already knows survives every refresh; a deleted Session is then
         * claimed by no Workspace and lingers in the sidebar's "Ungrouped"
         * bucket. The Controller's own removal handler is the operation that
         * actually reaps the row, and it is idempotent with the Host's
         * broadcast.
         * @param {string} sessionId - the Session that no longer exists.
         */
        const forgetRow = (sessionId) => {
          const sessions = ctx.get('sessions')
          try {
            sessions?.handleSessionRemoved?.(sessionId)
          } catch {
            // The Host's `api-session/removed` broadcast lands on the same handler.
          }
        }

        /**
         * Reconcile the list a few times after a delete.
         *
         * The Host stops listing a Session only once the released view's Agent
         * has actually been disposed, which can trail the delete response by a
         * few hundred milliseconds; one sweep can therefore still see the row.
         * Each pass re-reads the Host's list and prunes only identities it no
         * longer returns, so repeating is safe and the last pass settles a slow
         * teardown.
         * @returns {void}
         */
        const scheduleSweeps = () => {
          for (const delay of SWEEP_DELAYS) {
            const timer = setTimeout(() => {
              sweepTimers.delete(timer)
              reassertDeleted()
              void pruneUnknownRows()
            }, delay)
            sweepTimers.add(timer)
          }
        }
        ctx.effect(() => () => {
          for (const timer of sweepTimers) clearTimeout(timer)
          sweepTimers.clear()
        }, 'delete-conversation: sweep timers')

        /**
         * Drop every Client row whose Session the Host no longer lists.
         *
         * The sidebar groups rows by Workspace membership: a Session that no
         * Workspace accounts for is rendered under "Ungrouped", so a row left
         * over from a deleted log is removed only by taking it out of the
         * Session list itself. The Host's list is the authority — ask for it and
         * drop each known identity it does not return. Subagent children are
         * addressed through their parent's catalog, blank drafts may not have
         * reached storage yet, running Sessions are live by definition, and a
         * Session the main view holds is still on screen; those are left alone.
         * A failed pull leaves the list untouched.
         * @returns {Promise<void>} resolves after the sweep attempt.
         */
        const pruneUnknownRows = async () => {
          const sessions = ctx.get('sessions')
          if (sessions === undefined) return
          const remote = ctx.get('remote')
          if (remote?.session?.list === undefined) {
            // Without the list RPC the Controller's own refresh is the only
            // path that can merge an authoritative baseline.
            try { await sessions.refresh?.() } catch { /* keep the current list */ }
            return
          }
          let listing
          try {
            listing = await remote.session.list({})
          } catch {
            return
          }
          if (listing?.ok !== true) return
          const known = new Set((listing.value?.items ?? []).map(item => item.sessionId))
          let snapshot
          try {
            snapshot = sessions.list?.getSnapshot?.()
          } catch {
            return
          }
          if (snapshot === undefined) return
          for (const id of snapshot.ids ?? []) {
            const deleted = tombstones.has(id)
            if (!deleted && known.has(id)) continue
            const summary = snapshot.byId?.[id]
            if (summary === undefined) continue
            if (!deleted && (summary.blank === true || summary.running === true)) continue
            if (!deleted && (summary.origin === 'subagent' || summary.parentId !== undefined)) continue
            if (!deleted && (summary.retainedBy?.mainView ?? 0) > 0) continue
            try {
              sessions.handleSessionRemoved?.(id)
            } catch {
              // The Host broadcast or the next sweep retries the same removal.
            }
          }
        }

        /**
         * Map a Host outcome code to localized copy; the body itself never
         * reaches the user because it may carry host paths.
         * @param {unknown} error - the rejection raised by the confirm flow.
         * @returns {string} one localized message.
         */
        const describeFailure = (error) => {
          const code = error instanceof Error ? error.code : undefined
          switch (code) {
            case 'session-active': return t('dialog.active')
            case 'not-found': return t('dialog.notFound')
            case 'unavailable': return t('dialog.unavailable')
            case 'close-current': return t('dialog.closeCurrentFailed')
            default: return t('dialog.failed')
          }
        }

        /**
         * Leave the conversation when it is the one on screen, so the Host can
         * release its Agent before the log disappears.
         * @param {string} sessionId - the captured Session identity.
         * @returns {Promise<void>} resolves once this client released the binding.
         */
        const releaseOpenConversation = async (sessionId) => {
          const sessions = ctx.get('sessions')
          const uiWorkspace = ctx.get('uiWorkspace')
          if (sessions === undefined || uiWorkspace === undefined) return
          uiWorkspace.startSession()
          const deadline = Date.now() + 5000
          for (;;) {
            if (sessions.binding(sessionId) === undefined) return
            if (Date.now() >= deadline) {
              throw Object.assign(new Error('the open conversation was not released'), { code: 'close-current' })
            }
            await new Promise(resolve => setTimeout(resolve, 60))
          }
        }

        /**
         * One delete call.
         * @param {string} sessionId - captured Session identity.
         * @returns {Promise<{ ok: boolean, code: string, failed: string[] }>} the Host's outcome.
         */
        const callDelete = async (sessionId) => {
          const response = await fetch(`${ROUTE}?sessionId=${encodeURIComponent(sessionId)}`, { method: 'POST' })
          let body = null
          try { body = await response.json() } catch { body = null }
          return {
            ok: response.ok,
            code: typeof body?.code === 'string' ? body.code : (response.ok ? 'ok' : 'delete-failed'),
            failed: Array.isArray(body?.failed) ? body.failed.map(String) : [],
          }
        }

        /** Perform the confirmed deletion and publish its progress. */
        const confirmDelete = async () => {
          const current = store.getSnapshot()
          if (current.request === null || current.busy) return
          const request = current.request
          store.set({ ...current, busy: true, error: null })
          let leftConversation = false
          try {
            if (request.wasMainView) {
              await releaseOpenConversation(request.sessionId)
              leftConversation = true
            }
            // The Host stops running work and waits for it to settle before
            // deleting, so one call covers the whole operation; a
            // `session-active` outcome means that work did not stop in time.
            const outcome = await callDelete(request.sessionId)
            if (!outcome.ok) {
              // `not-found` means the files are already gone: the only work left
              // is dropping this stale row, so treat the delete as satisfied.
              if (outcome.code === 'not-found') {
                forgetRow(request.sessionId)
                rememberDeleted(request.sessionId)
                store.set({ request: null, busy: false, error: null, toast: t('toast.deleted') })
                armToastClear()
                scheduleSweeps()
                return
              }
              // The conversation itself may already be gone when only a
              // descendant's files resisted removal; the requested result
              // holds, so report it as a qualified success.
              if (!outcome.failed.includes(request.sessionId)) {
                forgetRow(request.sessionId)
                rememberDeleted(request.sessionId)
                store.set({ request: null, busy: false, error: null, toast: t('toast.partial') })
                armToastClear()
                scheduleSweeps()
                return
              }
              throw Object.assign(new Error('the session could not be removed'), { code: 'delete-failed' })
            }
            forgetRow(request.sessionId)
            rememberDeleted(request.sessionId)
            store.set({ request: null, busy: false, error: null, toast: t('toast.deleted') })
            armToastClear()
            scheduleSweeps()
          } catch (error) {
            // The dialog is still on screen, so put the user back where they
            // were when the flow closed the conversation but did not delete it.
            if (leftConversation) {
              try { ctx.get('uiWorkspace')?.openSession(request.sessionId) } catch { /* already gone */ }
            }
            store.set({ ...store.getSnapshot(), busy: false, error: describeFailure(error) })
          }
        }

        /** Close the dialog without deleting. */
        const cancelDelete = () => {
          const current = store.getSnapshot()
          if (current.busy) return
          if (current.request === null && current.error === null) return
          store.set({ ...current, request: null, error: null })
        }

        /**
         * Capture one Session and open the confirmation.
         * @param {{ sessionId: string, displayTitle: string }} target - the clicked row.
         */
        const requestDelete = (target) => {
          const sessions = ctx.get('sessions')
          let wasMainView = false
          try {
            const retained = sessions?.retainInfo(target.sessionId)?.getSnapshot().retainedBy ?? {}
            wasMainView = (retained.mainView ?? 0) > 0
          } catch {
            wasMainView = false
          }
          store.set({
            request: { sessionId: target.sessionId, displayTitle: target.displayTitle, wasMainView },
            busy: false,
            error: null,
            toast: null,
          })
        }

        ctx.effect(() => ctx.contextMenus.register({
          id: 'delete-conversation.delete',
          target: 'session',
          order: MENU_ORDER,
          observe: () => [ctx.locale],
          resolve: (target) => {
            // Subagent rows are removed together with their parent; deleting
            // one on its own would leave the parent catalog pointing at a
            // missing log.
            const sessions = ctx.get('sessions')
            const summary = sessions?.list?.getSnapshot?.()?.byId?.[target.sessionId]
            if (summary?.origin === 'subagent') return []
            return [{
              id: 'delete',
              label: t('menu.delete'),
              icon: { key: ICON_KEY },
              danger: true,
              run: () => { requestDelete(target) },
            }]
          },
        }), 'delete-conversation: session menu')

        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon',
          key: ICON_KEY,
        }, TrashIcon))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'delete-conversation.confirm',
          locale: NS,
          inject: () => ({
            hooks: { deleteConversation: store },
            cancelDelete,
            confirmDelete,
          }),
        }, DeleteOverlay))

      },
    }
  },
})
