/**
 * Transcript (WebVTT / SRT) parsing and lookup helpers.
 *
 * Pure functions only (no Vue, no DOM) so they can be unit tested with `node --test`.
 *
 * Cue shape:
 *   { start, end, text, words, spoken, segs?, id?, chapter?, para?, sent?, heading? }
 *
 * `words` is only present for WebVTT cues that carry inline word timestamps
 * (`Hello <00:00:01.200>world <00:00:01.800>again`). Each word entry marks the time at which that
 * segment STARTS being spoken; `w` keeps its original inter-word whitespace so that joining all
 * `w` values reproduces the spoken part of `text`.
 *
 * Book mode (full printed text with timings). A cue identifier `c<CC>-p<PPPP>-s<SS>` (sentence) or
 * `c<CC>-h` (chapter heading) puts the cue into a chapter / paragraph; consecutive cues with the same
 * chapter + paragraph form one paragraph (see buildBlocks). Cue text may carry `<i> <b> <u>` markup and
 * `<c.unspoken>` spans for book words that are NOT heard in the recording. Such cues keep a `segs`
 * list of render runs: { w: text, f: style flags (FLAG_*), k: index into `words`, or -1 }.
 * `spoken` is false for a cue without any spoken word: it is displayed but is never the "current" cue
 * and is never word-highlighted. Cues of a book-mode file are kept in FILE order (not sorted by time).
 */

export const FLAG_ITALIC = 1
export const FLAG_BOLD = 2
export const FLAG_UNDERLINE = 4
export const FLAG_UNSPOKEN = 8

const TIMESTAMP_RE = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/
const CUE_TIMING_RE = /^\s*(\S+)\s*-->\s*(\S+)/
// Inline tokens inside a cue payload: a timestamp tag or any other tag (<c.x>, </c>, <v Name>, <i>, ...)
const INLINE_TOKEN_RE = /<(\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3}>|<\/?[a-zA-Z][^>]*>/g
const INLINE_TIMESTAMP_RE = /^<(\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3}>$/
const TAG_RE = /^<(\/)?([a-zA-Z][a-zA-Z0-9]*)((?:[.\s][^>]*)?)>$/
const CUE_ID_RE = /^c(\d+)-(?:(h)|p(\d+)-s(\d+))$/

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

function normalizeWs(str, keepNewlines) {
  // A whitespace run becomes one space; with keepNewlines a run that contains a newline becomes '\n'
  return str.replace(/\s+/g, (m) => (keepNewlines && m.indexOf('\n') !== -1 ? '\n' : ' '))
}

/**
 * Turn the raw payload lines of one cue into { text, words, segs, spoken }.
 *
 * Understands inline word timestamps, `<i> <b> <u>` styling and `<c.unspoken>` spans (text that is
 * displayed but not heard). Any other tag (`<v Name>`, `<c.karaoke>`, ...) is dropped.
 *
 * @param {string} payload lines joined with '\n'
 * @param {number} cueStart
 * @param {boolean} [keepNewlines] keep deliberate line breaks (book mode) instead of folding them into spaces
 * @returns {{ text: string, words: null | Array<{t:number,w:string}>, segs: null | Array<{w:string,f:number,k:number}>, spoken: boolean }}
 *   `segs` is null for a cue without any styling / unspoken text (render `words` or `text` directly)
 */
export function parseCuePayload(payload, cueStart, keepNewlines = false) {
  let segs = [] // { w, f, k }
  const times = [] // start time of every spoken word, index = k
  const stack = [] // open tags: { name, flag, unspoken }
  let flags = 0
  let unspokenDepth = 0
  let pendingT = null
  let curK = -1
  let hasTimestamps = false
  let styled = false

  function pushText(raw) {
    if (!raw) return
    const text = normalizeWs(decodeEntities(raw), keepNewlines)
    if (!text) return
    const f = flags | (unspokenDepth ? FLAG_UNSPOKEN : 0)
    let k = -1
    if (unspokenDepth) {
      curK = -1 // the next spoken text starts a new word
    } else if (!text.trim()) {
      k = curK // pure whitespace: glue onto the current word, keep any pending timestamp for the next word
    } else {
      if (pendingT !== null || curK < 0) {
        times.push(pendingT !== null ? pendingT : times.length ? times[times.length - 1] : cueStart)
        curK = times.length - 1
        pendingT = null
      }
      k = curK
    }
    if (f) styled = true
    const last = segs[segs.length - 1]
    if (last && last.f === f && last.k === k) last.w += text
    else segs.push({ w: text, f, k })
  }

  function recompute() {
    flags = 0
    unspokenDepth = 0
    for (const e of stack) {
      flags |= e.flag
      if (e.unspoken) unspokenDepth++
    }
  }

  let last = 0
  INLINE_TOKEN_RE.lastIndex = 0
  let m
  while ((m = INLINE_TOKEN_RE.exec(payload)) !== null) {
    pushText(payload.slice(last, m.index))
    last = m.index + m[0].length
    if (INLINE_TIMESTAMP_RE.test(m[0])) {
      const t = parseTimestamp(m[0].slice(1, -1))
      if (!isNaN(t)) {
        hasTimestamps = true
        pendingT = t
      }
      continue
    }
    const tag = TAG_RE.exec(m[0])
    if (!tag) continue
    const name = tag[2].toLowerCase()
    if (tag[1]) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) {
          stack.splice(i, 1)
          recompute()
          break
        }
      }
    } else if (name === 'i' || name === 'b' || name === 'u' || name === 'c') {
      const classes = tag[3].split(/[.\s]+/)
      stack.push({ name, flag: name === 'i' ? FLAG_ITALIC : name === 'b' ? FLAG_BOLD : name === 'u' ? FLAG_UNDERLINE : 0, unspoken: name === 'c' && classes.includes('unspoken') })
      recompute()
    }
  }
  pushText(payload.slice(last))

  // Collapse whitespace that meets across run boundaries (a newline wins over a space), drop empty runs
  const out = []
  for (const seg of segs) {
    let prev = out[out.length - 1]
    if (prev && /\s$/.test(prev.w) && /^\s/.test(seg.w)) {
      if (seg.w[0] === '\n' && prev.w[prev.w.length - 1] === ' ') {
        prev.w = prev.w.slice(0, -1)
        if (!prev.w) out.pop()
      } else {
        seg.w = seg.w.slice(1)
      }
    }
    if (seg.w) out.push(seg)
  }
  while (out.length && !out[0].w.trim()) out.shift()
  while (out.length && !out[out.length - 1].w.trim()) out.pop()
  if (out.length) {
    out[0].w = out[0].w.replace(/^\s+/, '')
    out[out.length - 1].w = out[out.length - 1].w.replace(/\s+$/, '')
  }
  segs = out

  const text = segs.map((x) => x.w).join('')
  const spoken = segs.some((x) => x.k >= 0)
  let words = null
  // A book-mode cue without inline timestamps (e.g. a one-word sentence) still gets one word that starts
  // at the cue start, so it can be highlighted; legacy cues without timestamps keep words = null
  if (spoken && (hasTimestamps || keepNewlines)) {
    words = times.map((t) => ({ t, w: '' }))
    for (const seg of segs) if (seg.k >= 0) words[seg.k].w += seg.w
  }
  return { text, words, segs: styled ? segs : null, spoken }
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
  let bookMode = false
  let pendingId = ''
  let cueId = ''

  function flush() {
    if (!inCue) return
    inCue = false
    if (!isNaN(start) && !isNaN(end)) {
      const idm = CUE_ID_RE.exec(cueId)
      const { text, words, segs, spoken } = parseCuePayload(lines.join('\n'), start, !!idm)
      if (text) {
        if (words) hasWords = true
        const cue = { start, end: Math.max(end, start), text, words }
        if (segs) cue.segs = segs
        if (!spoken) cue.spoken = false
        if (idm) {
          bookMode = true
          cue.id = cueId
          cue.chapter = parseInt(idm[1], 10)
          if (idm[2]) cue.heading = true
          else {
            cue.para = parseInt(idm[3], 10)
            cue.sent = parseInt(idm[4], 10)
          }
        }
        cues.push(cue)
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
      if (line.indexOf('-->') === -1) {
        // header, NOTE, STYLE, cue identifier, blank: remember the last non-blank line as a candidate identifier
        pendingId = line.trim()
        return
      }
      const m = CUE_TIMING_RE.exec(line)
      if (!m) return
      start = parseTimestamp(m[1])
      end = parseTimestamp(m[2])
      cueId = pendingId
      pendingId = ''
      inCue = true
      lines = []
    },
    finish() {
      flush()
      // Legacy files are ordered by time. A book-mode file is in reading order: keep the file order.
      if (!bookMode) {
        let sorted = true
        for (let i = 1; i < cues.length; i++) {
          if (cues[i].start < cues[i - 1].start) {
            sorted = false
            break
          }
        }
        if (!sorted) cues.sort((a, b) => a.start - b.start)
      }
      return { cues, hasWords, bookMode }
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
    ...c,
    start: c.start + offset,
    end: c.end + offset,
    words: c.words ? c.words.map((w) => ({ t: w.t + offset, w: w.w })) : null
  }))
}

/**
 * Concatenate several already-offset cue lists. Legacy lists are merged by start time; if any cue
 * carries a book-mode id the lists are simply appended in the given (audio file) order, because the
 * file order is the reading order.
 */
export function mergeCues(lists) {
  const all = [].concat(...lists)
  if (all.some((c) => c.id)) return all
  all.sort((a, b) => a.start - b.start)
  return all
}

const spokenIndexCache = new WeakMap()

/**
 * Indices of the cues that contain at least one spoken word, or null when every cue is spoken
 * (the common, legacy case). Cached per cue array.
 */
export function getSpokenIndex(cues) {
  if (spokenIndexCache.has(cues)) return spokenIndexCache.get(cues)
  let idx = null
  if (cues.some((c) => c.spoken === false)) {
    const list = []
    for (let i = 0; i < cues.length; i++) if (cues[i].spoken !== false) list.push(i)
    idx = Int32Array.from(list)
  }
  spokenIndexCache.set(cues, idx)
  return idx
}

/**
 * Index of the last cue whose start <= time (the cue being spoken, or the most recent one while
 * in a silent gap). Returns -1 before the first cue. O(log n).
 * Cues without any spoken word (`spoken === false`) are never returned and their (possibly bogus)
 * start times are ignored.
 * @param {Array<{start:number, spoken?:boolean}>} cues
 * @param {number} time seconds
 */
export function findCueIndex(cues, time) {
  const spoken = getSpokenIndex(cues)
  let lo = 0
  let hi = (spoken ? spoken.length : cues.length) - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const ci = spoken ? spoken[mid] : mid
    if (cues[ci].start <= time) {
      ans = ci
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * Group cues into display blocks. Consecutive book-mode cues with the same chapter + paragraph form
 * one paragraph (kind 'p'); consecutive heading cues of a chapter form one heading ('h'); every cue
 * without an id is its own block (kind 'cue', the legacy one-cue-per-line layout).
 *
 * @returns {{ blocks: Array<{first:number,last:number,kind:string,firstSpoken:number}>, blockOf: Int32Array, book: boolean }}
 *   `firstSpoken` is the index of the block's first cue with a spoken word, -1 when there is none
 */
export function buildBlocks(cues) {
  const blocks = []
  const blockOf = new Int32Array(cues.length)
  let book = false
  let prevKey = ''
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]
    let key = ''
    let kind = 'cue'
    if (c.id) {
      book = true
      if (c.heading) {
        key = `c${c.chapter}-h`
        kind = 'h'
      } else {
        key = `c${c.chapter}-p${c.para}`
        kind = 'p'
      }
    }
    const cur = blocks[blocks.length - 1]
    if (key && key === prevKey && cur) {
      cur.last = i
    } else {
      blocks.push({ first: i, last: i, kind, firstSpoken: -1 })
    }
    prevKey = key
    const b = blocks[blocks.length - 1]
    if (b.firstSpoken < 0 && c.spoken !== false) b.firstSpoken = i
    blockOf[i] = blocks.length - 1
  }
  return { blocks, blockOf, book }
}

/**
 * Time to seek to for a cue: the start of its first spoken word. A cue without spoken words maps to
 * the nearest following spoken cue (or the nearest preceding one at the very end of the book).
 * @returns {number} seconds, or -1 when the transcript has no spoken cue at all
 */
export function seekTimeForCue(cues, i) {
  const at = (j) => (cues[j].words ? cues[j].words[0].t : cues[j].start)
  if (!cues[i]) return -1
  if (cues[i].spoken !== false) return at(i)
  for (let j = i + 1; j < cues.length; j++) if (cues[j].spoken !== false) return at(j)
  for (let j = i - 1; j >= 0; j--) if (cues[j].spoken !== false) return at(j)
  return -1
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
    const t = cues[i].text
    if ((t.indexOf('\n') === -1 ? t : t.replace(/\n/g, ' ')).toLowerCase().indexOf(q) !== -1) out.push(i)
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
