// Tiny static file server with SPA fallback and Range support, used by stack.sh to serve the nuxt `dist` build.
//   node serve.mjs <dir> [port]
import http from 'node:http'
import { createReadStream, statSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(process.argv[2] || 'dist')
const port = Number(process.argv[3] || 1337)
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.map': 'application/json' }

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    let file = path.join(root, decodeURIComponent(url.pathname))
    if (!file.startsWith(root)) return res.writeHead(403).end()
    let st
    try {
      st = statSync(file)
      if (st.isDirectory()) {
        file = path.join(file, 'index.html')
        st = statSync(file)
      }
    } catch {
      // SPA fallback: unknown paths (e.g. /connect, /item/<id>) are routes of the app
      if (path.extname(file)) return res.writeHead(404).end()
      file = path.join(root, 'index.html')
      try {
        st = statSync(file)
      } catch {
        return res.writeHead(404).end('no index.html')
      }
    }
    const headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' }
    const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '')
    if (m) {
      const start = m[1] === '' ? Math.max(0, st.size - Number(m[2])) : Number(m[1])
      const end = m[1] === '' || m[2] === '' ? st.size - 1 : Math.min(Number(m[2]), st.size - 1)
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 })
      return createReadStream(file, { start, end }).pipe(res)
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size })
    createReadStream(file).pipe(res)
  })
  .listen(port, () => console.log(`serving ${root} on http://localhost:${port}`))
