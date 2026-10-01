import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { makeZip } from './epub/zipwriter.mjs'
import { openZip, normalizeName } from '../utils/epub/zip.js'
import { sha1 } from '../utils/epub/sha1.js'
import { parseContainer, parseOpf, parseEncryption, deobfuscate, resolveZipPath, splitHref, ALG_IDPF, ALG_ADOBE } from '../utils/epub/epubPackage.js'
import { parseClock, parseSmil, findPar, nextParAfter, parForId } from '../utils/epub/smil.js'
import { BookTimeline } from '../utils/epub/timeline.js'

const source = (buf) => {
  const calls = []
  const fn = async (s, e) => {
    calls.push([s, e])
    return new Uint8Array(buf.subarray(s, e + 1))
  }
  return { fn, calls }
}

// ---------------------------------------------------------------- zip
test('zip: deflate, store, utf-8 names, comment', async () => {
  const big = 'lorem ipsum '.repeat(5000)
  const zip = makeZip(
    [
      { name: 'mimetype', data: 'application/epub+zip', method: 'store' },
      { name: 'OPS/a b.xhtml', data: big },
      { name: 'OPS/ünï.txt', data: 'héllo' },
      { name: 'empty.txt', data: '' }
    ],
    { comment: 'a comment that is here' }
  )
  const src = source(zip)
  const z = await openZip(src.fn, zip.length)
  assert.deepEqual(z.names(), ['mimetype', 'OPS/a b.xhtml', 'OPS/ünï.txt', 'empty.txt'])
  assert.equal(await z.readText('mimetype'), 'application/epub+zip')
  assert.equal(await z.readText('OPS/a b.xhtml'), big)
  assert.equal(await z.readText('OPS/ünï.txt'), 'héllo')
  assert.equal((await z.read('empty.txt')).length, 0)
  assert.ok(z.has('OPS/a%20b.xhtml'), 'percent-encoded lookup')
  assert.ok(z.has('/OPS/a b.xhtml'))
  await assert.rejects(() => z.read('nope'))
})

test('zip: zip64 structures', async () => {
  const zip = makeZip([{ name: 'x/one.txt', data: 'one one one' }, { name: 'two.bin', data: Buffer.alloc(3000, 7), method: 'store' }], { zip64: true })
  const z = await openZip(source(zip).fn, zip.length)
  assert.equal(z.entries.size, 2)
  assert.equal(await z.readText('x/one.txt'), 'one one one')
  assert.equal((await z.read('two.bin')).length, 3000)
})

test('zip: local extra field longer than the slack is still read', async () => {
  const zip = makeZip([{ name: 'a.txt', data: 'payload', localExtra: 900 }])
  const z = await openZip(source(zip).fn, zip.length)
  assert.equal(await z.readText('a.txt'), 'payload')
})

test('zip: range accounting on a padded archive', async () => {
  const video = Buffer.alloc(5 * 1024 * 1024)
  for (let i = 0; i < video.length; i++) video[i] = (i * 31 + (i >> 8)) & 255
  const zip = makeZip(
    [
      { name: 'small.txt', data: 'tiny' },
      { name: 'video.mp4', data: video, method: 'store' },
      { name: 'after.txt', data: 'after' }
    ],
    { prefixPad: 100 * 1024 * 1024 }
  )
  const src = source(zip)
  const z = await openZip(src.fn, zip.length)
  assert.ok(z.stats.bytesFetched < 70000, `open fetched ${z.stats.bytesFetched}`)
  assert.equal(z.stats.rangeRequests, 1, 'tail contains the central directory')
  const before = z.stats.bytesFetched
  const slice = await z.readSlice('video.mp4', 1_000_000, 1_000_999)
  assert.deepEqual(Buffer.from(slice), video.subarray(1_000_000, 1_001_000))
  assert.ok(z.stats.bytesFetched - before < 1000 + 1200, `slice fetched ${z.stats.bytesFetched - before}`)
  assert.equal(await z.readText('small.txt'), 'tiny')
  assert.equal(await z.readText('after.txt'), 'after')
  // a slice at the very start (inside the header read) and across the header read boundary
  const head = await z.readSlice('video.mp4', 0, 9)
  assert.deepEqual(Buffer.from(head), video.subarray(0, 10))
  const mid = await z.readSlice('video.mp4', 100, 2000)
  assert.deepEqual(Buffer.from(mid), video.subarray(100, 2001))
  // deflate slice falls back to a whole-entry read
  const d = await z.readSlice('small.txt', 1, 2)
  assert.equal(Buffer.from(d).toString(), 'in')
})

test('zip: central directory outside the tail window is fetched separately', async () => {
  const entries = []
  for (let i = 0; i < 3000; i++) entries.push({ name: `dir/some/long/path/name-number-${i}.txt`, data: 'x', method: 'store' })
  const zip = makeZip(entries)
  const z = await openZip(source(zip).fn, zip.length)
  assert.equal(z.entries.size, 3000)
  assert.equal(z.stats.rangeRequests, 2)
  assert.equal(await z.readText('dir/some/long/path/name-number-2999.txt'), 'x')
})

test('zip: not a zip', async () => {
  await assert.rejects(() => openZip(source(Buffer.alloc(100)).fn, 100))
})

test('normalizeName', () => {
  assert.equal(normalizeName('/a%20b/c.txt'), 'a b/c.txt')
  assert.equal(normalizeName('a\\b'), 'a/b')
  assert.equal(normalizeName('100%'), '100%')
})

// ---------------------------------------------------------------- sha1
test('sha1 known answers and parity with node:crypto', () => {
  const hex = (u) => Buffer.from(u).toString('hex')
  assert.equal(hex(sha1(new Uint8Array(0))), 'da39a3ee5e6b4b0d3255bfef95601890afd80709')
  assert.equal(hex(sha1(Buffer.from('abc'))), 'a9993e364706816aba3e25717850c26c9cd0d89d')
  assert.equal(hex(sha1(Buffer.from('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))), '84983e441c3bd26ebaae4aa1f95129e5e54670f1')
  for (const n of [1, 55, 56, 63, 64, 65, 119, 1000, 4097]) {
    const b = Buffer.alloc(n)
    for (let i = 0; i < n; i++) b[i] = (i * 7 + n) & 255
    assert.equal(hex(sha1(b)), createHash('sha1').update(b).digest('hex'), `len ${n}`)
  }
})

// ---------------------------------------------------------------- package
const CONTAINER = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path='OEBPS/pkg.opf' media-type="application/oebps-package+xml"/></rootfiles></container>`

const OPF = `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" xmlns:dc="http://purl.org/dc/elements/1.1/" version="3.0" unique-identifier="bookid">
<opf:metadata>
  <dc:title>Tom &amp; Jerry</dc:title>
  <dc:identifier id="other">urn:other</dc:identifier>
  <dc:identifier id="bookid">
     urn:uuid:12345678-1234-1234-1234-123456789abc
  </dc:identifier>
  <opf:meta property="media:active-class">-my-active</opf:meta>
  <opf:meta property="media:playback-active-class">-my-playing</opf:meta>
  <opf:meta property="media:duration">0:10:00.5</opf:meta>
  <opf:meta property="media:duration" refines="#smil1">0:05:00</opf:meta>
  <opf:meta property="media:duration" refines="#smil2">12.5s</opf:meta>
</opf:metadata>
<opf:manifest>
  <opf:item id="c1" href="text/ch%201.xhtml" media-type="application/xhtml+xml" media-overlay="smil1"/>
  <opf:item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml" media-overlay='smil2' properties="scripted svg"/>
  <opf:item id="c3" href="../nav.xhtml" media-type="application/xhtml+xml"/>
  <opf:item id="smil1" href="smil/c1.smil" media-type="application/smil+xml"/>
  <opf:item id="smil2" href="smil/c2.smil" media-type="application/smil+xml"/>
</opf:manifest>
<opf:spine><opf:itemref idref="c1"/><opf:itemref idref="c2" linear="no"/><opf:itemref idref="c3"/><opf:itemref idref="ghost"/></opf:spine>
</opf:package>`

test('container + OPF parsing', () => {
  assert.equal(parseContainer(CONTAINER), 'OEBPS/pkg.opf')
  assert.throws(() => parseContainer('<container/>'))
  const o = parseOpf(OPF, 'OEBPS/pkg.opf')
  assert.equal(o.uid, 'urn:uuid:12345678-1234-1234-1234-123456789abc')
  assert.equal(o.title, 'Tom & Jerry')
  assert.equal(o.activeClass, '-my-active')
  assert.equal(o.playbackActiveClass, '-my-playing')
  assert.equal(o.totalDuration, 600.5)
  assert.equal(o.durations.get('smil1'), 300)
  assert.equal(o.durations.get('smil2'), 12.5)
  assert.equal(o.manifest.get('c1').href, 'OEBPS/text/ch 1.xhtml')
  assert.equal(o.manifest.get('c3').href, 'nav.xhtml')
  assert.deepEqual(o.manifest.get('c2').properties, ['scripted', 'svg'])
  assert.equal(o.spine.length, 4)
  assert.equal(o.spine[1].linear, false)
  assert.equal(o.spine[3].item, null)
  assert.deepEqual(o.overlays.map((x) => [x.idref, x.smil.href]), [['c1', 'OEBPS/smil/c1.smil'], ['c2', 'OEBPS/smil/c2.smil']])
})

test('OPF without overlay metadata uses the default class', () => {
  const o = parseOpf('<package unique-identifier="u"><metadata><dc:identifier id="u">x</dc:identifier></metadata><manifest/><spine/></package>', 'a.opf')
  assert.equal(o.activeClass, '-epub-media-overlay-active')
  assert.equal(o.overlays.length, 0)
  assert.equal(o.uid, 'x')
})

test('encryption.xml parsing', () => {
  const xml = `<c:encryption xmlns:c="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:e="http://www.w3.org/2001/04/xmlenc#">
   <e:EncryptedData><e:EncryptionMethod Algorithm="${ALG_IDPF}"/><e:CipherData><e:CipherReference URI="OPS/fonts/My%20Font.otf"/></e:CipherData></e:EncryptedData>
   <EncryptedData><EncryptionMethod Algorithm='${ALG_ADOBE}'/><CipherData><CipherReference URI='OPS/fonts/b.ttf'/></CipherData></EncryptedData></c:encryption>`
  const m = parseEncryption(xml)
  assert.equal(m.get('OPS/fonts/My Font.otf'), ALG_IDPF)
  assert.equal(m.get('OPS/fonts/b.ttf'), ALG_ADOBE)
})

test('font de-obfuscation: IDPF known answer + round trip + Adobe', () => {
  const uid = ' urn:uuid:AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE\n'
  const font = Buffer.alloc(3000)
  font.write('OTTO')
  for (let i = 4; i < font.length; i++) font[i] = (i * 13) & 255
  // independent obfuscation using node:crypto
  const key = createHash('sha1').update('urn:uuid:AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE', 'utf8').digest()
  const obf = Buffer.from(font)
  for (let i = 0; i < 1040; i++) obf[i] ^= key[i % 20]
  assert.notEqual(Buffer.from(obf.subarray(0, 4)).toString(), 'OTTO')
  const back = deobfuscate(obf, ALG_IDPF, uid)
  assert.deepEqual(Buffer.from(back), font)
  assert.equal(obf[0] !== font[0], true, 'input not mutated into the original')
  // Adobe: key = uuid bytes
  const ak = Buffer.from('AAAAAAAABBBBCCCCDDDDEEEEEEEEEEEE', 'hex')
  const aobf = Buffer.from(font)
  for (let i = 0; i < 1024; i++) aobf[i] ^= ak[i % 16]
  assert.deepEqual(Buffer.from(deobfuscate(aobf, ALG_ADOBE, 'urn:uuid:AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE')), font)
  assert.equal(deobfuscate(font, 'http://example/unknown', uid), null)
  // short input
  assert.equal(deobfuscate(Buffer.alloc(10), ALG_IDPF, uid).length, 10)
})

test('path helpers', () => {
  assert.equal(resolveZipPath('OPS/ch/a.smil', '../text/b%20c.xhtml#w1'), 'OPS/text/b c.xhtml')
  assert.equal(resolveZipPath('OPS/a.opf', './x/./y.css?v=2'), 'OPS/x/y.css')
  assert.equal(resolveZipPath('OPS/a.opf', '/abs/z.png'), 'abs/z.png')
  assert.equal(resolveZipPath('', 'a/b'), 'a/b')
  assert.deepEqual(splitHref('a/b.xhtml?x=1#frag'), { path: 'a/b.xhtml', fragment: 'frag' })
  assert.deepEqual(splitHref('a.css'), { path: 'a.css', fragment: '' })
})

// ---------------------------------------------------------------- smil
test('parseClock table', () => {
  const cases = [
    ['1234.567s', 1234.567], ['12.5', 12.5], ['500ms', 0.5], ['1.5min', 90], ['0.25h', 900],
    ['01:02:03.5', 3723.5], ['02:03.25', 123.25], ['npt=3.5s', 3.5], [' 7s ', 7], ['.5s', 0.5], ['0', 0]
  ]
  for (const [s, v] of cases) assert.ok(Math.abs(parseClock(s) - v) < 1e-9, s)
  for (const bad of ['', 'abc', '1:2:3:4', null, undefined, '5x']) assert.ok(Number.isNaN(parseClock(bad)), String(bad))
})

const SMIL = `<?xml version="1.0"?><smil xmlns="http://www.w3.org/ns/SMIL" version="3.0"><body><seq id="s0">
<par id="p1"><text src="../text/ch1.xhtml#w000001"/><audio src="../audio/book.m4b" clipBegin="10.000s" clipEnd="10.400s"/></par>
<seq><par id='p2'><audio clipEnd='10.900s' clipBegin='10.500s' src='../audio/book.m4b'/><text src='../text/ch1.xhtml#w000002'/></par></seq>
<par id="bad1"><text src="../text/ch1.xhtml#w000003"/></par>
<par id="bad2"><audio src="x" clipBegin="1s" clipEnd="2s"/></par>
<par id="p3"><text src="../text/ch1.xhtml#w000004"/><audio src="x" clipBegin="11s"/></par>
<par id="p4"><text src="../text/ch1.xhtml#w000005"/><audio src="x" clipBegin="12s" clipEnd="12.5s"/></par>
<par id="empty"/>
</seq></body></smil>`

test('parseSmil handles attribute order, quotes, nesting, bad pars', () => {
  const s = parseSmil(SMIL, 'OEBPS/smil/c1.smil')
  assert.equal(s.file, 'OEBPS/text/ch1.xhtml')
  assert.equal(s.n, 4)
  assert.deepEqual(s.ids, ['w000001', 'w000002', 'w000004', 'w000005'])
  assert.deepEqual([...s.starts], [10, 10.5, 11, 12])
  assert.deepEqual([...s.ends], [10.4, 10.9, 12, 12.5]) // missing clipEnd = next start
  assert.equal(s.firstStart, 10)
  assert.equal(s.lastEnd, 12.5)
  assert.equal(s.order, null)
  assert.equal(parForId(s, 'w000004'), 2)
  assert.equal(parForId(s, 'w000003'), -1)
  assert.equal(s.idParIndex('w000005'), 3)
})

test('parseSmil last par without clipEnd gets +0.5s; empty input', () => {
  const s = parseSmil('<par><text src="a.xhtml#x"/><audio src="b" clipBegin="3s"/></par>', 'a.smil')
  assert.equal(s.ends[0], 3.5)
  const e = parseSmil('', 'a.smil')
  assert.equal(e.n, 0)
  assert.equal(findPar(e, 5), -1)
})

test('findPar: boundaries, gaps, before first, after last', () => {
  const s = parseSmil(SMIL, 'a/b.smil')
  assert.equal(findPar(s, 9.9), -1)
  assert.equal(findPar(s, 10), 0)
  assert.equal(findPar(s, 10.399), 0)
  assert.equal(findPar(s, 10.45), 0) // inside the 0.35 gap tolerance
  assert.equal(findPar(s, 10.5), 1)
  assert.equal(findPar(s, 10.95), 1)
  assert.equal(findPar(s, 11.0), 2)
  assert.equal(findPar(s, 12.6), 3)
  assert.equal(findPar(s, 12.9), -1)
  assert.equal(findPar(s, 12.6, 0), -1)
  assert.equal(nextParAfter(s, 9), 0)
  assert.equal(nextParAfter(s, 10), 1)
  assert.equal(nextParAfter(s, 12), -1)
})

test('findPar with non monotonic order', () => {
  const src = [5, 1, 3, 9, 7].map((t, i) => `<par><text src="c.xhtml#w${i}"/><audio src="x" clipBegin="${t}s" clipEnd="${t + 0.5}s"/></par>`).join('')
  const s = parseSmil(src, 'c.smil')
  assert.ok(s.order)
  assert.equal(findPar(s, 1.2), 1)
  assert.equal(findPar(s, 3.1), 2)
  assert.equal(findPar(s, 5.0), 0)
  assert.equal(findPar(s, 9.2), 3)
  assert.equal(nextParAfter(s, 5.2), 4)
  assert.equal(s.firstStart, 1)
  assert.equal(s.lastEnd, 9.5)
})

test('parseSmil large input stays fast', () => {
  let src = '<smil><body><seq>'
  for (let i = 0; i < 15000; i++) src += `<par id="par${i}"><text src="../content12.xhtml#w${String(i).padStart(6, '0')}"/><audio src="../audio/book.m4b" clipBegin="${(i * 0.3).toFixed(3)}s" clipEnd="${(i * 0.3 + 0.28).toFixed(3)}s"/></par>\n`
  src += '</seq></body></smil>'
  const t = performance.now()
  const s = parseSmil(src, 'OPS/smil/c12.smil')
  const ms = performance.now() - t
  console.log(`parseSmil 15000 pars, ${(src.length / 1e6).toFixed(2)} MB: ${ms.toFixed(0)} ms`)
  assert.equal(s.n, 15000)
  assert.equal(findPar(s, 1000.1), Math.floor(1000.1 / 0.3))
  assert.ok(ms < 1500)
})

// ---------------------------------------------------------------- timeline
function fakeBook(n, { fail = [], per = 100 } = {}) {
  const loads = []
  const chapters = Array.from({ length: n }, (_, i) => ({ index: i, href: `c${i}.xhtml`, smilHref: `c${i}.smil` }))
  const loadSmil = async (i) => {
    loads.push(i)
    if (fail.includes(i)) throw new Error('boom')
    // chapter i speaks words in [i*100, i*100+per*0.5) with a 5 s silence before the next chapter
    const base = i * 100
    const src = Array.from({ length: per }, (_, k) => `<par><text src="c${i}.xhtml#w${i}_${k}"/><audio src="x" clipBegin="${base + k * 0.5}s" clipEnd="${base + k * 0.5 + 0.4}s"/></par>`).join('')
    return parseSmil(src, `c${i}.smil`)
  }
  return { tl: new BookTimeline({ chapters, loadSmil }), loads }
}

test('timeline: chapterAt loads O(log n) SMILs', async () => {
  const { tl, loads } = fakeBook(20)
  assert.equal(await tl.chapterAt(1234), 12)
  assert.ok(loads.length <= 6, `loads ${loads.length}`)
  assert.equal(await tl.chapterAt(-5), 0)
  assert.equal(await tl.chapterAt(99999), 19)
  assert.equal(await tl.chapterAt(100), 1)
  assert.equal(await tl.chapterAt(99.99), 0)
  assert.ok(loads.length <= 12, `total loads ${loads.length}`)
  assert.ok(tl.peek(12) && tl.peek(12).firstStart === 1200)
})

test('timeline: resolve across a chapter boundary and seeking back', async () => {
  const { tl, loads } = fakeBook(20)
  let r = await tl.resolve(1249.6, 12) // inside chapter 12 (words until 1249.9)
  assert.equal(r.chapter, 12)
  assert.equal(r.par, 99)
  r = await tl.resolve(1255, 12) // silence after the last word: still chapter 12, no word
  assert.equal(r.chapter, 12)
  assert.equal(r.par, -1)
  r = await tl.resolve(1300.1, 12)
  assert.equal(r.chapter, 13)
  assert.equal(r.par, 0)
  r = await tl.resolve(10.2, 13) // seek far back
  assert.equal(r.chapter, 0)
  assert.equal(r.par, 20)
  // steady playback inside one chapter does not load anything new
  await tl.resolve(10.3, 0)
  const n = loads.length
  for (let t = 10.3; t < 20; t += 0.1) await tl.resolve(t, 0)
  assert.ok(loads.length <= n + 1, 'ticks reuse the loaded chapter')
})

test('timeline: failing chapters are skipped without throwing; LRU bound', async () => {
  const { tl } = fakeBook(10, { fail: [4, 5, 6] })
  assert.equal(await tl.chapterAt(450), 3)
  assert.equal(await tl.chapterAt(750), 7)
  const r = await tl.resolve(505, 3)
  assert.equal(r.chapter, 3)
  assert.equal(tl.peek(4), null)
  for (let i = 0; i < 10; i++) await tl.preload(i)
  assert.ok(tl.full.size <= 4)
  const all = fakeBook(3, { fail: [0, 1, 2] })
  const res = await all.tl.resolve(5, undefined)
  assert.equal(res.par, -1)
  assert.equal(res.smil, null)
})
