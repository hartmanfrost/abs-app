/**
 * Pure (DOM-free) logic of the Book read-along view: which illustration belongs to a reading position, the
 * continuous scroll keypoints / interpolation and the clock smoothing used by the Smooth scroll mode.
 */

// ---------------------------------------------------------------- illustrations

/**
 * Positions of illustration markers in a chapter. `order` is the document-order sequence of what was found:
 * 0 = a word, 1 = an illustration marker. A marker's position is the number of words before it, i.e. the ordinal of the
 * first word that comes after it.
 * @param {ArrayLike<number>} order
 * @returns {number[]} one position per marker, non-decreasing
 */
export function positionsFromOrder(order) {
  const out = []
  let words = 0
  for (let i = 0; i < order.length; i++) {
    if (order[i] === 1) out.push(words)
    else words++
  }
  return out
}

/**
 * Index of the last illustration whose position is at or before `pos` (the ordinal of the word being read), or -1
 * when none is (or the position is unknown, pos < 0). `positions` must be sorted ascending.
 */
export function illustrationAt(positions, pos) {
  if (!positions || !positions.length || !(pos >= 0)) return -1
  let lo = 0
  let hi = positions.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (positions[mid] <= pos) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}

/**
 * "Sticky until displaced": the pane shows the last illustration at or before the reading position; before the first
 * one of the chapter it keeps the carried-over illustration (the last one of the previous chapters), and only when
 * there is none either it shows the empty state.
 * @returns {{source:'chapter', index:number}|{source:'carry'}|{source:'none'}}
 */
export function selectIllustration(positions, pos, hasCarry) {
  const i = illustrationAt(positions, pos)
  if (i >= 0) return { source: 'chapter', index: i }
  return hasCarry ? { source: 'carry' } : { source: 'none' }
}

/**
 * What the illustration pane should do for one reading-position update. Returns null to HOLD what is shown.
 *  - No position (pos < 0: between two words, an unspoken run, a gap): hold, unless `force` (an explicit seek, browse or a
 *    chapter load) asks for the chapter-start state.
 *  - During plain playback the pane never moves backwards (a lower illustration in the same chapter, or the carry-over / empty
 *    state replacing a chapter illustration): only an explicit `force` may.
 * @param {{positions:number[], pos:number, hasCarry:boolean, current:{source:string,index?:number}|null, force:boolean}} a
 */
export function decideIllustration({ positions, pos, hasCarry, current, force }) {
  if (!(pos >= 0)) return force ? selectIllustration(positions, -1, hasCarry) : null
  const sel = selectIllustration(positions, pos, hasCarry)
  if (!force && current && current.source === 'chapter') {
    if (sel.source !== 'chapter') return null
    if (sel.index < current.index) return null
  }
  return sel
}

// ---------------------------------------------------------------- smooth scrolling

/**
 * Groups consecutive spoken words that sit on the same text line into keypoints (time = the middle of the line's
 * spoken time, y = the line's top in document coordinates). Interpolating linearly between keypoints makes the text
 * move at an even speed (about one line per line duration) instead of in line-sized steps.
 * @param {Array<{t0:number, t1:number, y:number}>} words in reading order
 * @param {number} tol words whose y differs by less than this belong to the same line
 * @returns {Array<{t:number, y:number}>}
 */
export function lineKeypoints(words, tol) {
  const out = []
  let g = null
  const flush = () => {
    if (g) out.push({ t: (g.t0 + g.t1) / 2, y: g.y })
  }
  for (const w of words) {
    if (g && Math.abs(w.y - g.y) < tol) {
      g.t1 = Math.max(g.t1, w.t1)
    } else {
      flush()
      g = { t0: w.t0, t1: w.t1, y: w.y }
    }
  }
  flush()
  return out
}

/** Piecewise-linear y at time t through keypoints sorted by t; clamps before the first and after the last. */
export function scrollYAt(keypoints, t) {
  const n = keypoints.length
  if (!n) return 0
  if (t <= keypoints[0].t || n === 1) return keypoints[0].y
  if (t >= keypoints[n - 1].t) return keypoints[n - 1].y
  let lo = 0
  let hi = n - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (keypoints[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = keypoints[lo]
  const b = keypoints[hi]
  const span = b.t - a.t
  return span > 0 ? a.y + ((b.y - a.y) * (t - a.t)) / span : b.y
}

/**
 * Exponential approach of `cur` to `target` (frame-rate independent). Snaps when the distance is large (a seek far away)
 * or already negligible.
 * @returns {number}
 */
export function easeToward(cur, target, dtSec, tau, snapDist) {
  const d = target - cur
  if (Math.abs(d) > snapDist) return target
  if (Math.abs(d) < 0.05) return target
  return cur + d * (1 - Math.exp(-Math.max(0, dtSec) / tau))
}

/**
 * Smooths the player clock. The player reports its position about once a second, and the interpolation anchor is
 * re-set each time, so the raw estimate shows small forward/backward corrections. This clock advances by itself, absorbs
 * small corrections gradually, never runs backwards for them, and jumps on a real seek (difference over `jump` seconds).
 */
export class ClockSmoother {
  constructor({ jump = 1, tau = 0.5 } = {}) {
    this.jump = jump
    this.tau = tau
    this.t = NaN
  }

  reset(t) {
    this.t = t
  }

  /** @returns {number} the smoothed time */
  step(est, dtSec, rate = 1) {
    if (!(this.t === this.t) || Math.abs(est - this.t) > this.jump + Math.abs(dtSec * rate)) {
      this.t = est
      return this.t
    }
    const adv = this.t + Math.max(0, dtSec) * rate
    const err = est - adv
    const next = adv + err * (1 - Math.exp(-Math.max(0, dtSec) / this.tau))
    this.t = Math.max(this.t, next)
    return this.t
  }
}
