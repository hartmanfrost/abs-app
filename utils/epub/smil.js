/**
 * SMIL 3 media overlay parsing for the synced EPUB contract: one <par> per spoken word,
 * <text src="file.xhtml#w000123"/> + <audio clipBegin clipEnd/> on the book's single audio timeline.
 * Output is compact (typed arrays + one id array) so a 15k-word chapter costs little on a 32-bit TV.
 */
import { resolveZipPath, splitHref } from './epubPackage.js'

/** SMIL clock value -> seconds (NaN when unparseable). */
export function parseClock(str) {
  if (str === null || str === undefined) return NaN
  let t = String(str).trim().toLowerCase().replace(/^npt=/, '')
  let m
  if ((m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(t))) return +m[1] * 3600 + +m[2] * 60 + +m[3]
  if ((m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(t))) return +m[1] * 60 + +m[2]
  if ((m = /^(\d+(?:\.\d+)?|\.\d+)(h|min|ms|s)?$/.exec(t))) {
    const unit = m[2] || 's'
    return +m[1] * (unit === 'h' ? 3600 : unit === 'min' ? 60 : unit === 'ms' ? 0.001 : 1)
  }
  return NaN
}

const TAG_RE = /<(\/?)(par|text|audio)\b([^>]*)>/g
const SRC_RE = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/
const BEGIN_RE = /\bclipBegin\s*=\s*(?:"([^"]*)"|'([^']*)')/
const END_RE = /\bclipEnd\s*=\s*(?:"([^"]*)"|'([^']*)')/
const pick = (m) => (m ? (m[1] !== undefined ? m[1] : m[2]) : null)

/**
 * @param {string} text SMIL source
 * @param {string} smilZipPath zip path of the SMIL file (to resolve the xhtml reference)
 */
export function parseSmil(text, smilZipPath) {
  const starts = []
  const ends = []
  const ids = []
  let file = ''
  let cur = null // { id, hasText, begin, end, hasAudio }

  const flush = () => {
    if (cur && cur.id !== null && cur.hasAudio && !Number.isNaN(cur.begin)) {
      starts.push(cur.begin)
      ends.push(cur.end)
      ids.push(cur.id)
    }
    cur = null
  }

  TAG_RE.lastIndex = 0
  let m
  while ((m = TAG_RE.exec(text))) {
    const closing = m[1] === '/'
    const name = m[2]
    if (name === 'par') {
      flush()
      if (!closing && !m[3].endsWith('/')) cur = { id: null, begin: NaN, end: NaN, hasAudio: false }
    } else if (!cur || closing) {
      continue
    } else if (name === 'text') {
      const src = pick(SRC_RE.exec(m[3]))
      if (src) {
        const { path, fragment } = splitHref(src)
        if (fragment) {
          cur.id = fragment
          if (!file && path) file = resolveZipPath(smilZipPath, path)
        }
      }
    } else if (name === 'audio') {
      const b = pick(BEGIN_RE.exec(m[3]))
      const e = pick(END_RE.exec(m[3]))
      cur.begin = b === null ? 0 : parseClock(b)
      cur.end = e === null ? NaN : parseClock(e)
      cur.hasAudio = true
    }
  }
  flush()

  const n = starts.length
  const s = Float64Array.from(starts)
  const e = Float64Array.from(ends)
  // Missing / invalid clipEnd: until the next word starts, else half a second
  for (let i = 0; i < n; i++) if (Number.isNaN(e[i]) || e[i] < s[i]) e[i] = i + 1 < n && s[i + 1] > s[i] ? s[i + 1] : s[i] + 0.5

  let order = null
  for (let i = 1; i < n; i++) {
    if (s[i] < s[i - 1]) {
      order = Uint32Array.from({ length: n }, (_, k) => k).sort((a, b) => s[a] - s[b] || a - b)
      break
    }
  }
  let firstStart = 0
  let lastEnd = 0
  if (n) {
    firstStart = Infinity
    lastEnd = -Infinity
    for (let i = 0; i < n; i++) {
      if (s[i] < firstStart) firstStart = s[i]
      if (e[i] > lastEnd) lastEnd = e[i]
    }
  }
  let map = null
  return {
    file,
    n,
    starts: s,
    ends: e,
    ids,
    order,
    firstStart,
    lastEnd,
    idParIndex(id) {
      if (!map) {
        map = new Map()
        for (let i = 0; i < n; i++) if (!map.has(ids[i])) map.set(ids[i], i)
      }
      const v = map.get(id)
      return v === undefined ? -1 : v
    }
  }
}

/** Index (into the sorted view) of the last par with start <= t, or -1. */
function lastAtOrBefore(smil, t) {
  const { starts, order } = smil
  let lo = 0
  let hi = smil.n - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const v = starts[order ? order[mid] : mid]
    if (v <= t) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/** The par being spoken at time t (last start <= t, still within end + gapTolerance), else -1. */
export function findPar(smil, t, gapTolerance = 0.35) {
  const k = lastAtOrBefore(smil, t)
  if (k < 0) return -1
  const i = smil.order ? smil.order[k] : k
  return t < smil.ends[i] + gapTolerance ? i : -1
}

/** First par that starts after t, or -1. */
export function nextParAfter(smil, t) {
  const k = lastAtOrBefore(smil, t) + 1
  if (k >= smil.n) return -1
  return smil.order ? smil.order[k] : k
}

export function parForId(smil, id) {
  return smil.idParIndex(id)
}
