#!/usr/bin/env node
// Synthetic "synced EPUB" generator for the Book read-along mode tests.
//
//   node test/epub/make-fixture.mjs <outDir> [--basename "Synthetic Book"] [--big] [--no-audio]
//
// Writes into <outDir>:
//   <basename>.epub   EPUB3 with word spans, SMIL media overlays, an IDPF-obfuscated font, widgets
//   <basename>.mp3    quiet tone as long as the narration (needs ffmpeg; skipped with --no-audio)
//   fixture.json      chapter time ranges, word counts, unspoken ids (for test assertions)
//
// All text is invented. --big replaces chapter 2 with a 15,000 word chapter (performance tests).
import { createHash } from 'node:crypto'
import { deflateSync } from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeZip } from './zipwriter.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const opt = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d)
const outDir = args.find((a, i) => !a.startsWith('--') && (i === 0 || !['--basename'].includes(args[i - 1])))
if (!outDir) {
  console.error('usage: make-fixture.mjs <outDir> [--basename NAME] [--big] [--no-audio]')
  process.exit(2)
}
const basename = opt('--basename', 'Synthetic Book')
const BIG = flag('--big')
const WORD_SEC = 0.35
const PARA_GAP = 0.6

// ---- deterministic invented text ----
let seed = 12345
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
const VOCAB = 'amber lantern harbour whistle copper meadow thistle ferry orchard lamp pebble quiet river saddle timber velvet willow yonder cobble drizzle ember fennel gable hazel ivory juniper kettle linen mortar nettle oatmeal parlour quill russet satchel tallow umber vesper wicker yarrow zephyr bramble cinder dapple elder flint grove hollow inlet jetty knoll larch moss nook opal pasture quarry rook sorrel trellis upland vale wren'.split(' ')
const FUNC = 'the a and of to in on with by for from near under over beside through'.split(' ')
function sentence() {
  const n = 6 + Math.floor(rnd() * 8)
  const w = []
  for (let i = 0; i < n; i++) w.push(i % 3 === 1 ? FUNC[Math.floor(rnd() * FUNC.length)] : VOCAB[Math.floor(rnd() * VOCAB.length)])
  w[0] = w[0][0].toUpperCase() + w[0].slice(1)
  const punct = rnd() < 0.15 ? '!' : rnd() < 0.1 ? '?' : '.'
  w[w.length - 1] += punct
  if (n > 9) w[4] += ','
  return w
}
/** Returns paragraphs, each an array of word strings. */
function paragraphs(totalWords) {
  const paras = []
  let count = 0
  while (count < totalWords) {
    const p = []
    const target = 35 + Math.floor(rnd() * 25)
    while (p.length < target && count + p.length < totalWords) p.push(...sentence())
    const keep = Math.min(p.length, totalWords - count)
    paras.push(p.slice(0, keep))
    count += keep
  }
  return paras
}

const CHAPTERS = [
  { title: 'The Lamp at Gull Rock', words: 300, widget: false, popover: true },
  { title: 'A Ferry in the Drizzle', words: BIG ? 15000 : 600, widget: true, popover: false },
  { title: 'The Quiet Orchard', words: 200, widget: false, popover: false }
]

const ACTIVE_CLASS = '-epub-media-overlay-active'
const IDENTIFIER = 'urn:uuid:7c1d1f3e-5b0a-4d55-9a4e-0f3d2f6a9b11'

// ---- binary helpers ----
function png(w, h, rgb, flat = false) {
  const crcT = (() => {
    const t = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c >>> 0
    }
    return t
  })()
  const crc = (b) => {
    let c = 0xffffffff
    for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      // flat: a (nearly) solid colour so illustrations are told apart at a glance in screenshots
      raw[o] = flat ? Math.round(rgb[0] * (0.9 + 0.1 * (x / w))) : Math.round(rgb[0] * (0.4 + 0.6 * (x / w)))
      raw[o + 1] = flat ? Math.round(rgb[1] * (0.9 + 0.1 * (y / h))) : Math.round(rgb[1] * (0.4 + 0.6 * (y / h)))
      raw[o + 2] = rgb[2]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
function wav(seconds = 1, hz = 440, rate = 8000) {
  const n = seconds * rate
  const b = Buffer.alloc(44 + n)
  b.write('RIFF', 0)
  b.writeUInt32LE(36 + n, 4)
  b.write('WAVEfmt ', 8)
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate, 28)
  b.writeUInt16LE(1, 32)
  b.writeUInt16LE(8, 34)
  b.write('data', 36)
  b.writeUInt32LE(n, 40)
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(20 * Math.sin((2 * Math.PI * hz * i) / rate))
  return b
}
/** IDPF font obfuscation: XOR the first 1040 bytes with the SHA-1 of the whitespace-stripped identifier. */
function obfuscate(font, identifier) {
  const key = createHash('sha1').update(identifier.replace(/\s+/g, '')).digest()
  const out = Buffer.from(font)
  for (let i = 0; i < Math.min(1040, out.length); i++) out[i] ^= key[i % 20]
  return out
}

const pad = (n) => String(n).padStart(6, '0')
const fmt = (t) => t.toFixed(3) + 's'
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
const hms = (t) => {
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}:${(t % 60).toFixed(3).padStart(6, '0')}`
}

// ---- build chapters ----
let wid = 0
let clock = 1.0
const meta = []
const illustrations = []
const files = []
const manifest = []
const spine = []

CHAPTERS.forEach((ch, ci) => {
  const n = ci + 1
  const pars = []
  const unspoken = []
  let spoken = 0
  let total = 0
  let firstSpoken = null
  let lastSpoken = null
  let startSec = null
  let endSec = null
  const span = (word, italic) => {
    const id = 'w' + pad(++wid)
    total++
    const isUnspoken = total % 47 === 0
    let html = `<span id="${id}">${esc(word)}</span>`
    if (italic) html = `<em>${html}</em>`
    if (isUnspoken) {
      unspoken.push(id)
    } else {
      const b = clock
      clock += WORD_SEC
      if (startSec === null) startSec = b
      endSec = clock
      pars.push({ id, b, e: clock })
      spoken++
      firstSpoken = firstSpoken || id
      lastSpoken = id
    }
    return html
  }
  const body = []
  // Heading (spoken) then paragraphs
  body.push(`<h1 class="chead">${`Chapter ${['One', 'Two', 'Three'][ci]}`.split(' ').map((w) => span(w)).join(' ')}<br/>${ch.title.split(' ').map((w) => span(w)).join(' ')}</h1>`)
  clock += PARA_GAP
  const paras = paragraphs(ch.words)
  paras.forEach((p, pi) => {
    // extra widget slot + popover between paragraphs 1 and 2
    const lastWid = () => 'w' + pad(wid)
    const nextWid = () => 'w' + pad(wid + 1)
    // ch1 paragraph 2: a tiny inline ornament between words (a text glyph, not an illustration)
    const inner = p
      .map((w, wi) => span(w, wi % 17 === 5) + (n === 1 && pi === 2 && wi === 10 ? ' <img class="orn" width="14" height="14" src="assets/images/orn.png" alt=""/>' : ''))
      .join(' ')
    body.push(`<p class="${pi === 0 ? 'dropcap' : 'body'}">${inner}</p>`)
    clock += PARA_GAP
    if (pi === 0 && ch.widget) {
      illustrations.push({ id: 'W', chapter: n, kind: 'widget', path: 'OPS/assets/images/thumb.png', afterWordId: lastWid(), firstWordIdAfter: nextWid() })
      body.push(
        `<object id="framethumb-${n}" class="wobj" type="application/x-ibooks+widget" title="Frame" data-widget-type="html" data-geometry="affineGeometry(768,317,1,0,0,1,0,0)" data-fullscreen-only="yes" data-expanded-only="no" data-autoplay="yes" data-content-layout="top-bottom" data-stage-geometry="affineGeometry(400,300,1,0,0,1,0,0)" data-fullscreen-stage-geometry="affineGeometry(800,600,1,0,0,1,0,0)" data-starting-file="index.html" data-notifies-on-ready="yes" data-bundle-path="assets/widgets/W1.dummy.wdgt"><figure><a href="javascript:window.location='assets/widgets/W1.dummy.wdgt/index.html'" class="widget-link"><img class="thumb" width="400" height="300" src="assets/images/thumb.png" id="image-${n}" data-widget-object-type="stage-thumb" alt=""/></a></figure></object>`
      )
    }
    if (pi === 1 && ch.popover) {
      body.push(`<object id="viewport-popup-${n}" type="application/x-ibooks+widget" data-widget-type="viewport" class="pop" title="Pop-Over" data-viewport-size="{400, 120}"><div id="textShape-${n}"><p id="textShape-${n}-p0" class="pop-text">Glossary note about the invented word lantern keeper.</p></div></object>`)
    }
    if (n === 1 && pi === 1) {
      illustrations.push({ id: 'A', chapter: n, kind: 'img', path: 'OPS/assets/images/ill-a.png', afterWordId: lastWid(), firstWordIdAfter: nextWid() })
      body.push(`<p class="figure"><img class="illus" width="240" height="140" src="assets/images/ill-a.png" alt="A"/></p>`)
    }
    if (n === 1 && pi === 3) {
      illustrations.push({ id: 'B', chapter: n, kind: 'svg', path: 'OPS/assets/images/ill-b.png', afterWordId: lastWid(), firstWordIdAfter: nextWid() })
      body.push(`<div class="svgwrap"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" viewBox="0 0 300 200" width="300" height="200"><image width="300" height="200" xlink:href="assets/images/ill-b.png"/></svg></div>`)
    }
    if (n === 2 && pi === 4) {
      const after = lastWid()
      const imgHtml = `<img class="illus" width="260" height="160" src="assets/images/ill-c.png" alt="C"/>`
      const first = nextWid()
      const capIds = []
      const cap = ['Lanterns', 'glow', 'beside', 'the', 'quiet', 'harbour.'].map((w) => {
        const h = span(w)
        capIds.push('w' + pad(wid))
        return h
      })
      illustrations.push({ id: 'C', chapter: n, kind: 'figure', path: 'OPS/assets/images/ill-c.png', afterWordId: after, firstWordIdAfter: first, narratedCaption: capIds })
      body.push(`<figure class="fig">${imgHtml}<figcaption>${cap.join(' ')}</figcaption></figure>`)
      clock += PARA_GAP
    }
    if (n === 2 && pi === 8) {
      illustrations.push({ id: 'D', chapter: n, kind: 'img', path: 'OPS/assets/images/ill-d.png', afterWordId: lastWid(), firstWordIdAfter: nextWid() })
      body.push(`<p class="figure"><img class="illus" width="240" height="140" src="assets/images/ill-d.png" alt="D"/></p>`)
    }
  })
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>\n<html xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" xmlns="http://www.w3.org/1999/xhtml"><head><meta charset="utf-8"/><title>Untitled</title><link rel="stylesheet" type="text/css" href="assets/css/content${n}.css"/></head><body>${body.join('')}</body></html>`
  files.push({ name: `OPS/content${n}.xhtml`, data: xhtml })
  const smil = `<?xml version="1.0" encoding="UTF-8"?>\n<smil xmlns="http://www.w3.org/ns/SMIL" xmlns:epub="http://www.idpf.org/2007/ops" version="3.0"><body><seq id="seq${n}" epub:textref="../content${n}.xhtml">${pars
    .map((p, i) => `<par id="par${n}_${i}"><text src="../content${n}.xhtml#${p.id}"/><audio src="../audio/book.m4b" clipBegin="${fmt(p.b)}" clipEnd="${fmt(p.e)}"/></par>`)
    .join('')}</seq></body></smil>`
  files.push({ name: `OPS/smil/content${n}.smil`, data: smil })
  const css = `body{margin:0;padding:24px 32px;font-family:"SynthSans",serif;font-size:18px;line-height:28px;color:#222;background:#fbf7ee}
.chead{font-size:34px;line-height:42px;text-align:center;margin:20px 0 28px;color:#6a1b1b}
p.body,p.dropcap{margin:0 0 14px 0;text-align:justify;font-size:18px}
p.dropcap::first-letter{float:left;font-size:72px;line-height:60px;padding:4px 8px 0 0;color:#a05a00;font-weight:bold}
img.illus{display:block;margin:12px auto}
img.orn{display:inline;vertical-align:middle;margin:0 2px}
.svgwrap{text-align:center;margin:12px 0}
figure.fig{margin:12px auto;text-align:center}
figure.fig figcaption{font-size:15px;font-style:italic}
object.pop{display:block;border:1px solid #999;padding:6px;margin:10px 0}
.pop-text{font-size:15px;margin:0}
em{font-style:italic}
`
  files.push({ name: `OPS/assets/css/content${n}.css`, data: css })
  manifest.push(`<item id="ch${n}" href="content${n}.xhtml" media-type="application/xhtml+xml" media-overlay="smil${n}"/>`)
  manifest.push(`<item id="smil${n}" href="smil/content${n}.smil" media-type="application/smil+xml"/>`)
  manifest.push(`<item id="ss${n}" href="assets/css/content${n}.css" media-type="text/css"/>`)
  spine.push(`<itemref idref="ch${n}"/>`)
  meta.push({ index: n, file: `content${n}.xhtml`, smil: `smil/content${n}.smil`, title: ch.title, wordCount: total, spokenCount: spoken, unspokenIds: unspoken, startSec, endSec, firstSpokenId: firstSpoken, lastSpokenId: lastSpoken, hasWidget: !!ch.widget, hasPopover: !!ch.popover })
  clock += 1.0 // pause between chapters
})
const totalDuration = clock

// ---- opf ----
const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" prefix="ibooks: http://vocabulary.itunes.apple.com/rdf/ibooks/vocabulary-extensions-1.0/"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">${IDENTIFIER}</dc:identifier><dc:title>${basename}</dc:title><dc:language>en</dc:language><dc:creator>Fixture Author</dc:creator>
<meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
<meta property="media:active-class">${ACTIVE_CLASS}</meta>
<meta property="media:duration">${hms(totalDuration)}</meta>
${meta.map((m) => `<meta property="media:duration" refines="#smil${m.index}">${hms(m.endSec - m.startSec)}</meta>`).join('\n')}
<meta name="generator" content="synthetic fixture"/>
</metadata>
<manifest>
${manifest.join('\n')}
<item id="font1" href="assets/fonts/SynthSans.ttf" media-type="font/ttf"/>
<item id="img1" href="assets/images/thumb.png" media-type="image/png"/>
<item id="img-a" href="assets/images/ill-a.png" media-type="image/png"/>
<item id="img-b" href="assets/images/ill-b.png" media-type="image/png"/>
<item id="img-c" href="assets/images/ill-c.png" media-type="image/png"/>
<item id="img-d" href="assets/images/ill-d.png" media-type="image/png"/>
<item id="img-orn" href="assets/images/orn.png" media-type="image/png"/>
</manifest>
<spine>${spine.join('')}</spine>
</package>`

// ---- widget ----
const appleWidget = `// Mimics the Apple iBooks widget controller: notifications are page navigations to an unknown scheme.
var AppleWidgetController = function() {};
AppleWidgetController.prototype = {
  notifyContentLoaded : function() { window.location = 'apb:///do?c=loaded'; },
  notifyContentIsReady : function() { window.location = 'apb:///do?c=ready'; },
  notifyContentExited : function() { window.location = 'apb:///do?c=exited'; },
  pauseAudioVisual : function() {}
};
var widget = new AppleWidgetController();
`
const widgetIndex = `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>dummy</title><meta name="viewport" content="width=800, height=600"/>
<style>html,body{margin:0;width:800px;height:600px;overflow:hidden;background:#112}canvas{display:block}</style></head>
<body>
<canvas id="c" width="800" height="600"></canvas>
<audio id="a" src="sound.wav" autoplay loop></audio>
<script src="AppleClasses/AppleWidget.js"></script>
<script>
window.__frames = 0; window.__rangeResult = null; window.__ctxState = null; window.__audioOk = null;
var ctx = document.getElementById('c').getContext('2d');
function draw(){ window.__frames++; ctx.fillStyle='#112'; ctx.fillRect(0,0,800,600); ctx.fillStyle='#fc3'; ctx.font='64px sans-serif'; ctx.fillText('frame '+window.__frames, 40, 120); ctx.fillRect(40+(window.__frames*4)%700, 300, 60, 60); requestAnimationFrame(draw); }
requestAnimationFrame(draw);
widget.didEnterWidgetMode = function(){ window.__entered = (window.__entered||0)+1; };
try { var AC = window.AudioContext || window.webkitAudioContext; var ac = new AC(); var osc = ac.createOscillator(); osc.connect(ac.destination); osc.start(); window.__ac = ac; window.__ctxState = ac.state; } catch (e) { window.__ctxState = 'error:' + e.message; }
var a = document.getElementById('a'); var pr = a.play(); if (pr && pr.catch) pr.catch(function(e){ window.__audioErr = String(e); });
fetch('data.bin', { headers: { Range: 'bytes=1000-1999' } }).then(function(r){ return r.arrayBuffer().then(function(b){ window.__rangeResult = { status: r.status, len: b.byteLength, contentRange: r.headers.get('content-range') }; }); }).catch(function(e){ window.__rangeResult = { error: String(e) }; });
setTimeout(function(){ widget.notifyContentIsReady(); window.__readyCalled = true; }, 100);
</script></body></html>`
const rng = Buffer.alloc(3 * 1024 * 1024)
{
  let s = 99
  for (let i = 0; i < rng.length; i++) rng[i] = ((s = (s * 1103515245 + 12345) >>> 0) >>> 16) & 255
}

// ---- assemble ----
const fontSrc = readFileSync(path.resolve(here, '../../static/fonts/Source_Sans_Pro/SourceSansPro-Regular.ttf'))
const encryption = `<?xml version="1.0" encoding="UTF-8" standalone="no"?><c:encryption xmlns:c="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:e="http://www.w3.org/2001/04/xmlenc#"><e:EncryptedData><e:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/><e:CipherData><e:CipherReference URI="OPS/assets/fonts/SynthSans.ttf"/></e:CipherData></e:EncryptedData></c:encryption>`
const fontCss = `@font-face{font-family:"SynthSans";src:url(../fonts/SynthSans.ttf);font-weight:normal;font-style:normal}\n`
for (const f of files) if (f.name.endsWith('.css')) f.data = fontCss + f.data

const wdgt = 'OPS/assets/widgets/W1.dummy.wdgt/'
const entries = [
  { name: 'mimetype', data: 'application/epub+zip', method: 'store' },
  { name: 'META-INF/container.xml', data: `<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/ibooks.opf" media-type="application/oebps-package+xml"/></rootfiles></container>` },
  { name: 'META-INF/encryption.xml', data: encryption },
  { name: 'OPS/ibooks.opf', data: opf },
  ...files,
  { name: 'OPS/assets/fonts/SynthSans.ttf', data: obfuscate(fontSrc, IDENTIFIER), method: 'store' },
  { name: 'OPS/assets/images/thumb.png', data: png(400, 300, [200, 120, 60]), method: 'store' },
  { name: 'OPS/assets/images/ill-a.png', data: png(300, 200, [230, 60, 60], true), method: 'store' },
  { name: 'OPS/assets/images/ill-b.png', data: png(300, 200, [50, 200, 70], true), method: 'store' },
  { name: 'OPS/assets/images/ill-c.png', data: png(300, 200, [60, 90, 230], true), method: 'store' },
  { name: 'OPS/assets/images/ill-d.png', data: png(300, 200, [240, 220, 40], true), method: 'store' },
  { name: 'OPS/assets/images/orn.png', data: png(14, 14, [120, 40, 160], true), method: 'store' },
  { name: wdgt + 'index.html', data: widgetIndex },
  { name: wdgt + 'AppleClasses/AppleWidget.js', data: appleWidget },
  { name: wdgt + 'sound.wav', data: wav(1), method: 'store' },
  { name: wdgt + 'data.bin', data: rng, method: 'store' }
]
mkdirSync(outDir, { recursive: true })
writeFileSync(path.join(outDir, basename + '.epub'), makeZip(entries))

const duration = Math.ceil(totalDuration + 3)
let audio = null
if (!flag('--no-audio')) {
  const mp3 = path.join(outDir, basename + '.mp3')
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=220:duration=${duration}`, '-af', 'volume=0.04', '-ac', '1', '-ar', '22050', '-b:a', '16k', '-metadata', `title=${basename}`, '-metadata', 'artist=Fixture Author', mp3])
  audio = path.basename(mp3)
}
writeFileSync(
  path.join(outDir, 'fixture.json'),
  JSON.stringify({ basename, identifier: IDENTIFIER, activeClass: ACTIVE_CLASS, wordSeconds: WORD_SEC, audioDurationSec: duration, narrationEndSec: totalDuration, audio, epub: basename + '.epub', big: BIG, font: { family: 'SynthSans', path: 'OPS/assets/fonts/SynthSans.ttf', obfuscated: 'idpf', source: 'static/fonts/Source_Sans_Pro/SourceSansPro-Regular.ttf' }, widget: { bundle: 'OPS/assets/widgets/W1.dummy.wdgt', chapter: 2, dataBinBytes: rng.length, rangeProbe: 'bytes=1000-1999' }, illustrations, ornament: { chapter: 1, path: 'OPS/assets/images/orn.png' }, chapters: meta }, null, 1)
)
console.log(`wrote ${basename}.epub (${meta.map((m) => m.wordCount).join('/')} words, narration ${totalDuration.toFixed(1)}s) to ${outDir}`)
