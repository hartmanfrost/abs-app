// Smoke test of the e2e stack: login, stream the fixture items, open the existing VTT transcript viewer.
//   test/e2e/stack.sh up && node test/e2e/smoke.mjs [screenshotDir]
import { open, openTranscript, state } from './lib.mjs'
import { mkdirSync } from 'node:fs'
const shots = process.argv[2] || '/tmp/abs-e2e/shots'
mkdirSync(shots, { recursive: true })
const { browser, page } = await open({ tv: true })
console.log('items', JSON.stringify(state().items))
await openTranscript(page, 'Vtt Only')
console.log('vtt blocks', await page.locator('.tr-block').count())
await page.screenshot({ path: `${shots}/smoke-vtt-only.png` })
await browser.close()
