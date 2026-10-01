/**
 * Page side of the widget virtual file system (see static/epub-sw.js): registers the worker, keeps the open
 * book of each session and answers the worker's requests with archive bytes (Range aware), injecting the
 * widget shim into HTML pages.
 */
import { WIDGET_SHIM_SOURCE } from './widgetShim.js'
import { mimeFor } from './epubBook.js'

const SCOPE = '/epub-vfs/'
const sessions = new Map() // sid -> EpubBook
let ready = null
let listening = false

export function vfsSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && window.isSecureContext !== false
}

/** Registers the worker once; resolves true when widgets can be loaded, false when this WebView cannot do it. */
export function ensureVfs() {
  if (ready) return ready
  ready = (async () => {
    if (!vfsSupported()) return false
    try {
      if (!listening) {
        navigator.serviceWorker.addEventListener('message', onWorkerMessage)
        listening = true
      }
      const reg = await navigator.serviceWorker.register('/epub-sw.js', { scope: SCOPE })
      // `navigator.serviceWorker.ready` never resolves here: it waits for a worker whose scope covers the page itself
      await waitActive(reg)
      return true
    } catch (e) {
      console.warn('[book] widget worker unavailable', e && e.message)
      return false
    }
  })()
  return ready
}

function waitActive(reg) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('sw timeout')), 8000)
    const watch = (w) => {
      if (!w) return false
      if (w.state === 'activated') {
        clearTimeout(timer)
        resolve()
        return true
      }
      w.addEventListener('statechange', () => {
        if (w.state === 'activated') {
          clearTimeout(timer)
          resolve()
        } else if (w.state === 'redundant') {
          clearTimeout(timer)
          reject(new Error('sw redundant'))
        }
      })
      return false
    }
    if (watch(reg.active)) return
    watch(reg.installing || reg.waiting)
  })
}

export function mountBook(book) {
  const sid = Math.random().toString(36).slice(2, 10)
  sessions.set(sid, book)
  return sid
}

export function unmountBook(sid) {
  sessions.delete(sid)
}

/** URL of a file inside the EPUB as served to frames. mode: 'muted' | 'live' */
export function vfsUrl(sid, zipPath, mode) {
  return SCOPE + sid + '/' + zipPath.split('/').map(encodeURIComponent).join('/') + (mode ? '?abs=' + mode : '')
}

function injectShim(html) {
  const tag = '<script>' + WIDGET_SHIM_SOURCE + '</script>'
  const m = /<head[^>]*>/i.exec(html)
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length)
  const h = /<html[^>]*>/i.exec(html)
  if (h) return html.slice(0, h.index + h[0].length) + tag + html.slice(h.index + h[0].length)
  return tag + html
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/i.exec((header || '').trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start
  let end
  if (m[1] === '') {
    const n = parseInt(m[2], 10)
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = parseInt(m[1], 10)
    end = m[2] === '' ? size - 1 : Math.min(size - 1, parseInt(m[2], 10))
  }
  if (!(start <= end) || start >= size) return { invalid: true }
  return { start, end }
}

export async function answer({ sid, path, search, range }) {
  const book = sessions.get(sid)
  if (!book) return { notMine: true }
  let name
  try {
    name = decodeURIComponent(path)
  } catch (e) {
    name = path
  }
  if (!book.has(name)) return { status: 404, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode('Not found').buffer }
  try {
    const type = mimeFor(name)
    if (/\.html?$/i.test(name)) {
      const html = injectShim(await book.text(name))
      const body = new TextEncoder().encode(html)
      return { status: 200, headers: { 'content-type': type, 'cache-control': 'no-store' }, body: body.buffer }
    }
    const size = book.entrySize(name)
    const r = parseRange(range, size)
    const base = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-store' }
    if (r && r.invalid) return { status: 416, headers: { ...base, 'content-range': `bytes */${size}` }, body: new ArrayBuffer(0) }
    if (r) {
      const bytes = await book.slice(name, r.start, r.end)
      const copy = bytes.slice().buffer
      return { status: 206, headers: { ...base, 'content-range': `bytes ${r.start}-${r.end}/${size}`, 'content-length': String(copy.byteLength) }, body: copy }
    }
    const bytes = await book.bytes(name)
    const copy = bytes.slice().buffer
    return { status: 200, headers: { ...base, 'content-length': String(copy.byteLength) }, body: copy }
  } catch (e) {
    return { status: 500, headers: { 'content-type': 'text/plain' }, body: new TextEncoder().encode(String((e && e.message) || e)).buffer }
  }
}

function onWorkerMessage(event) {
  const d = event.data
  if (!d || d.type !== 'epub-vfs-get' || !event.ports || !event.ports[0]) return
  const port = event.ports[0]
  answer(d).then((r) => {
    if (r.body) port.postMessage(r, [r.body])
    else port.postMessage(r)
  })
}
