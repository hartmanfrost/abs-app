/**
 * Transcript (WebVTT / SRT) parsing and lookup helpers.
 *
 * Pure functions only (no Vue, no DOM) so they can be unit tested with `node --test`.
 *
 * Cue shape:
 *   { start: number, end: number, text: string, words: null | Array<{ t: number, w: string }> }
 *
 * `words` is only present for WebVTT cues that carry inline word timestamps
 * (`Hello <00:00:01.200>world <00:00:01.800>again`). Each word entry marks the time at which that
 * segment STARTS being spoken; `w` keeps its original inter-word whitespace so that joining all
 * `w` values reproduces `text` exactly.
 */

const TIMESTAMP_RE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/
const CUE_TIMING_RE = /^\s*(\S+)\s*-->\s*(\S+)/
// Inline tokens inside a cue payload: a timestamp tag or any other tag (<c.x>, </c>, <v Name>, <i>, ...)
const INLINE_TOKEN_RE = /<(\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3}>|<\/?[a-zA-Z][^>]*>/g
const INLINE_TIMESTAMP_RE = /^<(\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3}>$/

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ', '&lrm;': '', '&rlm;': '' }

/**
 * Parse `hh:mm:ss.mmm`, `mm:ss.mmm` or SRT `hh:mm:ss,mmm` into seconds. Returns NaN when invalid.
 * @param {string} str
 * @returns {number}
 */
export function parseTimestamp(str) {
  const m = TIMESTAMP_RE.exec(String(str).trim())
  if (!m) return NaN
  const h = m[1] ? parseInt(m[1], 10) : 0
  const min = parseInt(m[2], 10)
  const s = parseInt(m[3], 10)
  // ".5" means 500 ms, ".05" means 50 ms: right-pad to 3 digits
  const ms = m[4] ? parseInt(m[4].padEnd(3, '0'), 10) : 0
  return h * 3600 + min * 60 + s + ms / 1000
}

function decodeEntities(str) {
  if (str.indexOf('&') === -1) return str
  return str.replace(/&(?:amp|lt|gt|quot|apos|nbsp|lrm|rlm|#39);/g, (e) => ENTITIES[e] ?? e).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
}

/**
 * Turn the raw payload lines of one cue into { text, words }.
 * @param {string} payload lines joined with '\n'
 * @param {number} cueStart
 */
export function parseCuePayload(payload, cueStart) {
  const segments = [] // { t, s }
  let current = { t: cueStart, s: '' }
  let hasTimestamps = false
  let last = 0
  INLINE_TOKEN_RE.lastIndex = 0
  let m
  while ((m = INLINE_TOKEN_RE.exec(payload)) !== null) {
    current.s += payload.slice(last, m.index)
    last = m.index + m[0].length
    if (INLINE_TIMESTAMP_RE.test(m[0])) {
      const t = parseTimestamp(m[0].slice(1, -1))
      if (!isNaN(t)) {
        hasTimestamps = true
        segments.push(current)
        current = { t, s: '' }
      }
    }
  }
  current.s += payload.slice(last)
  segments.push(current)

  // Normalise whitespace per segment while preserving a single leading/trailing space
  for (const seg of segments) {
    const decoded = decodeEntities(seg.s)
    const lead = /^\s/.test(decoded) ? ' ' : ''
    const trail = /\s$/.test(decoded) ? ' ' : ''
    const core = decoded.replace(/\s+/g, ' ').trim()
    seg.s = core ? lead + core + trail : decoded.trim() === '' && decoded ? ' ' : ''
  }

  const joined = segments.map((s) => s.s).join('')
  const text = joined.replace(/\s+/g, ' ').trim()
  if (!hasTimestamps) return { text, words: null }

  const words = []
  let first = true
  for (const seg of segments) {
    if (!seg.s.trim()) {
      // Pure-whitespace segment: glue the space onto the previous word
      if (seg.s && words.length) words[words.length - 1].w += ' '
      continue
    }
    let w = seg.s
    if (first) {
      w = w.replace(/^\s+/, '')
      first = false
    }
    words.push({ t: seg.t, w })
  }
  if (words.length) words[words.length - 1].w = words[words.length - 1].w.replace(/\s+$/, '')
  // Collapse a double space that can appear when one segment ends and the next begins with whitespace
  for (let i = 1; i < words.length; i++) {
    if (/\s$/.test(words[i - 1].w) && /^\s/.test(words[i].w)) words[i].w = words[i].w.replace(/^\s+/, '')
  }
  if (!words.length) return { text, words: null }
  return { text: words.map((x) => x.w).join(''), words }
}

/**
 * Incremental line-based parser shared by the sync and async entry points.
 */
function createParser() {
  const cues = []
  let inCue = false
  let start = 0
  let end = 0
  let lines = []
  let hasWords = false

  function flush() {
    if (!inCue) return
    inCue = false
    if (!isNaN(start) && !isNaN(end)) {
      const { text, words } = parseCuePayload(lines.join('\n'), start)
      if (text) {
        if (words) hasWords = true
        cues.push({ start, end: Math.max(end, start), text, words })
      }
    }
    lines = []
  }

  return {
    feed(line) {
      if (inCue) {
        if (line.trim() === '') flush()
        else lines.push(line)
        return
      }
      if (line.indexOf('-->') === -1) return // header, NOTE, STYLE, cue identifier, blank
      const m = CUE_TIMING_RE.exec(line)
      if (!m) return
      start = parseTimestamp(m[1])
      end = parseTimestamp(m[2])
      inCue = true
      lines = []
    },
    finish() {
      flush()
      let sorted = true
      for (let i = 1; i < cues.length; i++) {
        if (cues[i].start < cues[i - 1].start) {
          sorted = false
          break
        }
      }
      if (!sorted) cues.sort((a, b) => a.start - b.start)
      return { cues, hasWords }
    }
  }
}

function splitLines(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1) // BOM
  return text.split(/\r\n|\n|\r/)
}

/**
 * Parse a WebVTT or SRT document (auto-detected: SRT is simply a VTT-like block list without header).
 * @param {string} text
 * @returns {{ cues: Array, hasWords: boolean }}
 */
export function parseTranscript(text) {
  const parser = createParser()
  for (const line of splitLines(String(text || ''))) parser.feed(line)
  return parser.finish()
}

/**
 * Same as parseTranscript but yields to the event loop between slices so a multi-hour file
 * (tens of thousands of cues) does not freeze the UI on low-power TV hardware.
 * @param {string} text
 * @param {{ sliceLines?: number, onProgress?: (fraction: number) => void }} [opts]
 */
export async function parseTranscriptAsync(text, opts = {}) {
  const sliceLines = opts.sliceLines || 20000
  const lines = splitLines(String(text || ''))
  const parser = createParser()
  for (let i = 0; i < lines.length; i++) {
    parser.feed(lines[i])
    if (i % sliceLines === sliceLines - 1) {
      if (opts.onProgress) opts.onProgress(i / lines.length)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }
  if (opts.onProgress) opts.onProgress(1)
  return parser.finish()
}

/**
 * Shift every timestamp of a parsed transcript (used to place a per-file transcript on the
 * book-global timeline of a multi-file audiobook).
 */
export function offsetCues(cues, offset) {
  if (!offset) return cues
  return cues.map((c) => ({
    start: c.start + offset,
    end: c.end + offset,
    text: c.text,
    words: c.words ? c.words.map((w) => ({ t: w.t + offset, w: w.w })) : null
  }))
}

/**
 * Concatenate several already-offset cue lists, keeping the result sorted by start time.
 */
export function mergeCues(lists) {
  const all = [].concat(...lists)
  all.sort((a, b) => a.start - b.start)
  return all
}

/**
 * Index of the last cue whose start <= time (the cue being spoken, or the most recent one while
 * in a silent gap). Returns -1 before the first cue. O(log n).
 * @param {Array<{start:number}>} cues sorted by start
 * @param {number} time seconds
 */
export function findCueIndex(cues, time) {
  let lo = 0
  let hi = cues.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (cues[mid].start <= time) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * Index of the word being spoken at `time` inside a cue with inline word timestamps, -1 when
 * the cue has no words or `time` is before the first word.
 */
export function findWordIndex(cue, time) {
  if (!cue || !cue.words) return -1
  const words = cue.words
  let lo = 0
  let hi = words.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (words[mid].t <= time) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * Case-insensitive substring search across cue texts.
 * @returns {number[]} matching cue indices in ascending order (capped at `max`)
 */
export function searchCues(cues, query, max = 2000) {
  const q = String(query || '').trim().toLowerCase()
  if (!q) return []
  const out = []
  for (let i = 0; i < cues.length && out.length < max; i++) {
    if (cues[i].text.toLowerCase().indexOf(q) !== -1) out.push(i)
  }
  return out
}

const TRANSCRIPT_EXTS = ['.vtt', '.srt']

function stripExt(name) {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

/**
 * Decide which sidecar transcript files of a library item belong to which audio file, and where each
 * one sits on the book-global timeline.
 *
 * Matching rules (case-insensitive, relPath directory + basename must equal the audio file's):
 *   - `<audio basename>.vtt` is preferred over `<audio basename>.srt`
 *   - a book with exactly one audio file and exactly one sidecar of any name falls back to that sidecar
 *   - multi-file books map one sidecar per audio file and offset it by the file's start on the timeline
 *
 * @param {{ libraryFiles?: Array, media?: { audioFiles?: Array } }} item expanded library item JSON
 * @returns {Array<{ ino: string, filename: string, ext: string, offset: number }>}
 */
export function pickTranscriptSources(item) {
  const files = (item && item.libraryFiles) || []
  const sidecars = files.filter((f) => f && f.metadata && TRANSCRIPT_EXTS.includes(String(f.metadata.ext || '').toLowerCase()))
  if (!sidecars.length) return []

  const audioFiles = ((item.media && item.media.audioFiles) || []).filter((a) => !a.exclude).sort((a, b) => (a.index || 0) - (b.index || 0))
  if (!audioFiles.length) return []

  const key = (relPath) => stripExt(String(relPath || '')).toLowerCase()
  const byKey = new Map()
  for (const f of sidecars) {
    const k = key(f.metadata.relPath)
    const prev = byKey.get(k)
    // .vtt wins over .srt for the same basename (VTT can carry word timings)
    if (!prev || (String(f.metadata.ext).toLowerCase() === '.vtt' && String(prev.metadata.ext).toLowerCase() !== '.vtt')) byKey.set(k, f)
  }

  const sources = []
  let offset = 0
  for (const audio of audioFiles) {
    const match = byKey.get(key(audio.metadata && audio.metadata.relPath))
    if (match) {
      sources.push({ ino: String(match.ino), filename: match.metadata.filename, ext: String(match.metadata.ext).toLowerCase(), offset })
    }
    offset += audio.duration || 0
  }

  if (!sources.length && audioFiles.length === 1 && byKey.size === 1) {
    const only = [...byKey.values()][0]
    sources.push({ ino: String(only.ino), filename: only.metadata.filename, ext: String(only.metadata.ext).toLowerCase(), offset: 0 })
  }
  return sources
}

/**
 * Format seconds as h:mm:ss / m:ss.
 */
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}
