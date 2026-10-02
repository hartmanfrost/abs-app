// End-to-end test of the Book read-along layout (two panes, illustrations), Smooth/Step scrolling, font steps and night
// mode against the local ABS stack and the synthetic synced EPUB (invented content only).
//   test/e2e/stack.sh up && node test/e2e/book-illus.mjs [screenshotDir]
// Runs at 1920x1080 (TV output) and 960x540 (the Streamer's CSS viewport) with the D-pad, then at phone size (390x844, touch).
import { open, openItem, fixture, simulatePlayback, paneFlips } from './lib.mjs'
import { mkdirSync } from 'node:fs'

const shots = process.argv[2] || '/tmp/abs-e2e/shots121'
mkdirSync(shots, { recursive: true })
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}
const fx = fixture()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const ILL = fx.illustrations
const byId = (id) => ILL.find((i) => i.id === id)
const base = (p) => (p || '').split('/').pop()

async function session(w, h, { tv = true, touch = false } = {}) {
  const { browser, page } = await open({ tv, width: w, height: h, touch })
  await page.evaluate(() => {
    const walk = (c) => [c, ...c.$children.flatMap(walk)]
    window.__vm = () => walk(window.$nuxt).find((c) => c.$options.methods && c.$options.methods.tapWidget)
  })
  const S = { browser, page, w, h }
  S.bk = (fn, arg) => page.evaluate(([f, a]) => new Function('vm', 'a', 'return (' + f + ')(vm, a)')(window.__vm(), a), [fn.toString(), arg])
  S.press = async (k, n = 1) => {
    for (let i = 0; i < n; i++) await page.keyboard.press(k)
  }
  S.shot = (name) => page.screenshot({ path: `${shots}/vc121-${w}x${h}-${name}.png` })
  S.frame = () => page.frames().find((f) => f !== page.mainFrame() && f.url() === 'about:srcdoc')
  S.playing = () => page.evaluate(() => window.$nuxt.$store.state.playerIsPlaying)
  S.openBook = async (name = 'Synthetic Book') => {
    await openItem(page, name)
    await page.waitForSelector('[aria-label="Transcript"]', { timeout: 120000 })
    await page.locator('[aria-label="Transcript"]').first().click()
    await page.waitForSelector('.bk-frame', { timeout: 60000 })
    await page.waitForFunction(() => window.__vm() && window.__vm().status === 'ready' && window.__vm().items.length > 0, null, { timeout: 120000 })
    await sleep(1200)
  }
  // Book time of the first spoken word at or after (dir=1) / before (dir=-1) the word id, in book chapter ch (0-based)
  S.timeOf = (ch, id, dir = 1) =>
    S.bk(
      async (vm, [ch, id, dir]) => {
        const smil = await vm.book.timeline.smilFor(ch)
        const n = Number(id.slice(1))
        for (let k = 0; k < 40; k++) {
          const i = smil.idParIndex('w' + String(n + dir * k).padStart(6, '0'))
          if (i >= 0) return smil.starts[i]
        }
        return -1
      },
      [ch, id, dir]
    )
  // Seek there and report what the pane shows after it settled
  S.paneAt = async (t, wantChapter) => {
    await S.bk((vm, t) => vm.seekToTime(t), t)
    await page.waitForFunction((c) => window.__vm().viewChapter === c, wantChapter, { timeout: 30000 })
    await sleep(1100)
    return S.bk((vm) => ({ ch: vm.viewChapter, item: vm.paneItem && { key: vm.paneItem.key, kind: vm.paneItem.kind, path: vm.paneItem.path, src: !!vm.paneItem.src }, pending: vm.carryPending, wordEl: vm.wordEl && vm.wordEl.id }))
  }
  S.header = async (id, activate = true) => {
    await S.press((await S.bk((vm) => vm.twoPane)) ? 'ArrowLeft' : 'ArrowRight')
    await S.bk((vm) => { vm.headerIdx = 0 })
    const at = await S.bk((vm, id) => vm.headerButtons.findIndex((b) => b.id === id), id)
    if (at < 0) throw new Error('no header button ' + id)
    await S.press('ArrowRight', at)
    if (activate) await S.press('Enter')
    await S.press('ArrowDown')
  }
  return S
}

// ======================================================================= wide (TV) runs
for (const [W, H] of [[1920, 1080], [960, 540]]) {
  console.log(`\n=== TV ${W}x${H} ===`)
  const S = await session(W, H)
  const { page, bk, press } = S
  await S.openBook()
  const f1 = S.frame()

  // ---- layout
  const geo = await page.evaluate(() => {
    const r = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } }
    return { root: r('.book-reader'), col: r('.bk-col'), pane: r('.bk-pane'), frame: r('.bk-frame') }
  })
  check('two-pane layout on a wide screen', !!geo.pane && (await bk((vm) => vm.twoPane)))
  check('text column is the left two thirds, pane the right third', Math.abs(geo.col.w / geo.root.w - 0.6667) < 0.012 && Math.abs(geo.pane.w / geo.root.w - 0.3333) < 0.012, JSON.stringify({ col: (geo.col.w / geo.root.w).toFixed(3), pane: (geo.pane.w / geo.root.w).toFixed(3) }))
  check('pane sits at the right edge, column at the left edge', Math.abs(geo.pane.x + geo.pane.w - geo.root.w) < 1.5 && geo.col.x < 1.5)

  // ---- illustrations are out of the text flow, ornaments stay
  const flow = await f1.evaluate(() => ({ imgs: [...document.querySelectorAll('img')].map((i) => i.className), svg: document.querySelectorAll('svg').length, widgets: document.querySelectorAll('.abs-widget').length, marks: [...document.querySelectorAll('.abs-ill')].map((m) => m.getBoundingClientRect().height), words: document.querySelectorAll('[id^=w]').length }))
  check('chapter 1: both illustrations (img + svg image) left the flow, leaving two small markers', !flow.imgs.includes('illus') && flow.svg === 0 && flow.marks.length === 2 && flow.marks.every((h) => h < 40), JSON.stringify(flow))
  check('the inline ornament stayed in the text', flow.imgs.filter((c) => c === 'orn').length === 1)
  const gap = await f1.evaluate(() => {
    const m = document.querySelector('.abs-ill')
    const prev = m.previousElementSibling
    const next = m.nextElementSibling
    return { before: prev ? m.getBoundingClientRect().top - prev.getBoundingClientRect().bottom : null, after: next ? next.getBoundingClientRect().top - m.getBoundingClientRect().bottom : null }
  })
  check('no big gap where an illustration was', gap.before !== null && gap.before < 60 && gap.after < 60, JSON.stringify(gap))

  // ---- pane follows the reading position, sticky until displaced
  await S.bk((vm) => { if (!vm.isPlaying) vm.$emit('toggle-play') })
  const A = byId('A')
  const B = byId('B')
  const Wd = byId('W')
  const C = byId('C')
  const D = byId('D')
  const probe = async (label, ch, id, dir, expectPath, expectKind = 'img', offset = 0.25) => {
    const t = await S.timeOf(ch, id, dir)
    const r = await S.paneAt(t + (dir > 0 ? offset : -offset), ch)
    const ok = expectPath === null ? r.item === null : r.item && base(r.item.path) === base(expectPath) && r.item.kind === expectKind && r.item.src
    check(label, ok, JSON.stringify(r))
    return r
  }
  await probe('chapter 1, start of the book: no illustration yet (empty state)', 0, 'w000001', 1, null)
  check('empty state is shown in the pane', (await page.locator('.bk-pane-empty').count()) === 1)
  await probe('just before illustration A: still the empty state', 0, A.afterWordId, -1, null)
  await probe('after A: A is shown', 0, A.firstWordIdAfter, 1, A.path)
  const rA = await S.bk((vm) => vm.paneItem.key)
  await probe('just before B: A is still shown (sticky)', 0, B.afterWordId, -1, A.path)
  await probe('after B: B (svg image) displaces A', 0, B.firstWordIdAfter, 1, B.path)
  await S.shot('pane-B-svg')
  const ch2first = fx.chapters[1].firstSpokenId
  const rC = await probe('chapter 2 start, before its first illustration: the last illustration of chapter 1 (B) is kept', 1, ch2first, 1, B.path)
  check('...and it is the carried-over one from the previous chapter', rC.item && rC.item.key.startsWith('0:'), rC.item && rC.item.key)
  await probe('just before the widget: B is still shown', 1, Wd.afterWordId, -1, B.path)
  await probe('after the widget: the widget thumbnail is shown', 1, Wd.firstWordIdAfter, 1, Wd.path, 'widget')
  await sleep(1500)
  const wFrames = page.frames().filter((f) => /epub-vfs/.test(f.url()))
  check('exactly one live (muted) widget frame, in the pane', wFrames.length === 1 && (await page.evaluate(() => !!document.querySelector('.bk-pane-box iframe'))), String(wFrames.length))
  await S.shot('pane-widget')
  await probe('just before C: the widget is still shown', 1, C.afterWordId, -1, Wd.path, 'widget')
  await sleep(600)
  await probe('after C (figure with a narrated caption): C is shown', 1, C.firstWordIdAfter, 1, C.path)
  await sleep(600)
  check('the live widget frame is gone once another illustration is shown', page.frames().filter((f) => /epub-vfs/.test(f.url())).length === 0)
  const cap = await bk((vm, ids) => ids.map((id) => !!vm.doc.getElementById(id) && vm.doc.getElementById(id).closest('figcaption') !== null), C.narratedCaption)
  check('the narrated figure caption stayed in the text (and can be highlighted)', cap.every(Boolean), JSON.stringify(cap))
  await probe('after D: D is shown', 1, D.firstWordIdAfter, 1, D.path)
  await S.shot('pane-D')
  const ch3first = fx.chapters[2].firstSpokenId
  const r3 = await probe('chapter 3 has no illustration: the last one of chapter 2 (D) is carried over', 2, ch3first, 1, D.path)
  check('...carried from chapter 2', r3.item && r3.item.key.startsWith('1:'), r3.item && r3.item.key)
  await probe('seeking back into chapter 1 between A and B shows A again', 0, A.firstWordIdAfter, 1, A.path, 'img', 3)
  void rA

  // ---- regression (vc121 bug): during real playback ticks - words, unspoken runs, gaps, chapter switches - the pane
  // changes only when an illustration boundary is crossed and never flips back to a carried-over / earlier illustration
  const sim = await simulatePlayback(page, 0, 2)
  const keys = sim.seq.map((s) => s[2]).filter((k) => k !== null)
  check('playback ticks over the whole book: the pane sequence is exactly A, B, W, C, D (each once, in order, none stale from before)', JSON.stringify(keys) === JSON.stringify(['0:0', '0:1', '1:0', '1:1', '1:2']), JSON.stringify(sim.seq))
  check('...and it never flips back or goes empty after showing something', paneFlips(sim.seq).length === 0, JSON.stringify(paneFlips(sim.seq)))
  await bk((vm) => { if (!vm.isPlaying) vm.$emit('toggle-play') })
  await sleep(800)
  check('...and the picture / frame is mounted once per selection, never re-created for an unchanged one', sim.mounts <= keys.length + 1, `${sim.mounts} mounts for ${keys.length} selections`)

  // ---- pane geometry: the picture fits the third
  await probe('A again for geometry', 0, A.firstWordIdAfter, 1, A.path, 'img', 3)
  const fit = await page.evaluate(() => {
    const p = document.querySelector('.bk-pane').getBoundingClientRect()
    const i = document.querySelector('.bk-pane-img').getBoundingClientRect()
    return { inside: i.left >= p.left - 1 && i.right <= p.right + 1 && i.top >= p.top - 1 && i.bottom <= p.bottom + 1, ratio: i.width / i.height, nat: document.querySelector('.bk-pane-img').naturalWidth / document.querySelector('.bk-pane-img').naturalHeight, fill: Math.max(i.width / p.width, i.height / p.height) }
  })
  check('illustration is scaled to fit the pane keeping its proportions', fit.inside && Math.abs(fit.ratio - fit.nat) < 0.03 && fit.fill > 0.7, JSON.stringify(fit))
  await S.shot('pane-A')

  // ---- D-pad: Right -> pane, OK opens the picture full screen (audio keeps playing), Back returns
  await bk((vm) => { vm.resumeFollow() })
  await sleep(300)
  await press('ArrowRight')
  check('Right from the text focuses the pane', (await bk((vm) => vm.zone)) === 'pane' && (await page.locator('.bk-pane-focus').count()) === 1)
  await S.shot('pane-focus')
  const playingBefore = await S.playing()
  await press('Enter')
  await page.waitForSelector('.bk-wfull img', { timeout: 5000 })
  check('OK on a picture opens it full screen', true)
  await sleep(500)
  check('OK on a picture pauses the audiobook (like a widget)', playingBefore === true && !(await S.playing()), `before=${playingBefore}`)
  await S.shot('pane-fullscreen-still')
  await press('Escape')
  await page.waitForFunction(() => !document.querySelector('.bk-wfull'), null, { timeout: 5000 })
  await sleep(600)
  check('Back closes the full-screen picture, resumes the audiobook and stays in the reader', !!(await page.$('.bk-frame')) && (await bk((vm) => vm.zone)) === 'pane' && (await S.playing()))
  await press('ArrowLeft')
  check('Left from the pane returns to the text', (await bk((vm) => vm.zone)) === 'list')
  await press('ArrowRight')
  await press('ArrowUp')
  check('Up from the pane goes to the header', (await bk((vm) => vm.zone)) === 'header')
  await press('ArrowRight', 2)
  await press('ArrowLeft')
  await press('ArrowDown')
  check('header row: Left/Right between buttons, Down back to the text', (await bk((vm) => vm.zone)) === 'list')
  await press('ArrowLeft')
  check('Left from the text still reaches the header row', (await bk((vm) => vm.zone)) === 'header')
  await press('ArrowDown')

  // widget full screen from the pane pauses the audiobook; Back resumes
  await probe('widget for the full-screen check', 1, Wd.firstWordIdAfter, 1, Wd.path, 'widget', 1)
  await sleep(900)
  if (!(await S.playing())) await bk((vm) => { vm.$emit('toggle-play') })
  await sleep(500)
  await press('ArrowRight')
  await press('Enter')
  await page.waitForSelector('.bk-wfull iframe', { timeout: 10000 })
  await sleep(1200)
  check('OK on the widget opens it full screen and pauses the audiobook', !(await S.playing()))
  check('the pane live frame was stopped while full screen is open', (await page.evaluate(() => document.querySelectorAll('.bk-pane-box iframe').length)) === 0)
  await press('Escape')
  await page.waitForFunction(() => !document.querySelector('.bk-wfull'), null, { timeout: 5000 })
  await sleep(800)
  check('Back resumes the audiobook', await S.playing())
  await sleep(1500)
  check('the pane widget goes live again after closing', (await page.evaluate(() => document.querySelectorAll('.bk-pane-box iframe').length)) === 1)
  await press('ArrowLeft')

  // ---- browsing (not following) moves the pane with the browsed paragraph
  await S.bk((vm) => vm.resumeFollow())
  await probe('back to just after A for browsing', 0, A.firstWordIdAfter, 1, A.path, 'img', 1)
  if (await S.playing()) await bk((vm) => { vm.$emit('toggle-play') })
  await sleep(400)
  await bk((vm, id) => {
    vm.following = false
    vm.select(vm.itemIndex.get(vm.doc.getElementById(id).closest('p')))
  }, B.afterWordId)
  await sleep(500)
  check('browsing the paragraph before B shows A', base(await bk((vm) => vm.paneItem && vm.paneItem.path)) === base(A.path))
  await press('ArrowDown')
  await sleep(500)
  check('browsing down past B shows B', base(await bk((vm) => vm.paneItem && vm.paneItem.path)) === base(B.path))
  await press('ArrowUp')
  await sleep(500)
  check('browsing back up shows A again', base(await bk((vm) => vm.paneItem && vm.paneItem.path)) === base(A.path))
  await S.bk((vm) => vm.resumeFollow())

  // ---- swap text and illustrations (same proportions, mirrored; Left/Right roles mirror too)
  await probe('picture for the swap check', 0, A.firstWordIdAfter, 1, A.path, 'img', 1)
  await bk((vm) => vm.resumeFollow())
  await S.header('swap')
  const sw = await page.evaluate(() => {
    const r = (s) => { const b = document.querySelector(s).getBoundingClientRect(); return { x: b.x, w: b.width } }
    return { root: r('.book-reader'), col: r('.bk-col'), pane: r('.bk-pane'), ls: window.localStorage.getItem('absBookPanesSwapped') }
  })
  check('swap: illustrations on the left third, text on the right two thirds, same proportions', sw.pane.x < 1.5 && Math.abs(sw.pane.w / sw.root.w - 0.3333) < 0.012 && Math.abs(sw.col.w / sw.root.w - 0.6667) < 0.012 && Math.abs(sw.col.x + sw.col.w - sw.root.w) < 1.5, JSON.stringify(sw))
  check('swap is persisted', sw.ls === '1')
  const fitSw = await page.evaluate(() => {
    const p = document.querySelector('.bk-pane').getBoundingClientRect()
    const i = document.querySelector('.bk-pane-img').getBoundingClientRect()
    return i.left >= p.left - 1 && i.right <= p.right + 1 && i.height > 20
  })
  check('swap: the picture still fits its pane', fitSw)
  await S.shot('swapped')
  await press('ArrowRight')
  check('swapped: Right from the text goes to the header row (mirrored)', (await bk((vm) => vm.zone)) === 'header')
  await press('ArrowDown')
  await press('ArrowLeft')
  check('swapped: Left from the text focuses the pane', (await bk((vm) => vm.zone)) === 'pane')
  await press('ArrowLeft')
  check('swapped: Left from the pane goes to the header (away from the text)', (await bk((vm) => vm.zone)) === 'header')
  await press('ArrowDown')
  await press('ArrowLeft')
  await press('ArrowRight')
  check('swapped: Right from the pane returns to the text', (await bk((vm) => vm.zone)) === 'list')
  await probe('swapped: the pane still follows the reading position', 0, B.firstWordIdAfter, 1, B.path)
  await S.shot('swapped-B')
  await bk((vm) => vm.toggleSwap())
  await sleep(300)
  check('swap back restores the original layout', await page.evaluate(() => document.querySelector('.bk-pane').getBoundingClientRect().x > 100))

  // ---- font steps
  const scales = await bk((vm) => {
    const out = []
    const keep = vm.fontLevel
    for (let i = 0; i < 11; i++) {
      vm.fontLevel = i
      vm.applyScale()
      out.push(+vm.scale.toFixed(3))
    }
    vm.fontLevel = keep
    vm.applyScale()
    return out
  })
  check('every font step gives a distinct, increasing page scale (no clamp swallows the small ones)', scales.every((v, i) => i === 0 || v > scales[i - 1]) && scales[0] < scales[7] * 0.45, JSON.stringify(scales))
  await bk((vm) => { vm.fontLevel = 0 })
  await sleep(800)
  await S.shot('font-smallest')
  const small = await f1.evaluate(() => parseFloat(getComputedStyle(document.querySelector('p.body')).fontSize))
  const smallPx = small * (await bk((vm) => vm.scale))
  check('the smallest step is genuinely small on screen', smallPx < H * 0.03, `${smallPx.toFixed(1)}px of ${H}`)
  await bk((vm) => { vm.fontLevel = 7 })
  await sleep(600)

  // ---- Smooth scrolling
  await probe('smooth scroll start position', 0, '' + fx.chapters[0].firstSpokenId, 1, null, 'img', 0.5)
  await bk((vm) => { vm.resumeFollow(); if (!vm.isPlaying) vm.$emit('toggle-play') })
  await page.waitForFunction(() => window.__vm().isPlaying, null, { timeout: 5000 }).catch(() => {})
  await sleep(1500)
  check('smooth is the default and the engine runs while following and playing', (await bk((vm) => vm.smooth && vm.smoothRun)) === true)
  const f = S.frame()
  await f.evaluate(() => {
    window.__rc = 0
    const orig = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = function () { window.__rc++; return orig.call(this) }
  })
  const samples = await f.evaluate(() =>
    new Promise((res) => {
      const out = []
      const t0 = performance.now()
      const b = document.body
      const step = () => {
        const m = new DOMMatrix(getComputedStyle(b).transform)
        out.push([performance.now() - t0, -m.m42, window.scrollY])
        if (performance.now() - t0 < 4000) requestAnimationFrame(step)
        else res(out)
      }
      requestAnimationFrame(step)
    })
  )
  const ys = samples.map((s) => s[1])
  const deltas = ys.slice(1).map((v, i) => v - ys[i])
  const back = deltas.filter((d) => d < -0.5).length
  const maxD = Math.max(...deltas.map(Math.abs))
  const moved = ys[ys.length - 1] - ys[0]
  const nz = deltas.filter((d) => Math.abs(d) > 0.001).length
  check('smooth: the page glides (many small steps, never a line-sized jump)', samples.length > 60 && maxD < 5 && moved > 3 && nz > samples.length * 0.25, JSON.stringify({ frames: samples.length, maxPerFrame: +maxD.toFixed(2), moved: +moved.toFixed(1), movingFrames: nz }))
  check('smooth: the offset never runs backwards', back === 0, String(back))
  check('smooth: native scroll position stays frozen while the transform moves', new Set(samples.map((s) => s[2])).size === 1)
  const rc = await f.evaluate(() => window.__rc)
  check('smooth: layout is read only when the active word changes, not per frame', rc < 110, `${rc} getBoundingClientRect calls in 4 s (${samples.length} frames)`)
  const lineNow = await bk((vm) => {
    const r = vm.wordEl && vm.wordEl.getBoundingClientRect()
    return r ? { top: r.top / vm.win.innerHeight, id: vm.wordEl.id } : null
  })
  check('smooth: the active line stays at the reading line', lineNow && lineNow.top > 0.1 && lineNow.top < 0.5, JSON.stringify(lineNow))
  await S.shot('smooth-reading')

  // seek far, then a chapter switch: eases to the new place, no stuck state
  const tFar = await S.timeOf(0, fx.chapters[0].lastSpokenId, -1)
  await S.bk((vm, t) => vm.seekToTime(t), tFar - 6)
  await sleep(1500)
  const afterSeek = await bk((vm) => { const r = vm.wordEl && vm.wordEl.getBoundingClientRect(); return { top: r ? r.top / vm.win.innerHeight : null, run: vm.smoothRun } })
  check('smooth: after a seek the active line is back at the reading line', afterSeek.top > 0.05 && afterSeek.top < 0.55 && afterSeek.run, JSON.stringify(afterSeek))
  await page.waitForFunction(() => window.__vm().viewChapter === 1, null, { timeout: 30000 })
  await sleep(1500)
  const afterCh = await bk((vm) => { const r = vm.wordEl && vm.wordEl.getBoundingClientRect(); return { ch: vm.viewChapter, top: r ? r.top / vm.win.innerHeight : null, run: vm.smoothRun } })
  check('smooth: after the chapter switch the engine runs on the new document', afterCh.run && afterCh.top > 0.05 && afterCh.top < 0.55, JSON.stringify(afterCh))

  // pause commits the offset without a visual jump
  await probe('deep into chapter 2 (so that the transform offset is not zero)', 1, C.firstWordIdAfter, 1, C.path, 'img', 4)
  await sleep(1500)
  const before = await bk((vm) => vm.wordEl.getBoundingClientRect().top)
  const offBefore = await bk((vm) => vm.smY)
  await bk((vm) => { vm.$emit('toggle-play') })
  await sleep(600)
  const afterPause = await bk((vm) => ({ top: vm.wordEl ? vm.wordEl.getBoundingClientRect().top : null, run: vm.smoothRun, tf: vm.doc.body.style.transform, sy: vm.win.scrollY }))
  check('pausing stops the engine, clears the transform and keeps the picture in place', !afterPause.run && afterPause.tf === '' && afterPause.sy > 0 && Math.abs(afterPause.top - before) < 40, JSON.stringify({ before, offBefore, ...afterPause }))
  await bk((vm) => { vm.$emit('toggle-play') })
  await sleep(800)

  // toggle to Step with the D-pad
  await S.header('scroll')
  const stepState = await bk((vm) => ({ smooth: vm.smooth, run: vm.smoothRun, ls: window.localStorage.getItem('absBookSmoothScroll') }))
  check('header toggle switches to Step and persists', stepState.smooth === false && !stepState.run && stepState.ls === '0', JSON.stringify(stepState))
  await sleep(2500)
  const tfStep = await bk((vm) => vm.doc.body.style.transform)
  check('step: no transform is used (native scrolling as before)', tfStep === '')
  await S.header('scroll')
  check('...and back to Smooth', (await bk((vm) => vm.smooth)) === true)

  // ---- night mode
  await S.header('night')
  const night = await f.evaluate(() => {
    const cs = (e, p) => getComputedStyle(e, p)
    const p = document.querySelector('p.body')
    const act = document.getElementsByClassName('-epub-media-overlay-active')[0]
    const dc = document.querySelector('p.dropcap')
    return {
      cls: document.documentElement.classList.contains('abs-night'),
      bodyBg: cs(document.body).backgroundColor,
      htmlBg: cs(document.documentElement).backgroundColor,
      color: cs(p).color,
      fill: cs(p).webkitTextFillColor,
      h1: cs(document.querySelector('h1')).color,
      first: dc ? cs(dc, '::first-letter').color : null,
      act: act ? { bg: cs(act).backgroundColor, color: cs(act).color } : null,
      orn: document.querySelector('img.orn') ? cs(document.querySelector('img.orn')).filter : 'none'
    }
  })
  check('night: iframe document switches to light text on black', night.cls && (night.bodyBg === 'rgb(0, 0, 0)' || night.bodyBg === 'rgba(0, 0, 0, 0)') && night.htmlBg === 'rgb(0, 0, 0)' && night.color === 'rgb(232, 232, 232)' && night.fill === 'rgb(232, 232, 232)', JSON.stringify(night))
  check('night: headings and the (first-letter) drop cap stay readable', night.h1 === 'rgb(255, 255, 255)' && (night.first === null || night.first === 'rgb(255, 255, 255)'), JSON.stringify({ h1: night.h1, first: night.first }))
  check('night: active word is a solid amber block with black text', night.act && night.act.bg === 'rgb(255, 196, 0)' && night.act.color === 'rgb(0, 0, 0)', JSON.stringify(night.act))
  check('night: illustrations are not filtered', night.orn === 'none')
  const nightParent = await page.evaluate(() => ({ root: getComputedStyle(document.querySelector('.book-reader')).backgroundColor, pane: getComputedStyle(document.querySelector('.bk-pane')).backgroundColor, ls: window.localStorage.getItem('absReaderNight') }))
  check('night: reader, pane are black and the choice is persisted', nightParent.root === 'rgb(0, 0, 0)' && nightParent.pane === 'rgb(0, 0, 0)' && nightParent.ls === '1', JSON.stringify(nightParent))
  await S.shot('night-text')
  await probe('night: pane picture', 1, C.firstWordIdAfter, 1, C.path)
  await S.shot('night-pane')
  // chapter switch keeps night
  await probe('night survives a chapter switch', 0, A.firstWordIdAfter, 1, A.path, 'img', 1)
  check('night: the new chapter document is dark too', await S.frame().evaluate(() => document.documentElement.classList.contains('abs-night')))
  // ---- regression: no light frame while a chapter switches in night mode (the new document used to paint in day colours first)
  const lum = (buf) =>
    page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(await (await fetch('data:image/jpeg;base64,' + b64)).blob())
      const c = document.createElement('canvas')
      c.width = bmp.width
      c.height = bmp.height
      const x = c.getContext('2d')
      x.drawImage(bmp, 0, 0)
      const d = x.getImageData(0, 0, c.width, c.height).data
      let sum = 0
      let n = 0
      for (let i = 0; i < d.length; i += 16) {
        sum += d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11
        n++
      }
      return sum / n
    }, buf.toString('base64'))
  const clip = { x: 0, y: Math.round(H * 0.1), width: Math.round(W * 0.6), height: Math.round(H * 0.8) }
  let brightest = 0
  let frames = 0
  for (const [target, fromWord] of [[1, fx.chapters[1].firstSpokenId], [2, fx.chapters[2].firstSpokenId], [0, fx.chapters[0].firstSpokenId]]) {
    const t = await S.timeOf(target, fromWord, 1)
    await bk((vm, t) => vm.seekToTime(t), t + 0.3)
    const t0 = Date.now()
    while (Date.now() - t0 < 3500) {
      const buf = await page.screenshot({ type: 'jpeg', quality: 40, clip })
      brightest = Math.max(brightest, await lum(buf))
      frames++
    }
    await page.waitForFunction((c) => window.__vm().viewChapter === c, target, { timeout: 30000 })
  }
  check('night: no light frame while chapters switch (document is dark from the first paint)', frames > 15 && brightest < 80, `${frames} frames, brightest mean luminance ${brightest.toFixed(1)}`)
  check('night: the chapter markup itself carries the night class', (await bk((vm) => vm.$refs.frame.srcdoc.includes('abs-night'))) === true)
  await S.header('night')
  check('day mode restores', !(await S.frame().evaluate(() => document.documentElement.classList.contains('abs-night'))) && (await bk(() => window.localStorage.getItem('absReaderNight'))) === '0')
  await S.shot('day-text')

  await S.browser.close()
}

// ======================================================================= transcript view night mode
{
  console.log('\n=== transcript view night mode ===')
  const S = await session(1280, 720)
  await S.page.evaluate(() => window.localStorage.setItem('absReaderNight', '1'))
  await S.openBook('Synthetic Both')
  await S.header('mode')
  await S.page.waitForSelector('.tr-block', { timeout: 30000 })
  await sleep(1500)
  const tv = await S.page.evaluate(() => {
    const root = document.querySelector('.transcript-view')
    return { night: root.classList.contains('tr-night'), bg: getComputedStyle(root).backgroundColor, color: getComputedStyle(document.querySelector('.tr-block')).color, now: !!document.querySelector('.tr-word-now') }
  })
  check('transcript view honours the persisted night mode (black background, light text)', tv.night && tv.bg === 'rgb(0, 0, 0)' && /^rgb\((1[5-9]\d|2\d\d), (1[5-9]\d|2\d\d), (1[5-9]\d|2\d\d)\)$/.test(tv.color), JSON.stringify(tv))
  await S.shot('transcript-night')
  await S.browser.close()
}

// ======================================================================= phone (portrait, touch)
{
  console.log('\n=== phone 390x844 ===')
  const S = await session(390, 844, { tv: false, touch: true })
  const { page, bk } = S
  // an old index-based font preference is migrated to the nearest new step
  await page.evaluate(() => { window.localStorage.removeItem('absBookFontScale'); window.localStorage.setItem('absBookFontLevel', '0') })
  await S.openBook()
  check('phone: single column (no pane)', (await page.locator('.bk-pane').count()) === 0 && !(await bk((vm) => vm.twoPane)))
  check('old stored font level 0 (x0.8) maps to the x0.8 step', (await bk((vm) => vm.fontLevel)) === 5)
  const f = S.frame()
  const flow = await f.evaluate(() => ({ imgs: [...document.querySelectorAll('img')].filter((i) => i.className === 'illus').length, markers: document.querySelectorAll('.abs-ill').length }))
  check('phone: illustrations stay in the text flow', flow.imgs >= 1 && flow.markers === 0, JSON.stringify(flow))
  const hdr = await page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const btns = [...document.querySelectorAll('.tr-btn')].map((b) => b.getBoundingClientRect())
    const clock = document.querySelector('.tr-sub .font-mono').getBoundingClientRect()
    return { vw, n: btns.length, maxRight: Math.max(...btns.map((b) => b.right)), minLeft: Math.min(...btns.map((b) => b.left)), clockRight: clock.right, clockLeft: clock.left, btnLeft: Math.min(...btns.map((b) => b.left)) }
  })
  check('phone: all header buttons fit on screen and leave room for the clock', hdr.maxRight <= hdr.vw + 0.5 && hdr.clockRight < hdr.btnLeft, JSON.stringify(hdr))
  check('phone: no Smooth/Step button on a touch phone (page scrolls by hand), night button present', !(await bk((vm) => vm.headerButtons.some((b) => b.id === 'scroll'))) && (await bk((vm) => vm.headerButtons.some((b) => b.id === 'night'))))
  await S.shot('phone-day')
  await page.locator('[aria-label="Night mode"]').first().click()
  await sleep(500)
  check('phone: night mode toggles from the header', await S.frame().evaluate(() => document.documentElement.classList.contains('abs-night')))
  await S.shot('phone-night')
  // the widget stays inline (live) in the flow on the phone
  await bk((vm, c) => vm.seekToTime(c), (await S.timeOf(1, fx.chapters[1].firstSpokenId, 1)) + 1)
  await page.waitForFunction(() => window.__vm().viewChapter === 1, null, { timeout: 30000 })
  await sleep(1500)
  check('phone: widget placeholder is inline in the chapter', (await bk((vm) => vm.doc.querySelectorAll('.abs-widget').length)) === 1)
  await S.browser.close()
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
