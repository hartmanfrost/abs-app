/*
 * Virtual file system for the book reader's iBooks widgets.
 *
 * Widgets are small web apps (HTML + JS + media) that build asset URLs at runtime, so they cannot be rewritten
 * into object URLs. They are loaded from /epub-vfs/<session>/<path-inside-the-epub> and this worker answers
 * those requests by asking the reader page (which owns the lazily-read EPUB archive and the auth header) for
 * the bytes. The worker itself keeps no state, so it may be stopped and restarted by the browser at any time.
 */
const PREFIX = '/epub-vfs/'
const ASK_TIMEOUT_MS = 30000

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return
  event.respondWith(serve(event.request, url))
})

function ask(client, message) {
  return new Promise((resolve) => {
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve(null), ASK_TIMEOUT_MS)
    channel.port1.onmessage = (e) => {
      clearTimeout(timer)
      resolve(e.data)
    }
    try {
      client.postMessage(message, [channel.port2])
    } catch (e) {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

async function serve(request, url) {
  const rest = url.pathname.slice(PREFIX.length)
  const slash = rest.indexOf('/')
  const sid = slash < 0 ? rest : rest.slice(0, slash)
  const path = slash < 0 ? '' : rest.slice(slash + 1)
  const windows = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((c) => c.frameType === 'top-level')
  const message = { type: 'epub-vfs-get', sid, path, search: url.search, range: request.headers.get('range') || '' }
  // Every reader page answers for its own sessions; the first real answer wins
  const answers = windows.map((c) => ask(c, message).then((r) => (r && !r.notMine ? r : Promise.reject(new Error('no')))))
  try {
    const r = await (Promise.any ? Promise.any(answers) : answers[0])
    return new Response(r.body, { status: r.status, headers: r.headers })
  } catch (e) {
    return new Response('EPUB session is not available', { status: 503, headers: { 'content-type': 'text/plain' } })
  }
}
