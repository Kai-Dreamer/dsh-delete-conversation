/**
 * Path and lineage arithmetic for permanent Session deletion.
 *
 * This module deliberately imports only Node built-ins: the Host half passes
 * the live Harness service values in, and the pure helpers can be exercised
 * with a temporary directory outside the Harness process.
 *
 * @module @local/dsh-delete-conversation/deletion
 */

import { rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

/**
 * Mirror of the JSONL persistence backend's safe path-segment encoding
 * (`@deepseek-ai/dsh-session-persistence-jsonl`, `src/format.ts`). Ids in the
 * current format need no escaping, but a future id must still name exactly the
 * directory the backend chose; mismatches make {@link removeSessionDirectory}
 * refuse instead of deleting an unrelated tree.
 * @param {string} raw - the raw session id.
 * @returns {string} one filesystem-safe path segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const char = String.fromCharCode(code)
    out += char !== '~' && /^[A-Za-z0-9._-]$/.test(char)
      ? char
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * One Session and every subagent-origin descendant, breadth-first with the
 * root first. Ordinary forks are excluded on purpose: a fork owns an
 * independent log and must survive its source's deletion.
 * @param {string} rootId - the Session whose conversation was deleted.
 * @param {readonly { id: string, parentSession?: string, origin?: string }[]} headers -
 *   every header the persistence listing and the live Session store know.
 * @returns {string[]} root plus subagent descendants, each once.
 */
export function collectSubtree(rootId, headers) {
  /** @type {Map<string, string[]>} */
  const children = new Map()
  for (const header of headers) {
    if (header.origin !== 'subagent' || header.parentSession === undefined) continue
    const parent = String(header.parentSession)
    const list = children.get(parent)
    if (list === undefined) children.set(parent, [String(header.id)])
    else list.push(String(header.id))
  }
  /** @type {string[]} */
  const ordered = []
  const seen = new Set()
  const queue = [rootId]
  while (queue.length > 0) {
    // The non-empty check proves an entry remains.
    const id = /** @type {string} */ (queue.shift())
    if (seen.has(id)) continue
    seen.add(id)
    ordered.push(id)
    for (const child of children.get(id) ?? []) queue.push(child)
  }
  return ordered
}

/**
 * Remove one Session's own artifact directory: every immutable generation of
 * its log, the write-lease file, and any torn-tail repair leftovers.
 *
 * The directory is refused unless its final segment is exactly the backend's
 * encoded session id; the caller obtains the directory from
 * `sessionPersistence.stat()` rather than composing it, so this check is the
 * last line of defence against deleting an unrelated path.
 * @param {string} directory - absolute Session directory from the log path.
 * @param {string} sessionId - the Session the directory must belong to.
 * @returns {Promise<void>} resolves when the directory is gone (already absent counts).
 */
export async function removeSessionDirectory(directory, sessionId) {
  if (dirname(directory) === directory) {
    throw new Error(`refusing to delete '${directory}': it is a filesystem root`)
  }
  if (basename(directory) !== encodeSegment(sessionId)) {
    throw new Error(
      `refusing to delete '${directory}': it is not the session directory for '${sessionId}'`,
    )
  }
  // `force` turns an already-absent directory into success, so a retry after a
  // partial deletion still converges.
  await rm(directory, { recursive: true, force: true })
}
