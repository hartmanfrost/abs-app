// Unit tests for the DOM-free parts of the Book read-along view: illustration selection, smooth-scroll maths,
// the player clock smoother and the persisted reader preferences.
import test from 'node:test'
import assert from 'node:assert/strict'
import { positionsFromOrder, illustrationAt, selectIllustration, lineKeypoints, scrollYAt, easeToward, ClockSmoother } from '../utils/epub/readAlong.js'
import { FONT_SCALES, DEFAULT_FONT_LEVEL, NIGHT_KEY, SMOOTH_KEY, nearestFontLevel, loadFontLevel, saveFontLevel, loadFlag, saveFlag } from '../utils/readerPrefs.js'

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`)

// ---------------------------------------------------------------- illustrations

test('positionsFromOrder counts words before each marker', () => {
  assert.deepEqual(positionsFromOrder([0, 0, 1, 0, 1, 1, 0]), [2, 3, 3])
  assert.deepEqual(positionsFromOrder([1, 0, 0]), [0])
  assert.deepEqual(positionsFromOrder([0, 0, 0]), [])
  assert.deepEqual(positionsFromOrder([]), [])
  assert.deepEqual(positionsFromOrder(Uint8Array.from([0, 1])), [1])
})

test('illustrationAt: before, exact, between, after, unknown, empty', () => {
  const pos = [5, 10, 20]
  assert.equal(illustrationAt(pos, 0), -1)
  assert.equal(illustrationAt(pos, 4), -1)
  assert.equal(illustrationAt(pos, 5), 0)
  assert.equal(illustrationAt(pos, 9), 0)
  assert.equal(illustrationAt(pos, 10), 1)
  assert.equal(illustrationAt(pos, 15), 1)
  assert.equal(illustrationAt(pos, 20), 2)
  assert.equal(illustrationAt(pos, 999), 2)
  assert.equal(illustrationAt(pos, -1), -1)
  assert.equal(illustrationAt(pos, NaN), -1)
  assert.equal(illustrationAt([], 5), -1)
  assert.equal(illustrationAt(null, 5), -1)
})

test('illustrationAt with duplicate positions picks the last of them', () => {
  assert.equal(illustrationAt([3, 3, 3, 8], 3), 2)
})

test('selectIllustration: chapter, carry, none', () => {
  assert.deepEqual(selectIllustration([5, 10], 7, true), { source: 'chapter', index: 0 })
  assert.deepEqual(selectIllustration([5, 10], 2, true), { source: 'carry' })
  assert.deepEqual(selectIllustration([5, 10], 2, false), { source: 'none' })
  assert.deepEqual(selectIllustration([], 50, true), { source: 'carry' })
  assert.deepEqual(selectIllustration([], 50, false), { source: 'none' })
  assert.deepEqual(selectIllustration([5], -1, false), { source: 'none' })
})

test('selectIllustration is sticky: sweeping the position never moves the chapter index back', () => {
  const pos = [4, 9, 9, 30]
  let last = -1
  for (let p = 0; p <= 60; p++) {
    const s = selectIllustration(pos, p, false)
    if (s.source === 'chapter') {
      assert.ok(s.index >= last, `index went back at pos ${p}`)
      last = s.index
    } else assert.ok(last === -1, `fell back to ${s.source} after showing an illustration`)
  }
  assert.equal(last, 3)
})

// ---------------------------------------------------------------- smooth scrolling

test('lineKeypoints groups words by line within the tolerance', () => {
  const words = [
    { t0: 0, t1: 1, y: 100 },
    { t0: 1, t1: 2, y: 101 },
    { t0: 2, t1: 3, y: 100 },
    { t0: 3, t1: 4, y: 130 },
    { t0: 4, t1: 6, y: 131 }
  ]
  const k = lineKeypoints(words, 5)
  assert.equal(k.length, 2)
  near(k[0].t, 1.5)
  assert.equal(k[0].y, 100)
  near(k[1].t, 4.5)
  assert.equal(k[1].y, 130)
})

test('lineKeypoints: single line, empty input, tolerance boundary', () => {
  assert.deepEqual(lineKeypoints([], 5), [])
  assert.deepEqual(lineKeypoints([{ t0: 2, t1: 4, y: 50 }], 5), [{ t: 3, y: 50 }])
  // a difference equal to the tolerance starts a new line (strictly less than tol = same line)
  assert.equal(lineKeypoints([{ t0: 0, t1: 1, y: 0 }, { t0: 1, t1: 2, y: 5 }], 5).length, 2)
})

test('lineKeypoints: a paragraph jump yields a separate keypoint with the larger y', () => {
  const k = lineKeypoints(
    [
      { t0: 0, t1: 1, y: 10 },
      { t0: 1, t1: 2, y: 10 },
      { t0: 2.5, t1: 3, y: 90 }
    ],
    8
  )
  assert.equal(k.length, 2)
  assert.ok(k[1].y > k[0].y && k[1].t > k[0].t)
})

test('scrollYAt clamps the ends and interpolates midpoints', () => {
  const k = [{ t: 1, y: 100 }, { t: 3, y: 160 }, { t: 5, y: 180 }]
  assert.equal(scrollYAt(k, -10), 100)
  assert.equal(scrollYAt(k, 1), 100)
  assert.equal(scrollYAt(k, 99), 180)
  assert.equal(scrollYAt(k, 5), 180)
  near(scrollYAt(k, 2), 130)
  near(scrollYAt(k, 4), 170)
  assert.equal(scrollYAt(k, 3), 160)
  assert.equal(scrollYAt([], 3), 0)
  assert.equal(scrollYAt([{ t: 2, y: 42 }], 100), 42)
})

test('scrollYAt is monotonic for monotonic keypoints', () => {
  const k = []
  for (let i = 0; i < 40; i++) k.push({ t: i * 1.7, y: i * 28 + (i % 5) * 3 })
  let prev = -Infinity
  for (let t = -1; t < 75; t += 0.13) {
    const y = scrollYAt(k, t)
    assert.ok(y >= prev - 1e-9)
    prev = y
  }
})

test('scrollYAt tolerates equal-t keypoints (degenerate span)', () => {
  const k = [{ t: 1, y: 10 }, { t: 2, y: 20 }, { t: 2, y: 50 }, { t: 3, y: 60 }]
  for (const t of [1.5, 2, 2.0001, 2.5]) assert.ok(Number.isFinite(scrollYAt(k, t)))
  const two = [{ t: 1, y: 10 }, { t: 1, y: 30 }, { t: 1, y: 40 }]
  assert.ok(Number.isFinite(scrollYAt(two, 1)))
})

test('easeToward converges, snaps on a large distance and for a negligible one', () => {
  let cur = 0
  for (let i = 0; i < 300; i++) cur = easeToward(cur, 100, 1 / 60, 0.2, 1000)
  assert.equal(cur, 100)
  assert.equal(easeToward(0, 5000, 0.016, 0.2, 1000), 5000)
  assert.equal(easeToward(0, -5000, 0.016, 0.2, 1000), -5000)
  assert.equal(easeToward(10, 10.02, 0.016, 0.2, 1000), 10.02)
  const step = easeToward(0, 100, 0.016, 0.2, 1000)
  assert.ok(step > 0 && step < 100)
  assert.equal(easeToward(0, 100, 0, 0.2, 1000), 0)
  assert.equal(easeToward(0, 100, -1, 0.2, 1000), 0)
})

test('easeToward is frame-rate independent: 1 x 60 ms == 2 x 30 ms', () => {
  const one = easeToward(0, 100, 0.06, 0.25, 1000)
  const two = easeToward(easeToward(0, 100, 0.03, 0.25, 1000), 100, 0.03, 0.25, 1000)
  near(one, two, 1e-6)
})

// ---------------------------------------------------------------- clock smoother

test('ClockSmoother advances by itself and snaps on the first call', () => {
  const c = new ClockSmoother()
  assert.equal(c.step(10, 0.016), 10)
  const t = c.step(10.016, 0.016)
  near(t, 10.016, 1e-3)
  let est = 10.016
  let prev = t
  for (let i = 0; i < 60; i++) {
    est += 0.016
    const v = c.step(est, 0.016)
    assert.ok(v >= prev)
    prev = v
  }
  near(prev, est, 0.01)
})

test('ClockSmoother never runs backwards for a small backward correction', () => {
  const c = new ClockSmoother()
  c.reset(50)
  let prev = 50
  // the estimate keeps being 0.4 s behind the smoothed clock
  for (let i = 0; i < 200; i++) {
    const v = c.step(prev - 0.4, 0.016)
    assert.ok(v >= prev, `moved back at step ${i}`)
    prev = v
  }
})

test('ClockSmoother snaps on a jump over one second (seek) in both directions', () => {
  const c = new ClockSmoother()
  c.reset(10)
  assert.equal(c.step(25, 0.016), 25)
  assert.equal(c.step(3, 0.016), 3)
})

test('ClockSmoother converges to the estimate after a small forward error', () => {
  const c = new ClockSmoother()
  c.reset(20)
  let v = 20
  for (let i = 0; i < 400; i++) v = c.step(20.5, 0)
  // dt = 0 does not advance anything
  assert.equal(v, 20)
  for (let i = 0; i < 400; i++) v = c.step(20.5, 0.016, 0)
  near(v, 20.5, 0.01)
})

test('ClockSmoother honours the playback rate', () => {
  const c = new ClockSmoother()
  c.reset(0)
  const v = c.step(0.032, 0.016, 2)
  near(v, 0.032, 1e-3)
})

// ---------------------------------------------------------------- reader prefs

const memStorage = (init = {}) => {
  const m = new Map(Object.entries(init))
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m }
}
const throwingStorage = {
  getItem() {
    throw new Error('denied')
  },
  setItem() {
    throw new Error('denied')
  }
}

test('FONT_SCALES: strictly ascending, small enough for a TV, default is scale 1', () => {
  for (let i = 1; i < FONT_SCALES.length; i++) assert.ok(FONT_SCALES[i] > FONT_SCALES[i - 1])
  assert.ok(Math.min(...FONT_SCALES) <= 0.4)
  assert.ok(FONT_SCALES.filter((s) => s < 1).length >= 6)
  assert.equal(FONT_SCALES[DEFAULT_FONT_LEVEL], 1)
})

test('nearestFontLevel picks the closest step; ties go to the smaller one', () => {
  assert.equal(nearestFontLevel(1), DEFAULT_FONT_LEVEL)
  assert.equal(nearestFontLevel(0.1), 0)
  assert.equal(nearestFontLevel(10), FONT_SCALES.length - 1)
  assert.equal(nearestFontLevel(0.41), 0)
  assert.equal(nearestFontLevel(1.3), FONT_SCALES.indexOf(1.25))
  // exactly between 1.25 and 1.5
  assert.equal(nearestFontLevel(1.375), FONT_SCALES.indexOf(1.25))
})

test('loadFontLevel: new key, legacy index migration, garbage, missing', () => {
  assert.equal(FONT_SCALES[loadFontLevel(memStorage({ fs: '0.56' }), 'fs', 'old')], 0.56)
  // the new key wins over the legacy one
  assert.equal(FONT_SCALES[loadFontLevel(memStorage({ fs: '1.5', old: '0' }), 'fs', 'old')], 1.5)
  const legacy = (i) => FONT_SCALES[loadFontLevel(memStorage({ old: String(i) }), 'fs', 'old')]
  assert.equal(legacy(0), 0.8)
  assert.equal(legacy(1), 1)
  assert.equal(legacy(4), 1.8)
  assert.equal(loadFontLevel(memStorage({ old: '7' }), 'fs', 'old'), DEFAULT_FONT_LEVEL)
  assert.equal(loadFontLevel(memStorage({ old: '-1' }), 'fs', 'old'), DEFAULT_FONT_LEVEL)
  assert.equal(loadFontLevel(memStorage({ fs: 'abc', old: 'xyz' }), 'fs', 'old'), DEFAULT_FONT_LEVEL)
  assert.equal(loadFontLevel(memStorage({ fs: '-2' }), 'fs'), DEFAULT_FONT_LEVEL)
  assert.equal(loadFontLevel(memStorage(), 'fs', 'old'), DEFAULT_FONT_LEVEL)
  // without a legacy key the old index is ignored
  assert.equal(loadFontLevel(memStorage({ old: '0' }), 'fs'), DEFAULT_FONT_LEVEL)
  assert.equal(loadFontLevel(null, 'fs', 'old'), DEFAULT_FONT_LEVEL)
})

test('saveFontLevel / loadFontLevel round trip for every level, with clamping', () => {
  FONT_SCALES.forEach((_, i) => {
    const st = memStorage()
    saveFontLevel(st, 'fs', i)
    assert.equal(loadFontLevel(st, 'fs'), i)
  })
  const st = memStorage()
  saveFontLevel(st, 'fs', 999)
  assert.equal(loadFontLevel(st, 'fs'), FONT_SCALES.length - 1)
  saveFontLevel(st, 'fs', -5)
  assert.equal(loadFontLevel(st, 'fs'), 0)
})

test('loadFlag / saveFlag round trip and defaults', () => {
  const st = memStorage()
  assert.equal(loadFlag(st, NIGHT_KEY), false)
  assert.equal(loadFlag(st, SMOOTH_KEY, true), true)
  saveFlag(st, NIGHT_KEY, true)
  saveFlag(st, SMOOTH_KEY, false)
  assert.equal(loadFlag(st, NIGHT_KEY), true)
  assert.equal(loadFlag(st, SMOOTH_KEY, true), false)
  assert.equal(st.m.get(NIGHT_KEY), '1')
  st.setItem('junk', 'yes')
  assert.equal(loadFlag(st, 'junk', true), true)
})

test('a throwing or missing storage never throws and yields defaults', () => {
  assert.equal(loadFontLevel(throwingStorage, 'fs', 'old'), DEFAULT_FONT_LEVEL)
  assert.doesNotThrow(() => saveFontLevel(throwingStorage, 'fs', 3))
  assert.equal(loadFlag(throwingStorage, 'k', true), true)
  assert.doesNotThrow(() => saveFlag(throwingStorage, 'k', true))
  assert.doesNotThrow(() => saveFlag(undefined, 'k', true))
  assert.equal(loadFlag(undefined, 'k'), false)
})
