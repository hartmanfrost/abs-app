import { parseTranscriptAsync, offsetCues, mergeCues, pickTranscriptSources } from './transcript.js'
import { pickEpub } from './epub/bookSource.js'

/**
 * Per-item transcript cache (memory only). Keeps the two most recently used books so switching
 * back and forth does not re-download and re-parse a multi-megabyte file.
 * Key = item id + the sidecar inode/size/mtime signature, so an updated transcript invalidates itself.
 */
const MAX_CACHED = 2
const cache = new Map() // key -> { cues, hasWords }

function touch(key, value) {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value)
}

/**
 * Fetch the library item once and work out which sidecar files exist for it: VTT/SRT transcripts and an EPUB.
 * Never throws: returns empty results when the item cannot be fetched (offline, no permission, podcast, ...).
 * @param {{ get: Function }} http the app's $nativeHttp
 * @param {string} libraryItemId
 * @returns {Promise<{ sources: Array, epub: object|null }>}
 */
export async function fetchItemFiles(http, libraryItemId) {
  if (!libraryItemId) return { sources: [], epub: null }
  try {
    const item = await http.get(`/api/items/${libraryItemId}`)
    const sources = pickTranscriptSources(item).map((s) => {
      const file = (item.libraryFiles || []).find((f) => String(f.ino) === s.ino)
      const md = (file && file.metadata) || {}
      return { ...s, signature: `${s.ino}:${md.size || 0}:${Math.floor(md.mtimeMs || 0)}` }
    })
    return { sources, epub: pickEpub(item) }
  } catch (error) {
    console.warn('[transcript] Failed to look up transcript files', error && error.message)
    return { sources: [], epub: null }
  }
}

/** Transcript sources only (kept for callers that do not care about the EPUB). */
export async function fetchTranscriptSources(http, libraryItemId) {
  return (await fetchItemFiles(http, libraryItemId)).sources
}

/**
 * Download + parse every source and merge them on the book timeline.
 * @param {{ get: Function }} http
 * @param {string} libraryItemId
 * @param {Array} sources result of fetchTranscriptSources
 * @param {(fraction:number)=>void} [onProgress]
 * @returns {Promise<{ cues: Array, hasWords: boolean }>}
 */
export async function loadTranscript(http, libraryItemId, sources, onProgress) {
  const key = libraryItemId + '|' + sources.map((s) => s.signature || s.ino).join(',')
  const hit = cache.get(key)
  if (hit) {
    touch(key, hit)
    return hit
  }

  const lists = []
  let hasWords = false
  for (let i = 0; i < sources.length; i++) {
    const src = sources[i]
    const text = await http.get(`/api/items/${libraryItemId}/file/${encodeURIComponent(src.ino)}`, { responseType: 'text' })
    if (typeof text !== 'string') throw new Error('Unexpected transcript response')
    const parsed = await parseTranscriptAsync(text, {
      onProgress: onProgress ? (f) => onProgress((i + f) / sources.length) : undefined
    })
    if (parsed.hasWords) hasWords = true
    lists.push(offsetCues(parsed.cues, src.offset))
  }
  const result = { cues: lists.length === 1 ? lists[0] : mergeCues(lists), hasWords }
  if (!result.cues.length) throw new Error('Transcript is empty')
  touch(key, result)
  return result
}
