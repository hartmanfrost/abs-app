/**
 * Maps book time to (chapter, SMIL par) without loading every chapter's overlay:
 * a tiny summary {firstStart,lastEnd,n} is kept for each chapter seen, full SMILs live in a small LRU.
 */
import { findPar } from './smil.js'

const MAX_FULL = 4

export class BookTimeline {
  /**
   * @param {{ chapters: Array<{index:number, href:string, smilHref:string}>, loadSmil: (i:number)=>Promise<object> }} opts
   */
  constructor({ chapters, loadSmil }) {
    this.chapters = chapters
    this.loadSmil = loadSmil
    this.summaries = new Array(chapters.length).fill(undefined) // undefined unknown, null failed/empty
    this.full = new Map() // idx -> smil (LRU by insertion order)
    this.inflight = new Map()
  }

  peek(idx) {
    return this.summaries[idx] || null
  }

  _remember(idx, smil) {
    this.full.delete(idx)
    this.full.set(idx, smil)
    while (this.full.size > MAX_FULL) this.full.delete(this.full.keys().next().value)
  }

  /** Full SMIL of a chapter (cached), or null when it cannot be loaded / is empty. */
  async smilFor(idx) {
    const hit = this.full.get(idx)
    if (hit) {
      this._remember(idx, hit)
      return hit
    }
    let p = this.inflight.get(idx)
    if (!p) {
      p = (async () => {
        try {
          const smil = await this.loadSmil(idx)
          if (!smil || !smil.n) {
            this.summaries[idx] = null
            return null
          }
          this.summaries[idx] = { firstStart: smil.firstStart, lastEnd: smil.lastEnd, n: smil.n }
          this._remember(idx, smil)
          return smil
        } catch (e) {
          this.summaries[idx] = null
          return null
        } finally {
          this.inflight.delete(idx)
        }
      })()
      this.inflight.set(idx, p)
    }
    return p
  }

  async _startOf(idx) {
    if (this.summaries[idx] === undefined) await this.smilFor(idx)
    const s = this.summaries[idx]
    return s ? s.firstStart : null
  }

  async preload(idx) {
    if (idx >= 0 && idx < this.chapters.length) await this.smilFor(idx)
  }

  /** Last chapter whose first spoken word starts at or before t (0 before all, skipping chapters that failed to load). */
  async chapterAt(t, hint) {
    const n = this.chapters.length
    if (!n) return -1
    if (hint !== undefined && hint >= 0 && hint < n) {
      const a = this.summaries[hint]
      let nextStart = Infinity
      let nextKnown = hint + 1 >= n
      if (!nextKnown) {
        const b = this.summaries[hint + 1]
        if (b) {
          nextStart = b.firstStart
          nextKnown = true
        }
      }
      if (a && nextKnown && t >= a.firstStart && t < nextStart) return hint
    }
    let lo = 0
    let hi = n - 1
    let ans = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      let j = mid
      let start = null
      while (j <= hi && (start = await this._startOf(j)) === null) j++
      if (j > hi) {
        hi = mid - 1
        continue
      }
      if (start <= t) {
        ans = j
        lo = j + 1
      } else hi = mid - 1
    }
    return ans
  }

  /** @returns {Promise<{chapter:number, smil:object|null, par:number}>} */
  async resolve(t, currentIdx) {
    let idx = await this.chapterAt(t, currentIdx)
    if (idx < 0) return { chapter: -1, smil: null, par: -1 }
    const n = this.chapters.length
    if (idx + 1 < n && this.summaries[idx + 1] === undefined) this.smilFor(idx + 1) // warm the next chapter, not awaited
    const smil = await this.smilFor(idx)
    return { chapter: idx, smil, par: smil ? findPar(smil, t) : -1 }
  }
}
