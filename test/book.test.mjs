// Unit tests for the book reader plumbing that does not need a DOM: EPUB opening over Range reads,
// font de-obfuscation through the entry cache, the widget file system answers, EPUB selection, CSS helpers.
import test from 'node:test'
import assert from 'node:assert/strict'
import { makeZip } from './epub/zipwriter.mjs'
import { EpubBook, makeHttpRangeReader, mimeFor } from '../utils/epub/epubBook.js'
import { deobfuscate, ALG_IDPF } from '../utils/epub/epubPackage.js'
import { answer, mountBook, vfsUrl } from '../utils/epub/vfs.js'
import { pickEpub } from '../utils/epub/bookSource.js'
import { findDropcapRules, parseGeometry, isExternalUrl } from '../utils/epub/chapterRender.js'
import { WIDGET_SHIM_SOURCE } from '../utils/epub/widgetShim.js'

const UID = 'urn:uuid:11111111-2222-3333-4444-555555555555'
const FONT = new Uint8Array(3000).map((_, i) => (i * 7 + 3) & 255)

function opf() {
  return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
 <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:identifier id="uid"> ${UID} </dc:identifier><dc:title>Invented Tale</dc:title>
  <meta property="media:active-class">-epub-media-overlay-active</meta>
  <meta property="media:duration">0:00:20.000</meta>
 </metadata>
 <manifest>
  <item id="c1" href="c1.xhtml" media-type="application/xhtml+xml" media-overlay="s1"/>
  <item id="c2" href="c2.xhtml" media-type="application/xhtml+xml" media-overlay="s2"/>
  <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml"/>
  <item id="s1" href="smil/c1.smil" media-type="application/smil+xml"/>
  <item id="s2" href="smil/c2.smil" media-type="application/smil+xml"/>
 </manifest>
 <spine><itemref idref="nav"/><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`
}

const smil = (file, from, n) =>
  `<smil xmlns="http://www.w3.org/ns/SMIL"><body><seq>${Array.from({ length: n }, (_, i) => `<par id="p${i}"><text src="../${file}#w${String(from + i).padStart(6, '0')}"/><audio src="../audio/b.m4b" clipBegin="${(from + i) * 0.5}s" clipEnd="${(from + i) * 0.5 + 0.4}s"/></par>`).join('')}</seq></body></smil>`

function buildEpub({ synced = true, widgetVideo = 3000000 } = {}) {
  const key = deobfuscate(FONT, ALG_IDPF, UID) // XOR is symmetric: this obfuscates
  const video = new Uint8Array(widgetVideo).map((_, i) => i & 255)
  return makeZip([
    { name: 'mimetype', data: 'application/epub+zip', method: 'store' },
    { name: 'META-INF/container.xml', data: '<container><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>' },
    { name: 'META-INF/encryption.xml', data: '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><CipherData><CipherReference URI="OPS/fonts/f.ttf"/></CipherData></EncryptedData></encryption>' },
    { name: 'OPS/book.opf', data: synced ? opf() : opf().replace(/ media-overlay="s\d"/g, '') },
    { name: 'OPS/c1.xhtml', data: '<html><body><p><span id="w000000">One</span></p></body></html>' },
    { name: 'OPS/c2.xhtml', data: '<html><body><p><span id="w000010">Two</span></p></body></html>' },
    { name: 'OPS/smil/c1.smil', data: smil('c1.xhtml', 0, 10) },
    { name: 'OPS/smil/c2.smil', data: smil('c2.xhtml', 10, 10) },
    { name: 'OPS/fonts/f.ttf', data: key },
    { name: 'OPS/w/index.html', data: '<!doctype html><html><head><title>w</title></head><body>hi</body></html>' },
    { name: 'OPS/w/v.bin', data: video, method: 'store' }
  ])
}

function memReader(buf) {
  const calls = []
  return { calls, fn: async (s, e) => (calls.push([s, e]), new Uint8Array(buf.subarray(s, e + 1))) }
}

test('EpubBook: chapters come from media overlays, fonts are de-obfuscated, entries are cached', async () => {
  const buf = buildEpub()
  const r = memReader(buf)
  const book = await EpubBook.open({ readRange: r.fn, size: buf.length, key: 'it|1' })
  assert.equal(book.synced, true)
  assert.equal(book.chapters.length, 2)
  assert.deepEqual(book.chapters.map((c) => c.href), ['OPS/c1.xhtml', 'OPS/c2.xhtml'])
  assert.equal(book.activeClass, '-epub-media-overlay-active')
  const font = await book.bytes('OPS/fonts/f.ttf')
  assert.deepEqual(Array.from(font), Array.from(FONT))
  const before = r.calls.length
  await book.bytes('OPS/fonts/f.ttf')
  assert.equal(r.calls.length, before, 'second read is served from the cache')
  // timeline is wired to the SMILs
  assert.equal(await book.timeline.chapterAt(2.0, 0), 0)
  assert.equal(await book.timeline.chapterAt(7.0, 0), 1)
})

test('EpubBook: an EPUB without overlays is reported as not synced', async () => {
  const buf = buildEpub({ synced: false })
  const book = await EpubBook.open({ readRange: memReader(buf).fn, size: buf.length, key: 'it|2' })
  assert.equal(book.synced, false)
})

test('vfs.answer: unknown session, 404, shim injection, Range slices of a stored entry', async () => {
  const buf = buildEpub()
  const r = memReader(buf)
  const book = await EpubBook.open({ readRange: r.fn, size: buf.length, key: 'it|3' })
  const sid = mountBook(book)
  assert.equal((await answer({ sid: 'nope', path: 'x', search: '', range: '' })).notMine, true)
  assert.equal((await answer({ sid, path: 'OPS/missing.js', search: '', range: '' })).status, 404)

  const html = await answer({ sid, path: 'OPS/w/index.html', search: '?abs=muted', range: '' })
  assert.equal(html.status, 200)
  const text = new TextDecoder().decode(html.body)
  assert.ok(text.includes('__absShim'), 'shim injected')
  assert.ok(text.indexOf('__absShim') < text.indexOf('<title>'), 'shim comes first in <head>')

  const callsBefore = r.calls.reduce((a, [s, e]) => a + (e - s + 1), 0)
  const part = await answer({ sid, path: 'OPS/w/v.bin', search: '', range: 'bytes=1000-1999' })
  assert.equal(part.status, 206)
  assert.equal(part.headers['content-range'], 'bytes 1000-1999/3000000')
  assert.equal(part.body.byteLength, 1000)
  assert.equal(new Uint8Array(part.body)[0], 1000 & 255)
  const fetched = r.calls.reduce((a, [s, e]) => a + (e - s + 1), 0) - callsBefore
  assert.ok(fetched < 4000, `only the slice was fetched, got ${fetched} bytes`)

  const open = await answer({ sid, path: 'OPS/w/v.bin', search: '', range: 'bytes=2999990-' })
  assert.equal(open.status, 206)
  assert.equal(open.body.byteLength, 10)
  const suffix = await answer({ sid, path: 'OPS/w/v.bin', search: '', range: 'bytes=-5' })
  assert.equal(suffix.headers['content-range'], 'bytes 2999995-2999999/3000000')
  assert.equal((await answer({ sid, path: 'OPS/w/v.bin', search: '', range: 'bytes=3100000-' })).status, 416)
})

test('vfsUrl encodes every path segment', () => {
  assert.equal(vfsUrl('abc', 'OPS/a b/c#d.html', 'muted'), '/epub-vfs/abc/OPS/a%20b/c%23d.html?abs=muted')
})

test('widget shim stays plain ES5 text without template holes', () => {
  assert.ok(!WIDGET_SHIM_SOURCE.includes('${'))
  assert.ok(!WIDGET_SHIM_SOURCE.includes('=>'), 'no arrow functions (injected verbatim)')
  new Function(WIDGET_SHIM_SOURCE) // parses
})

test('makeHttpRangeReader validates the length and decodes base64 chunks', async () => {
  const data = new Uint8Array(5000).map((_, i) => i & 255)
  const seen = []
  const http = {
    async get(url, opts) {
      const m = /bytes=(\d+)-(\d+)/.exec(opts.headers.Range)
      seen.push([+m[1], +m[2], opts.responseType])
      return Buffer.from(data.subarray(+m[1], +m[2] + 1)).toString('base64')
    }
  }
  const read = makeHttpRangeReader(http, '/api/items/x/ebook/1', 2048)
  const out = await read(100, 4099)
  assert.equal(out.length, 4000)
  assert.equal(out[0], 100)
  assert.deepEqual(seen.map((s) => s[2]), ['blob', 'blob'])
  assert.deepEqual(seen.map((s) => [s[0], s[1]]), [[100, 2147], [2148, 4099]])
  const lying = { get: async () => Buffer.from(data).toString('base64') } // ignores Range
  await assert.rejects(() => makeHttpRangeReader(lying, '/x')(0, 99), /ignored Range/)
})

test('pickEpub prefers <basename>.epub, then the primary ebook, and builds a version signature', () => {
  const f = (ino, filename, fileType, size = 10, mtimeMs = 5) => ({ ino, fileType, metadata: { filename, ext: '.' + filename.split('.').pop(), size, mtimeMs } })
  const item = { media: { ebookFile: { ino: '3' } }, libraryFiles: [f('1', 'Tale.m4b', 'audio'), f('2', 'Tale.epub', 'ebook', 100, 7.9), f('3', 'Other.epub', 'ebook')] }
  assert.deepEqual(pickEpub(item), { ino: '2', size: 100, signature: '2:100:7', name: 'Tale.epub' })
  item.libraryFiles[1].metadata.filename = 'Different.epub'
  assert.equal(pickEpub(item).ino, '3', 'falls back to the primary ebook')
  assert.equal(pickEpub({ libraryFiles: [f('1', 'a.m4b', 'audio')] }), null)
  assert.equal(pickEpub(null), null)
})

test('CSS helpers: iBooks drop cap rules, stage geometry, external urls, mime types', () => {
  const css = '.x{color:red}\n.dropcap-parent, p.first{\n\t-ibooks-dropcap: 1 4 0;\t\n}\n.y{margin:0}'
  assert.deepEqual(findDropcapRules(css), [{ selectors: ['.dropcap-parent', 'p.first'], chars: 1, lines: 4, padding: 0 }])
  assert.deepEqual(parseGeometry('affineGeometry(1212,1080,1,0,0,1,0,0)'), { w: 1212, h: 1080 })
  assert.equal(parseGeometry('nope'), null)
  assert.ok(isExternalUrl('javascript:void(0)') && isExternalUrl('data:x') && isExternalUrl('#a') && !isExternalUrl('../a.png'))
  assert.equal(mimeFor('a/b.OTF'), 'font/otf')
  assert.equal(mimeFor('x.unknown'), 'application/octet-stream')
})
