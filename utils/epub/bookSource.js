/**
 * Finds the synced EPUB that sits next to an audiobook and checks (cheaply, once per file version) that it
 * really carries media overlays. Pure selection logic is separate from the network probe so it can be tested.
 */
import { openBookFor, closeBook } from './epubBook.js'

const SYNC_KEY = 'absBookSynced:'
const memo = new Map() // signature -> boolean

function baseName(filename) {
  return String(filename || '')
    .replace(/\.[^.]+$/, '')
    .toLowerCase()
}

/**
 * Picks the .epub of a library item: the one named like an audio file (`<basename>.epub`) first, then the
 * item's primary ebook, then any epub. ABS exposes it as `media.ebookFile` (primary) or as a supplementary
 * library file; both are served by /api/items/:id/ebook/:ino, so only the inode and size are needed.
 * @param {object} item library item JSON (with libraryFiles)
 * @returns {{ ino: string, size: number, signature: string, name: string } | null}
 */
export function pickEpub(item) {
  const files = (item && item.libraryFiles) || []
  const epubs = files.filter((f) => f && f.metadata && String(f.metadata.ext || '').toLowerCase() === '.epub')
  if (!epubs.length) return null
  const audioNames = new Set(files.filter((f) => f.fileType === 'audio' && f.metadata).map((f) => baseName(f.metadata.filename)))
  const primaryIno = item.media && item.media.ebookFile ? String(item.media.ebookFile.ino) : ''
  const pick = epubs.find((f) => audioNames.has(baseName(f.metadata.filename))) || epubs.find((f) => String(f.ino) === primaryIno) || epubs[0]
  const md = pick.metadata
  return { ino: String(pick.ino), size: Number(md.size) || 0, signature: `${pick.ino}:${md.size || 0}:${Math.floor(md.mtimeMs || 0)}`, name: md.filename || '' }
}

/**
 * Resolves with the file when it is a synced EPUB, null otherwise. The (opened) archive stays cached for the
 * reader that follows.
 */
export async function probeSyncedEpub(http, itemId, file) {
  if (!file || !file.size) return null
  if (memo.has(file.signature)) return memo.get(file.signature) ? file : null
  try {
    const stored = window.localStorage.getItem(SYNC_KEY + file.signature)
    if (stored === '1' || stored === '0') {
      memo.set(file.signature, stored === '1')
      return stored === '1' ? file : null
    }
  } catch (e) {
    // no localStorage: probe
  }
  try {
    const book = await openBookFor(http, itemId, file)
    const synced = book.synced
    memo.set(file.signature, synced)
    try {
      window.localStorage.setItem(SYNC_KEY + file.signature, synced ? '1' : '0')
    } catch (e) {
      // ignore
    }
    if (!synced) closeBook()
    return synced ? file : null
  } catch (error) {
    console.warn('[book] epub probe failed', error && error.message)
    return null
  }
}
