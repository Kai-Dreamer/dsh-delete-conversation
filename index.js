/**
 * Delete Session — Host half.
 *
 * The Client half adds one Session-menu action and a confirmation dialog, then
 * calls the authenticated POST route registered here. Unlike archive, this
 * route removes the Session's local log directory (every immutable generation,
 * the write lease, and torn-tail leftovers) and removes the Session from the
 * Workspace registry, so the row disappears from the sidebar and the content is
 * gone from this device.
 *
 * The route is served by the Connection Fetch carrier, which admits only the
 * owner browser cookie (or an owner API credential) before dispatch; a
 * non-owner peer receives 403 from the carrier.
 *
 * @module @local/dsh-delete-conversation
 */

import { dirname } from 'node:path'
import { collectSubtree, removeSessionDirectory } from './deletion.js'

export const name = 'delete-conversation'

/** The Connection carrier is the only required activation dependency. */
export const inject = ['connection']

/** Exact Fetch route the Client half calls, document-relative as `api/conversation-delete`. */
export const ROUTE = '/api/conversation-delete'

/** Storage domain holding the persisted Session projection cache. */
const PROJECTION_CACHE_DOMAIN = 'session_projcache'

/**
 * How long cancelled work gets to stop before the delete is refused. The stop
 * request has already reached every provider at that point; a refusal only
 * means no file was touched.
 */
const IDLE_TIMEOUT_MS = 10_000

/** Poll interval while waiting for cancelled work to settle. */
const STOP_POLL_MS = 100

/**
 * Register the authenticated delete route.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @returns {void}
 */
export function apply(ctx) {
  const connection = ctx.get('connection')
  if (connection === undefined) return
  // The registration disposer is owned by this plugin's fiber, so disabling
  // the bundle removes the route even though the carrier records it against
  // the Connection service's own context.
  ctx.effect(() => connection.fetch.register({
    path: ROUTE,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => respond(ctx, request),
  }), 'delete-conversation: delete route')
}

/**
 * Answer one delete request with a small JSON body; the Client half owns all
 * user-facing wording and never displays this body verbatim.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context carrying the
 *   Session persistence, registry, and storage services.
 * @param {Request} request - authenticated POST with a required `sessionId`.
 * @returns {Promise<Response>} one JSON response.
 */
async function respond(ctx, request) {
  let sessionId
  try {
    sessionId = new URL(request.url).searchParams.get('sessionId') ?? ''
  } catch {
    return json(400, { code: 'invalid-request', message: 'malformed request URL' })
  }
  if (sessionId.length === 0 || sessionId.length > 256) {
    return json(400, { code: 'invalid-request', message: 'sessionId is required' })
  }
  try {
    const outcome = await deleteConversation(ctx, sessionId)
    return json(outcome.status, outcome.body)
  } catch (error) {
    ctx.logger.warn(`delete-conversation: deleting session '${sessionId}' failed: ${String(error)}`)
    return json(500, { code: 'delete-failed', message: 'deleting the conversation failed' })
  }
}

/**
 * Delete one session permanently: the Session, its subagent descendants, their
 * local log directories, and every registry account that surfaces them.
 *
 * Running work anywhere in the tree is stopped first through the same
 * `workspace/session-stop` providers archive uses (which also removes
 * reminders targeting the Session), and the delete waits for those cancellations
 * to settle. An idle Session that is still held open in some view is allowed:
 * its live write buffer is flushed before the directory is removed, so no
 * pending append can materialize the log again. Only a Session whose work does
 * not stop within the deadline is refused, and then nothing is touched.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} rootId - the Session the user deleted.
 * @param {number} [idleTimeoutMs] - stop deadline; exposed for tests and embedders.
 * @returns {Promise<{ status: number, body: object }>} one HTTP outcome.
 */
export async function deleteConversation(ctx, rootId, idleTimeoutMs = IDLE_TIMEOUT_MS) {
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) {
    return {
      status: 503,
      body: { code: 'unavailable', message: 'session persistence is not mounted' },
    }
  }
  const sessions = ctx.get('sessions')
  const agents = ctx.get('agents')
  const registry = ctx.get('workspaceRegistry')

  const snapshots = await persistence.list()
  const liveSessions = sessions?.list() ?? []
  const known = snapshots.some(snapshot => String(snapshot.header.id) === rootId)
    || liveSessions.some(session => String(session.id) === rootId)
    || (registry?.list().some(workspace => workspace.sessionIds.some(id => String(id) === rootId)) ?? false)
  if (!known) return { status: 404, body: { code: 'not-found', message: 'session not found' } }

  const headers = [...snapshots.map(snapshot => snapshot.header), ...liveSessions.map(session => session.header)]
  const targets = collectSubtree(rootId, headers)

  // Stop turns, jobs, subagents, and reminders belonging to the whole tree
  // before touching files.
  await stopTargets(ctx, targets)

  // A cancelled turn still appends its closing events; wait for every target
  // to stop running so those events are in the log before the final flush.
  const deadline = Date.now() + idleTimeoutMs
  for (;;) {
    const running = targets.filter((id) => {
      const agent = agents?.get(id)
      return agent !== undefined && agent.status === 'running'
    })
    if (running.length === 0) break
    if (Date.now() >= deadline) {
      return {
        status: 409,
        body: {
          code: 'session-active',
          message: 'session work did not stop in time',
          sessions: running,
        },
      }
    }
    await delay(STOP_POLL_MS)
  }

  // Flush every live target — an idle open Session, or a resident subagent —
  // so no buffered batch can recreate the log after its directory is gone.
  for (const id of targets) {
    const live = sessions?.get(id)
    if (live === undefined) continue
    try {
      await sessions.flush(live)
    } catch (error) {
      ctx.logger.warn(`delete-conversation: flushing session '${id}' before deletion failed: ${String(error)}`)
    }
  }

  // Resolve every directory from the persistence service's own location; the
  // directory check in removeSessionDirectory then refuses anything unexpected.
  const directories = new Map()
  for (const id of targets) {
    const snapshot = await persistence.stat(id)
    const path = snapshot?.location?.path
    if (typeof path !== 'string' || path.length === 0) continue
    directories.set(id, dirname(path))
  }

  /** @type {string[]} */
  const failed = []
  for (const [id, directory] of directories) {
    try {
      await removeSessionDirectory(directory, id)
    } catch (error) {
      failed.push(id)
      ctx.logger.warn(`delete-conversation: session '${id}' directory was not removed: ${String(error)}`)
    }
  }

  // A target with no stored artifact (a Session that never reached disk) has
  // nothing to remove on disk; detach it all the same.
  const settled = targets.filter(id => !failed.includes(id))
  await detachFromWorkspaces(ctx, registry, settled)
  await purgeProjectionCache(ctx, settled)
  broadcastRemoved(ctx, settled)

  if (failed.length > 0) {
    return {
      status: 500,
      body: {
        code: 'partial-failure',
        message: 'some session files could not be removed',
        failed,
      },
    }
  }
  return {
    status: 200,
    body: {
      deleted: rootId,
      sessions: targets.length,
      directories: directories.size,
    },
  }
}

/**
 * Ask every composed `workspace/session-stop` provider to stop one Session's
 * work. A provider failure is logged rather than blocking the delete.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {readonly string[]} ids - target Sessions, root first.
 * @returns {Promise<void>} settles after every stop dispatch.
 */
async function stopTargets(ctx, ids) {
  for (const id of ids) {
    try {
      await ctx.parallel('workspace/session-stop', { sessionId: id })
    } catch (error) {
      ctx.logger.warn(`delete-conversation: stopping session '${id}' failed: ${String(error)}`)
    }
  }
}

/**
 * Drop every target from every Workspace's candidate account, then from the
 * registry-global archive and pin sets. Each call is an idempotent no-op when
 * the account already lacks the id, so the registry emits a change (and the
 * sidebar a row update) only where one is needed.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {import('@deepseek-ai/dsh-workspace').WorkspaceRegistry | undefined} registry -
 *   the authoritative Workspace registry.
 * @param {readonly string[]} ids - Sessions that are gone from disk.
 * @returns {Promise<void>} settles after the durable account writes.
 */
async function detachFromWorkspaces(ctx, registry, ids) {
  if (registry === undefined) return
  for (const id of ids) {
    for (const workspace of registry.list()) {
      try {
        await workspace.detachSession(id)
      } catch (error) {
        ctx.logger.warn(`delete-conversation: detaching session '${id}' from a workspace failed: ${String(error)}`)
      }
    }
    try {
      await registry.unarchiveSession(id)
    } catch (error) {
      ctx.logger.warn(`delete-conversation: unarchiving session '${id}' failed: ${String(error)}`)
    }
    try {
      await registry.unpinSession(id)
    } catch (error) {
      ctx.logger.warn(`delete-conversation: unpinning session '${id}' failed: ${String(error)}`)
    }
  }
}

/**
 * Tell every connected Client UI that a Session is gone, so its cached row is
 * dropped instead of surviving as an "Ungrouped" leftover.
 *
 * The Client keeps a merged Session-list snapshot: a full refresh keeps the
 * identities it already knows, so the only thing that reaps a row whose log
 * directory vanished while no Session instance was live is this broadcast — the
 * same `api-session/removed` event the Session controller emits from
 * `session/disposed`. It also drops the row's projection values and any
 * subscription bookkeeping on the Client.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {readonly string[]} ids - Sessions whose logs are gone.
 * @returns {void}
 */
function broadcastRemoved(ctx, ids) {
  for (const id of ids) {
    try {
      ctx.emit('api-session/removed', id)
    } catch (error) {
      ctx.logger.warn(`delete-conversation: announcing removal of '${id}' failed: ${String(error)}`)
    }
  }
}

/**
 * Delete the persisted projection-cache record of each Session so no derived
 * title or checkpoint of the deleted conversation survives in the profile's
 * storage directory. The cache is a fold shortcut, so this is best effort.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {readonly string[]} ids - Sessions that are gone from disk.
 * @returns {Promise<void>} settles after every purge attempt.
 */
async function purgeProjectionCache(ctx, ids) {
  const facility = ctx.get('storageDomain')
  const domain = facility?.get?.(PROJECTION_CACHE_DOMAIN)
  const table = domain?.table?.('sessions')
  if (table === undefined) return
  for (const id of ids) {
    try {
      await table.delete(id)
    } catch (error) {
      ctx.logger.warn(`delete-conversation: deleting the projection cache record of '${id}' failed: ${String(error)}`)
    }
  }
}

/**
 * Wait one poll interval.
 * @param {number} ms - milliseconds to wait.
 * @returns {Promise<void>} resolves after the delay.
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Build one JSON response.
 * @param {number} status - HTTP status code.
 * @param {object} body - JSON-serializable outcome.
 * @returns {Response} the response with a no-store cache policy.
 */
function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}
