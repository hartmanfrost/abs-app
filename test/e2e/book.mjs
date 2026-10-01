// End-to-end test of the Book read-along mode against the local ABS stack and the synthetic synced EPUB.
//   test/e2e/stack.sh up && node test/e2e/book.mjs [screenshotDir]
// Exits non-zero when a check fails. Screenshots land in the given directory (default $STACK_DIR/shots).
import { open, openItem, fixture, state } from './lib.mjs'
import { mkdirSync } from 'node:fs'

const shots = process.argv[2] || '/tmp/abs-e2e/shots'
mkdirSync(shots, { recursive: true })
let failed = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failed++
}
const fx = fixture()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let { browser, page } = await open({ tv: true, width: 1280, height: 720 })
// Finds the BookReader / TranscriptView instance
const installFinder = () =>
  page.evaluate(() => {
    const walk = (c) => [c, ...c.$children.flatMap(walk)]
    window.__vm = (kind) => walk(window.$nuxt).find((c) => (kind === 'book' ? c.$options.methods && c.$options.methods.tapWidget : c.$options.computed && c.$options.computed.headerButtons && !(c.$options.methods && c.$options.methods.tapWidget)))
  })
await installFinder()
const bk = (fn, arg) => page.evaluate(([f, a]) => new Function('vm', 'a', 'return (' + f + ')(vm, a)')(window.__vm('book'), a), [fn.toString(), arg])
const press = async (k, n = 1) => {
  for (let i = 0; i < n; i++) await page.keyboard.press(k)
}
// Moves focus to a header button with the D-pad (Right enters the row; Left/Right walk it) and presses OK
const pressHeader = async (id, activate = true) => {
  await press('ArrowRight')
  await bk((vm) => { vm.headerIdx = 0 })
  const at = await bk((vm, id) => vm.headerButtons.findIndex((b) => b.id === id), id)
  await press('ArrowRight', at)
  if (activate) await press('Enter')
}
const shot = (name) => page.screenshot({ path: `${shots}/${name}.png` })
const frame = () => page.frames().find((f) => f !== page.mainFrame() && f.url() === 'about:srcdoc')
const waitReady = () => page.waitForFunction(() => window.__vm('book') && window.__vm('book').status === 'ready' && window.__vm('book').items.length > 0, null, { timeout: 120000 })

// ---------------------------------------------------------------- open + render
await openItem(page, 'Synthetic Book')
await page.waitForSelector('[aria-label="Transcript"]', { timeout: 120000 })
check('Transcript/Book button shows for an item with only a synced EPUB', true)
await page.locator('[aria-label="Transcript"]').first().click()
await page.waitForSelector('.bk-frame', { timeout: 60000 })
await waitReady()
await sleep(1200)
check('Book mode is the default view when a synced epub exists', (await page.locator('.tr-block').count()) === 0)
check('no mode switch button without a VTT', !(await bk((vm) => vm.headerButtons.some((b) => b.id === 'mode'))))
const f1 = frame()
check('chapter renders in an isolated iframe document', !!f1)
const info = await f1.evaluate(() => ({
  words: document.querySelectorAll('[id^=w]').length,
  scripts: document.scripts.length,
  fontOk: document.fonts.check('20px SynthSans'),
  loadedFaces: [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family),
  bodyFont: getComputedStyle(document.querySelector('.dropcap') || document.querySelector('p')).fontFamily
}))
check('word spans are present, scripts stripped', info.words > 200 && info.scripts === 0, JSON.stringify({ words: info.words, scripts: info.scripts }))
check('obfuscated book font is de-obfuscated and loaded', info.loadedFaces.some((n) => /SynthSans/.test(n)), JSON.stringify(info.loadedFaces))
await shot('book-01-open')

// ---------------------------------------------------------------- highlight follows the player clock
const ch = fx.chapters
const seekTo = (t) => bk((vm, t) => vm.seekToTime(t), t)
const playing = () => page.evaluate(() => window.$nuxt.$store.state.playerIsPlaying)
await seekTo(ch[0].startSec + 20)
await page.waitForTimeout(1500)
const hl = await f1.evaluate((cls) => [...document.getElementsByClassName(cls)].map((e) => e.id), fx.activeClass)
check('exactly one word carries the active class', hl.length === 1, JSON.stringify(hl))
const state1 = await bk((vm) => ({ id: vm.wordEl && vm.wordEl.id, par: vm.lastPar, t: vm.estimateTime(), start: vm.smil.starts[vm.lastPar], end: vm.smil.ends[vm.lastPar] }))
check('active word matches the SMIL par at the player time', state1.id && state1.start <= state1.t + 0.4 && state1.t < state1.end + 0.8, JSON.stringify(state1))
const paras = await f1.evaluate(() => document.querySelectorAll('.abs-para-on').length)
check('active paragraph carries the subtle marker (one element)', paras === 1)
const inView = await f1.evaluate((cls) => {
  const r = document.getElementsByClassName(cls)[0].getBoundingClientRect()
  return { top: r.top, vh: innerHeight }
}, fx.activeClass)
check('active word stays in the upper part of the view', inView.top >= 0 && inView.top < inView.vh * 0.45, JSON.stringify(inView))
await shot('book-02-highlight')

// unspoken words are never highlighted: record every id that ever receives the class while playing across them
await f1.evaluate((cls) => {
  window.__seen = new Set()
  new MutationObserver((ms) => ms.forEach((m) => m.target.classList && m.target.classList.contains(cls) && window.__seen.add(m.target.id))).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] })
}, fx.activeClass)
const un = ch[0].unspokenIds[0]
const unIdx = Number(un.slice(1))
await seekTo(ch[0].startSec + (unIdx - 3) * fx.wordSeconds - 0.2)
if (!(await playing())) await bk((vm) => { vm.$emit('toggle-play') })
await sleep(3500)
const seen = await f1.evaluate(() => [...window.__seen])
check('words played while crossing an unspoken word were highlighted', seen.length >= 3, seen.join(','))
check('an unspoken word is never highlighted', !seen.includes(un) && !seen.some((id) => ch.some((c) => c.unspokenIds.includes(id))))
const unspokenStyled = await f1.evaluate((id) => getComputedStyle(document.getElementById(id)).backgroundColor, un)
check('an unspoken word is rendered normally', /rgba\(0, 0, 0, 0\)|transparent/.test(unspokenStyled), unspokenStyled)

// ---------------------------------------------------------------- chapter switching
await seekTo(ch[0].endSec - 2)
await page.waitForFunction(() => window.__vm('book').viewChapter === 1, null, { timeout: 30000 })
await sleep(800)
const afterSwitch = await bk((vm) => ({ ch: vm.viewChapter, id: vm.wordEl && vm.wordEl.id, following: vm.following }))
check('chapter switches automatically when playback crosses into the next SMIL range', afterSwitch.ch === 1 && afterSwitch.following === true, JSON.stringify(afterSwitch))
const f2 = frame()
check('next chapter has its own document with its own CSS', (await f2.evaluate(() => document.title + '|' + document.querySelectorAll('style').length)).length > 0)
await seekTo(ch[0].startSec + 5)
await page.waitForFunction(() => window.__vm('book').viewChapter === 0, null, { timeout: 30000 })
check('seeking back switches to the previous chapter', true)
await seekTo(ch[2].startSec + 3)
await page.waitForFunction(() => window.__vm('book').viewChapter === 2, null, { timeout: 30000 })
check('seeking across two chapters lands in the right one', true)
await seekTo(ch[0].startSec + 30)
await page.waitForFunction(() => window.__vm('book').viewChapter === 0, null, { timeout: 30000 })

// ---------------------------------------------------------------- browsing (D-pad)
if (await playing()) await bk((vm) => { vm.$emit('toggle-play') })
await sleep(400)
await press('ArrowDown')
let b = await bk((vm) => ({ following: vm.following, sel: vm.selIdx, tag: vm.selEl && vm.selEl.tagName, zone: vm.zone }))
check('Down pauses auto-follow and selects a paragraph', b.following === false && b.sel >= 0 && b.tag, JSON.stringify(b))
await press('ArrowDown', 2)
const b2 = await bk((vm) => ({ sel: vm.selIdx, marks: vm.doc.querySelectorAll('.abs-sel').length, pill: vm.following }))
check('Down moves by paragraph and exactly one paragraph is marked', b2.sel === b.sel + 2 && b2.marks === 1, JSON.stringify(b2))
await shot('book-03-browse')
const target = await bk((vm) => {
  const el = vm.selEl
  const spans = [...el.querySelectorAll('[id^=w]')]
  const first = spans.find((s) => vm.smil.idParIndex(s.id) >= 0)
  return { firstSpoken: first && first.id, t: first ? vm.smil.starts[vm.smil.idParIndex(first.id)] : -1 }
})
await press('Enter')
await page.waitForTimeout(600)
const afterOk = await bk((vm) => ({ following: vm.following, anchor: vm.anchorT }))
check('OK seeks to the first spoken word of the focused paragraph and resumes following', afterOk.following === true && Math.abs(afterOk.anchor - target.t) < 1.5, JSON.stringify({ target, afterOk }))
// header navigation
await press('ArrowRight')
check('Right moves to the header row', (await bk((vm) => vm.zone)) === 'header')
await press('ArrowRight', 2)
await press('ArrowLeft')
await press('ArrowDown')
check('Down returns to the text', (await bk((vm) => vm.zone)) === 'list')

// ---------------------------------------------------------------- font scale
const s0 = await bk((vm) => vm.scale)
await pressHeader('larger')
const s1 = await bk((vm) => vm.scale)
check('font + enlarges the page (scale on top of the book CSS)', s1 > s0, `${s0.toFixed(2)} -> ${s1.toFixed(2)}`)
await press('ArrowDown')
await shot('book-04-large')
await bk((vm) => vm.changeFont(-1))

// ---------------------------------------------------------------- widgets
const wch = fx.widget.chapter - 1
await bk((vm, c) => vm.seekToTime(c), ch[wch].startSec + 2)
await page.waitForFunction((c) => window.__vm('book').viewChapter === c, wch, { timeout: 30000 })
await sleep(800)
await bk((vm) => {
  const i = vm.items.findIndex((it) => it.kind === 'widget')
  vm.following = false
  vm.select(i)
})
await sleep(2500)
const wf = page.frames().find((f) => /epub-vfs/.test(f.url()))
check('widget iframe goes live from the virtual file system once scrolled near', !!wf, wf ? wf.url() : '')
if (wf) {
  const st = await wf.evaluate(() => ({ frames: window.__frames || 0, ctx: window.__ctxState, ready: window.__readyCalled, range: window.__rangeResult, audioMuted: [...document.querySelectorAll('audio')].every((a) => a.muted === true), title: document.title }))
  await sleep(700)
  const st2 = await wf.evaluate(() => window.__frames || 0)
  check('widget canvas animation runs inline', st2 > st.frames, `${st.frames} -> ${st2}`)
  check('widget audio is muted inline', st.audioMuted)
  check('widget AudioContext is suspended inline', st.ctx !== 'running', String(st.ctx))
  check('widget host calls (apb:/// navigation) did not kill the frame', st2 > 0 && wf.url().includes('epub-vfs'))
  check('widget Range request answered with 206 slice', JSON.stringify(st.range || '').includes('206') || JSON.stringify(st.range || '').includes('1000'), JSON.stringify(st.range))
}
await shot('book-05-widget-inline')
const wasPlaying = await playing()
if (!wasPlaying) await bk((vm) => { vm.$emit('toggle-play') })
await sleep(600)
await press('Enter')
await page.waitForSelector('.bk-wfull iframe', { timeout: 10000 })
await sleep(2000)
check('OK on a widget opens it fullscreen', true)
check('audiobook is paused while the widget is open', !(await playing()))
const full = page.frames().find((f) => /epub-vfs/.test(f.url()) && f !== wf)
if (full) {
  const fs = await full.evaluate(() => ({ audio: [...document.querySelectorAll('audio')].map((a) => ({ muted: a.muted, paused: a.paused })), ctx: window.__ctxState }))
  check('widget audio is enabled in fullscreen', fs.audio.length > 0 && fs.audio.every((a) => a.muted === false), JSON.stringify(fs))
}
await shot('book-06-widget-full')
if (full) await full.evaluate(() => { window.__taps = 0; document.addEventListener('click', () => window.__taps++, true) })
const ptr0 = await bk((vm) => ({ ...vm.pointer }))
await press('ArrowRight', 3)
await press('Enter')
const ptr1 = await bk((vm) => ({ ...vm.pointer }))
check('D-pad arrows move the widget pointer', ptr1.x > ptr0.x, JSON.stringify([ptr0, ptr1]))
check('OK dispatches a tap into the widget', full ? (await full.evaluate(() => window.__taps)) >= 1 : false)
await press('Escape')
await page.waitForFunction(() => !document.querySelector('.bk-wfull'), null, { timeout: 5000 })
await sleep(800)
check('Back closes the widget and resumes the audiobook', await playing())
check('Back inside a widget did not close the reader', !!(await page.$('.bk-frame')))
await bk((vm) => vm.resumeFollow())

// ---------------------------------------------------------------- search over the whole book
await pressHeader('search')
const probeWord = await bk(async (vm) => {
  const idx = await vm.chapterIndex(2)
  return idx.text.split(' ')[60]
})
await page.keyboard.type(probeWord)
await page.keyboard.press('Enter')
await page.waitForFunction(() => window.__vm('book').matchCount > 0, null, { timeout: 30000 })
await sleep(1200)
const sr = await bk((vm) => ({ n: vm.matchCount, ch: vm.viewChapter, find: vm.findEl && vm.findEl.textContent, following: vm.following }))
check('search finds the word across the book and jumps to it', sr.n >= 1 && sr.find && sr.find.toLowerCase().includes(probeWord.replace(/[^a-z]/g, '').slice(0, 3)), JSON.stringify({ probeWord, ...sr }))
await shot('book-07-search')

// ---------------------------------------------------------------- mode switch + fallbacks
await browser.close()
;({ browser, page } = await open({ tv: true, width: 1280, height: 720 }))
await installFinder()
await openItem(page, 'Synthetic Both')
await page.waitForSelector('[aria-label="Transcript"]', { timeout: 60000 })
await page.locator('[aria-label="Transcript"]').first().click()
await page.waitForSelector('.bk-frame', { timeout: 60000 })
check('with both a synced EPUB and a VTT the Book view opens first', true)
await waitReady()
check('mode switch button is shown when both exist', await bk((vm) => vm.headerButtons.some((b) => b.id === 'mode')))
await pressHeader('mode')
await page.waitForSelector('.tr-block', { timeout: 30000 })
check('mode switch opens the transcript viewer (VTT fallback keeps working)', (await page.locator('.bk-frame').count()) === 0)
await shot('book-08-vtt-fallback')
await page.keyboard.press('ArrowRight')
const tmIdx = await page.evaluate(() => {
  const walk = (c) => [c, ...c.$children.flatMap(walk)]
  const vm = walk(window.$nuxt).find((c) => c.$options.computed && c.$options.computed.headerButtons && !(c.$options.methods && c.$options.methods.tapWidget))
  vm.headerIdx = 0
  return vm.headerButtons.findIndex((b) => b.id === 'mode')
})
check('transcript view has the mode switch too', tmIdx > 0)
await press('ArrowRight', tmIdx)
await press('Enter')
await page.waitForSelector('.bk-frame', { timeout: 30000 })
check('and switches back to the book', true)
await browser.close()
;({ browser, page } = await open({ tv: true, width: 1280, height: 720 }))
await installFinder()
await openItem(page, 'Vtt Only')
await page.waitForSelector('[aria-label="Transcript"]', { timeout: 60000 })
await page.locator('[aria-label="Transcript"]').first().click()
await page.waitForSelector('.tr-block', { timeout: 30000 })
check('item without an EPUB opens the transcript viewer exactly as before', (await page.locator('.bk-frame').count()) === 0)

await browser.close()
console.log(failed ? `\n${failed} check(s) FAILED` : '\nall checks passed')
process.exit(failed ? 1 : 0)
