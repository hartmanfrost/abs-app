// Performance probe for the book reader with a 15,000-word chapter, CPU throttled to approximate the TV (default 4x).
//   node test/e2e/book-perf.mjs <libraryItemId of the --big fixture> [cpuRate]
import { open } from './lib.mjs'
const ID = process.argv[2]
const RATE = Number(process.argv[3] || 4)
const { browser, page } = await open({ tv: true, width: 960, height: 540 })
const cdp = await page.context().newCDPSession(page)
await cdp.send('Emulation.setCPUThrottlingRate', { rate: RATE })
await page.evaluate((id) => window.$nuxt.$router.push('/item/' + id), ID)
await page.waitForURL('**/item/*')
await page.locator('button', { hasText: /^\s*(play_arrow)?\s*Stream\s*$/ }).first().click({ timeout: 120000 })
await page.waitForSelector('#playerContent', { timeout: 120000 })
await page.waitForTimeout(1500)
await page.locator('#playerContent').click({ position: { x: 5, y: 5 } })
await page.waitForSelector('[aria-label="Transcript"]', { timeout: 120000 })
await page.evaluate(() => {
  window.__long = []
  new PerformanceObserver((l) => l.getEntries().forEach((e) => window.__long.push(Math.round(e.duration)))).observe({ entryTypes: ['longtask'] })
  const walk = (c) => [c, ...c.$children.flatMap(walk)]
  window.__vm = () => walk(window.$nuxt).find((c) => c.$options.methods && c.$options.methods.tapWidget)
})
const t0 = Date.now()
await page.locator('[aria-label="Transcript"]').first().click()
await page.waitForSelector('.bk-frame')
await page.waitForFunction(() => window.__vm() && window.__vm().status === 'ready', null, { timeout: 120000 })
console.log(`open -> ready (chapter 1)          ${Date.now() - t0} ms`)
const big = await page.evaluate(async () => {
  const v = window.__vm()
  v.following = false
  const t = performance.now()
  await v.showChapter(1)
  const ms = performance.now() - t
  return { ms: Math.round(ms), words: v.doc.querySelectorAll('[id^=w]').length, nodes: v.doc.querySelectorAll('*').length, items: v.items.length, par: v.smil.n }
})
console.log(`15k-word chapter load + layout     ${big.ms} ms   words ${big.words}  DOM nodes ${big.nodes}  items ${big.items}  SMIL pars ${big.par}`)
// per-tick cost: move the highlight through 400 consecutive words
const tick = await page.evaluate(async () => {
  const v = window.__vm()
  v.following = true
  const smil = v.smil
  const start = Math.floor(smil.n / 2)
  const times = []
  for (let i = 0; i < 400; i++) {
    const par = start + i
    const t = performance.now()
    v.lastPar = par
    v.setActive(par)
    times.push(performance.now() - t)
    if (i % 5 === 0) await new Promise((r) => requestAnimationFrame(r))
  }
  times.sort((a, b) => a - b)
  return { avg: times.reduce((a, b) => a + b, 0) / times.length, p95: times[Math.floor(times.length * 0.95)], max: times[times.length - 1] }
})
console.log(`highlight move (2 spans + scroll)  avg ${tick.avg.toFixed(2)} ms  p95 ${tick.p95.toFixed(2)} ms  max ${tick.max.toFixed(2)} ms`)
const st = Date.now()
await page.evaluate(() => window.__vm().seekToTime(120 + 40))
await page.waitForTimeout(1500)
console.log('seek back into chapter 1 / switch  ok', await page.evaluate(() => window.__vm().viewChapter))
const search = await page.evaluate(async () => {
  const v = window.__vm()
  v.searchOpen = true
  v.query = 'zzzzqx'
  const t = performance.now()
  await v.runSearch()
  return { ms: Math.round(performance.now() - t), n: v.matchCount }
})
console.log(`search over 3 chapters (cold)      ${search.ms} ms  (${search.n} hits)`)
console.log('long tasks (ms):', JSON.stringify(await page.evaluate(() => window.__long)))
const mem = await page.evaluate(() => performance.memory && Math.round(performance.memory.usedJSHeapSize / 1048576))
console.log('JS heap MB', mem)
await browser.close()
