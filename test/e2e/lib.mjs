// Playwright helpers for the app running against the local e2e stack (see stack.sh).
// Playwright is not a dependency of the repo: set PW_DIR to a directory with `npm i playwright` done in it.
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const STACK_DIR = process.env.STACK_DIR || '/tmp/abs-e2e'
const PW_DIR = process.env.PW_DIR
if (!PW_DIR) throw new Error('Set PW_DIR to a directory where `npm i playwright && npx playwright install chromium` was run')
const { chromium } = createRequire(path.join(PW_DIR, 'noop.js'))('playwright')

export const state = () => JSON.parse(readFileSync(path.join(STACK_DIR, 'state.json'), 'utf8'))
export const fixture = () => JSON.parse(readFileSync(path.join(STACK_DIR, 'fixture.json'), 'utf8'))
export const ABS_URL = process.env.ABS_URL || 'http://localhost:13378'
export const APP_URL = process.env.APP_URL || 'http://localhost:1337'

/**
 * Log in through the real connect/login screens and return { browser, page, ctx }.
 * @param {{tv?:boolean, width?:number, height?:number, touch?:boolean, args?:string[]}} [o] tv = flag the store as Android TV
 */
export async function open({ tv = true, width = 1280, height = 720, touch = false, args = [] } = {}) {
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', ...args] })
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: touch, isMobile: touch })
  const page = await ctx.newPage()
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('[console.error]', m.text().slice(0, 300))
  })
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)))
  await page.goto(APP_URL + '/connect', { waitUntil: 'load', timeout: 240000 })
  await page.waitForSelector('input[type=url]', { timeout: 60000 })
  await page.fill('input[type=url]', ABS_URL)
  await page.keyboard.press('Enter')
  await page.waitForSelector('input[type=password]', { timeout: 120000 })
  await page.fill('input[placeholder="Username"]', 'root')
  await page.fill('input[type=password]', 'rootpass')
  await page.keyboard.press('Enter')
  await page.waitForURL('**/bookshelf', { timeout: 120000 })
  if (tv) await page.evaluate(() => window.$nuxt.$store.commit('setIsAndroidTv', true))
  return { browser, ctx, page }
}

/** Navigate to a fixture item ('Synthetic Book' | 'Synthetic Both' | 'Vtt Only') and start streaming it. */
export async function openItem(page, name = 'Synthetic Book') {
  const id = state().items[name]
  if (!id) throw new Error('unknown fixture item ' + name)
  await page.evaluate((i) => window.$nuxt.$router.push('/item/' + i), id)
  await page.waitForURL('**/item/*')
  await page.locator('button', { hasText: /^\s*(play_arrow)?\s*Stream\s*$/ }).first().click({ timeout: 120000 })
  await page.waitForSelector('#playerContent', { timeout: 120000 })
  await page.waitForTimeout(1500)
  // expand the mini player to the fullscreen player
  await page.locator('#playerContent').click({ position: { x: 5, y: 5 } })
  return id
}

/**
 * Start playback of a fixture item, open the fullscreen player and press the transcript button.
 * `ready` is a selector that signals the viewer has rendered (default: the VTT viewer's block).
 */
export async function openTranscript(page, name = 'Synthetic Book', ready = '.tr-block') {
  await openItem(page, name)
  await page.waitForSelector('[aria-label="Transcript"]', { timeout: 120000 })
  await page.locator('[aria-label="Transcript"]').first().click()
  if (ready) await page.waitForSelector(ready, { timeout: 120000 })
  await page.waitForTimeout(500)
}
/** Alias used by the Book mode tests: same flow, waiting for the book renderer's iframe by default. */
export const openBook = (page, name = 'Synthetic Book', ready = '.bk-frame') => openTranscript(page, name, ready)

/** First Vue instance whose options satisfy `pred(options)`; returns a JSON-able projection from `fn(vm)`. */
export const vmEval = (page, pred, fn) =>
  page.evaluate(
    ([p, f]) => {
      const walk = (c) => [c, ...c.$children.flatMap(walk)]
      const vm = walk(window.$nuxt).find(new Function('vm', 'return (' + p + ')(vm.$options)'))
      return vm ? new Function('vm', 'return (' + f + ')(vm)')(vm) : null
    },
    [pred.toString(), fn.toString()]
  )

/**
 * Drives the Book reader's clock synthetically (no audio needed) from the start of book chapter `from` to the start of
 * chapter `to` plus a minute, ticking every `step` seconds like the 100 ms tick of the reader, and records every change of the
 * illustration pane: [[time, viewChapter, paneKey|null], ...]. Also counts how many <img>/<iframe> nodes were mounted in the pane (re-mounts on an unchanged selection show up here).
 * Needs window.__vm() to return the BookReader instance.
 */
export const simulatePlayback = (page, from, to, step = 0.1) =>
  page.evaluate(
    async ([from, to, step]) => {
      const vm = window.__vm()
      const smooth = vm.smooth
      vm.smooth = false
      if (vm.isPlaying) vm.$emit('toggle-play')
      await new Promise((r) => setTimeout(r, 300))
      const first = (await vm.book.timeline.smilFor(from)).firstStart
      const last = (await vm.book.timeline.smilFor(to)).firstStart
      window.__T = first - 2
      window.__origEstimate = vm.estimateTime
      vm.estimateTime = () => window.__T
      vm.seekToTime(first - 2)
      await new Promise((r) => setTimeout(r, 1500))
      let mounts = 0
      const pane = document.querySelector('.bk-pane')
      new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => (n.tagName === 'IFRAME' || n.tagName === 'IMG') && mounts++))).observe(pane, { childList: true, subtree: true })
      const seq = []
      let lastKey
      for (let t = first - 2; t < last + 60; t += step) {
        window.__T = t
        vm.tick()
        let spin = 0
        while (vm.relocating && spin++ < 300) await new Promise((r) => setTimeout(r, 10))
        if (spin) await new Promise((r) => setTimeout(r, 30))
        const k = vm.paneItem ? vm.paneItem.key : null
        if (k !== lastKey) {
          seq.push([+t.toFixed(1), vm.viewChapter, k])
          lastKey = k
        }
        if (!(Math.round(t * 10) % 2000)) await new Promise((r) => setTimeout(r, 0))
      }
      await new Promise((r) => setTimeout(r, 800))
      vm.estimateTime = window.__origEstimate
      vm.smooth = smooth
      return { seq, mounts }
    },
    [from, to, step]
  )

/** "c:i" keys must never go backwards, and once something is shown the pane never goes empty. */
export const paneFlips = (seq) => {
  const flips = []
  let prev = null
  for (const [t, ch, k] of seq) {
    if (prev !== null && (k === null || k.split(':').map(Number).reduce((a, b, i) => a + (i === 0 ? b * 1e4 : b), 0) < prev.split(':').map(Number).reduce((a, b, i) => a + (i === 0 ? b * 1e4 : b), 0))) flips.push([t, ch, k, 'after', prev])
    if (k !== null) prev = k
  }
  return flips
}
