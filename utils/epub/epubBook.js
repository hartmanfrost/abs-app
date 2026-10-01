/**
 * Lazy EPUB access over HTTP Range requests.
 *
 * The synced EPUBs are 80-220 MB (videos inside the iBooks widgets) so the archive is never downloaded as a
 * whole: only the zip central directory, the OPF/SMIL files and the entries of the chapter being read are
 * fetched, and decoded entries land in a bounded in-memory LRU plus (best effort) the Cache Storage API.
 */
import { openZip, normalizeName } from './zip.js'
import { parseContainer, parseOpf, parseEncryption, deobfuscate, resolveZipPath } from './epubPackage.js'
import { parseSmil } from './smil.js'
import { BookTimeline } from './timeline.js'

const RANGE_CHUNK = 2 * 1024 * 1024
const MEMORY_BUDGET = 40 * 1024 * 1024
const PERSIST_MAX_ENTRY = 6 * 1024 * 1024
const PERSIST_MAX_KEYS = 600
const DIRECT_SLICE_MIN = 1024 * 1024
const CACHE_NAME = 'abs-epub-v1'

export const MIME = {
  xhtml: 'application/xhtml+xml',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  plist: 'application/xml',
  smil: 'application/smil+xml'
}

export function mimeFor(path) {
  const m = /\.([a-z0-9]+)$/i.exec(path || '')
  return (m && MIME[m[1].toLowerCase()]) || 'application/octet-stream'
}

function base64ToBytes(b64) {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (typeof Blob !== 'undefined' && data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  if (typeof data === 'string') return base64ToBytes(data)
  throw new Error('Unsupported range response type')
}

/**
 * Range reader on top of the app's $nativeHttp (CapacitorHttp: no CORS, adds the bearer token and
 * refreshes it). Responses are validated by length so a server that ignores Range cannot make us
 * swallow the whole file.
 * @returns {(start:number, endInclusive:number)=>Promise<Uint8Array>}
 */
export function makeHttpRangeReader(http, url, chunk = RANGE_CHUNK) {
  return async function readRange(start, endInclusive) {
    const total = endInclusive - start + 1
    const out = new Uint8Array(total)
    let pos = 0
    while (pos < total) {
      const n = Math.min(chunk, total - pos)
      const a = start + pos
      const b = a + n - 1
      const data = await http.get(url, { headers: { Range: `bytes=${a}-${b}` }, responseType: 'blob' })
      const bytes = await toBytes(data)
      if (bytes.length !== n) throw new Error(`Range ${a}-${b} returned ${bytes.length} bytes (server ignored Range?)`)
      out.set(bytes, pos)
      pos += n
    }
    return out
  }
}

/** Bounded byte cache (LRU by insertion order). */
class ByteLru {
  constructor(budget) {
    this.budget = budget
    this.size = 0
    this.map = new Map()
  }
  get(key) {
    const v = this.map.get(key)
    if (v) {
      this.map.delete(key)
      this.map.set(key, v)
    }
    return v
  }
  set(key, bytes) {
    if (bytes.length > this.budget / 2) return
    const old = this.map.get(key)
    if (old) this.size -= old.length
    this.map.delete(key)
    this.map.set(key, bytes)
    this.size += bytes.length
    while (this.size > this.budget && this.map.size > 1) {
      const k = this.map.keys().next().value
      this.size -= this.map.get(k).length
      this.map.delete(k)
    }
  }
}

function persistentCacheAvailable() {
  try {
    return typeof caches !== 'undefined' && !!caches.open
  } catch (e) {
    return false
  }
}

export class EpubBook {
  /**
   * @param {object} o
   * @param {(s:number,e:number)=>Promise<Uint8Array>} o.readRange
   * @param {number} o.size archive size in bytes
   * @param {string} o.key cache key: item id + file signature
   */
  static async open({ readRange, size, key }) {
    const zip = await openZip(readRange, size)
    const book = new EpubBook(zip, key)
    await book._init()
    return book
  }

  constructor(zip, key) {
    this.zip = zip
    this.key = key || ''
    this.lru = new ByteLru(MEMORY_BUDGET)
    this.blobUrls = new Map()
    this.opf = null
    this.opfPath = ''
    this.encryption = new Map()
    this.chapters = []
    this.timeline = null
    this.activeClass = '-epub-media-overlay-active'
    this.disposed = false
    this._persist = null
    this._textCache = new Map()
  }

  async _init() {
    const container = await this.zip.readText('META-INF/container.xml')
    this.opfPath = parseContainer(container)
    if (!this.opfPath) throw new Error('EPUB has no rootfile')
    this.opf = parseOpf(await this.zip.readText(this.opfPath), this.opfPath)
    if (this.zip.has('META-INF/encryption.xml')) {
      try {
        this.encryption = parseEncryption(await this.zip.readText('META-INF/encryption.xml'))
      } catch (e) {
        this.encryption = new Map()
      }
    }
    this.activeClass = this.opf.activeClass || '-epub-media-overlay-active'
    // Chapters = spine items with a media overlay; everything else cannot be followed
    const chapters = []
    for (const o of this.opf.overlays || []) {
      const item = o.item || o.chapter || o
      const smilItem = o.smil || o.smilItem
      if (!item || !smilItem) continue
      chapters.push({ index: chapters.length, id: item.id, href: item.href, smilHref: smilItem.href, title: item.title || '' })
    }
    this.chapters = chapters
    this.timeline = new BookTimeline({ chapters, loadSmil: (i) => this.loadSmil(i) })
  }

  get synced() {
    return this.chapters.length > 0
  }

  get title() {
    return (this.opf && this.opf.title) || ''
  }

  async loadSmil(i) {
    const ch = this.chapters[i]
    if (!ch) return null
    return parseSmil(await this.text(ch.smilHref), ch.smilHref)
  }

  async _cache() {
    if (this._persist !== null) return this._persist
    this._persist = false
    if (!persistentCacheAvailable()) return false
    try {
      this._persist = await caches.open(CACHE_NAME)
    } catch (e) {
      this._persist = false
    }
    return this._persist
  }

  _cacheUrl(path) {
    return 'https://epub.invalid/' + encodeURIComponent(this.key) + '/' + path.split('/').map(encodeURIComponent).join('/')
  }

  /** Drop cached entries of older versions of the same item (key = itemId|signature). */
  async prunePersistent() {
    const cache = await this._cache()
    if (!cache) return
    try {
      const keys = await cache.keys()
      const prefix = 'https://epub.invalid/' + encodeURIComponent(this.key) + '/'
      const itemPrefix = 'https://epub.invalid/' + encodeURIComponent(this.key.split('|')[0]) + '%7C'
      let kept = 0
      for (let i = keys.length - 1; i >= 0; i--) {
        const u = keys[i].url
        const stale = u.startsWith(itemPrefix) && !u.startsWith(prefix)
        if (stale || ++kept > PERSIST_MAX_KEYS) await cache.delete(keys[i])
      }
    } catch (e) {
      // best effort
    }
  }

  /** Decoded (inflated, de-obfuscated) bytes of an archive entry. */
  async bytes(path) {
    const name = normalizeName(path)
    const hit = this.lru.get(name)
    if (hit) return hit
    const entry = this.zip.entry(name)
    if (!entry) throw new Error('Not in EPUB: ' + path)
    const cache = entry.size <= PERSIST_MAX_ENTRY ? await this._cache() : false
    if (cache) {
      try {
        const res = await cache.match(this._cacheUrl(name))
        if (res) {
          const b = new Uint8Array(await res.arrayBuffer())
          this.lru.set(name, b)
          return b
        }
      } catch (e) {
        // fall through to the network
      }
    }
    let bytes = await this.zip.read(name)
    const alg = this.encryption.get(name)
    if (alg) {
      const clear = deobfuscate(bytes, alg, this.opf.uid)
      if (clear) bytes = clear
    }
    this.lru.set(name, bytes)
    if (cache) {
      try {
        await cache.put(this._cacheUrl(name), new Response(bytes))
      } catch (e) {
        // quota exceeded etc.: the memory cache still works
      }
    }
    return bytes
  }

  async text(path) {
    const name = normalizeName(path)
    const hit = this._textCache.get(name)
    if (hit !== undefined) return hit
    const t = new TextDecoder('utf-8').decode(await this.bytes(name))
    if (t.length < 400000) {
      this._textCache.set(name, t)
      if (this._textCache.size > 6) this._textCache.delete(this._textCache.keys().next().value)
    }
    return t
  }

  has(path) {
    return this.zip.has(normalizeName(path))
  }

  resolve(base, href) {
    return resolveZipPath(base, href)
  }

  /** Object URL for an archive entry (shared by all chapters, revoked on dispose). */
  async blobUrl(path) {
    const name = normalizeName(path)
    let p = this.blobUrls.get(name)
    if (!p) {
      p = this.bytes(name).then((b) => URL.createObjectURL(new Blob([b], { type: mimeFor(name) })))
      this.blobUrls.set(name, p)
      p.catch(() => this.blobUrls.delete(name))
    }
    return p
  }

  /** Slice of an entry for HTTP Range responses (widget media): STORED entries are range-read directly. */
  async slice(path, start, endInclusive) {
    const name = normalizeName(path)
    const entry = this.zip.entry(name)
    if (!entry) throw new Error('Not in EPUB: ' + path)
    const alg = this.encryption.get(name)
    // Big STORED media is range-read straight from the server; compressed entries must be inflated whole (then cached)
    if (!alg && entry.method === 0 && entry.size > DIRECT_SLICE_MIN) return this.zip.readSlice(name, start, endInclusive)
    const all = await this.bytes(name)
    return all.subarray(start, endInclusive + 1)
  }

  entrySize(path) {
    const e = this.zip.entry(normalizeName(path))
    return e ? e.size : -1
  }

  dispose() {
    this.disposed = true
    for (const p of this.blobUrls.values()) p.then((u) => URL.revokeObjectURL(u)).catch(() => {})
    this.blobUrls.clear()
    this.lru = new ByteLru(MEMORY_BUDGET)
    this._textCache.clear()
  }
}

// ---- opening with a one-slot cache so the availability probe and the reader share one archive ----
let current = null // { key, promise }

/**
 * @param {{ request: Function }} http $nativeHttp
 * @param {string} itemId
 * @param {{ino:string,size:number,signature:string}} file
 */
export function openBookFor(http, itemId, file) {
  const key = `${itemId}|${file.signature}`
  if (current && current.key === key) return current.promise
  if (current) current.promise.then((b) => b.dispose()).catch(() => {})
  const url = `/api/items/${itemId}/ebook/${encodeURIComponent(file.ino)}`
  const promise = EpubBook.open({ readRange: makeHttpRangeReader(http, url), size: file.size, key })
  current = { key, promise }
  promise.then((b) => b.prunePersistent()).catch(() => {
    if (current && current.key === key) current = null
  })
  return promise
}

export function closeBook() {
  if (current) current.promise.then((b) => b.dispose()).catch(() => {})
  current = null
}
