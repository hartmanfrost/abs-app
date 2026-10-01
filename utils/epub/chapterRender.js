/**
 * Turns a chapter XHTML of the EPUB into a self-contained HTML document for an isolated <iframe srcdoc>:
 * the book's own CSS and fonts are kept (rewritten to object URLs), scripts and links are removed, iBooks widgets
 * become placeholders that the reader brings to life, and the reader's highlight styles are appended last.
 */

const XHTML_NS = 'http://www.w3.org/1999/xhtml'
const URL_RE = /url\(\s*(['"]?)([^)'"]+?)\1\s*\)/gi
const IMPORT_RE = /@import\s+(?:url\(\s*)?(['"])([^'"]+)\1\s*\)?[^;]*;/gi
const DROPCAP_RE = /([^{}]+)\{[^{}]*?-ibooks-dropcap\s*:\s*(\d+)\s+(\d+)\s+(-?[\d.]+)/gi

export function isExternalUrl(u) {
  return /^(data:|blob:|https?:|javascript:|ibooks:|apb:|mailto:|#|\/\/)/i.test(u)
}

/** "affineGeometry(1212,1080,1,0,0,1,0,0)" -> { w, h } */
export function parseGeometry(value) {
  const m = /affineGeometry\(\s*([\d.]+)\s*,\s*([\d.]+)/i.exec(value || '')
  return m ? { w: parseFloat(m[1]), h: parseFloat(m[2]) } : null
}

/**
 * Rewrites url(...) / @import of a stylesheet to object URLs of the archive entries (resolved first so the
 * replace callback can stay synchronous). Returns { css }.
 */
export async function rewriteCssResolved(css, baseZipPath, book) {
  const pending = []
  const map = new Map()
  const collect = (ref) => {
    ref = ref.trim()
    if (isExternalUrl(ref)) return
    const path = book.resolve(baseZipPath, ref)
    if (map.has(path)) return
    map.set(path, null)
    if (book.has(path)) {
      pending.push(
        book
          .blobUrl(path)
          .then((u) => map.set(path, u))
          .catch(() => {})
      )
    }
  }
  for (const m of css.matchAll(URL_RE)) collect(m[2])
  let imported = ''
  for (const m of css.matchAll(IMPORT_RE)) {
    if (isExternalUrl(m[2])) continue
    const p = book.resolve(baseZipPath, m[2])
    if (book.has(p)) {
      try {
        imported += (await rewriteCssResolved(await book.text(p), p, book)).css + '\n'
      } catch (e) {
        // ignore a broken import
      }
    }
  }
  await Promise.all(pending)
  const out = css.replace(IMPORT_RE, '').replace(URL_RE, (all, q, ref) => {
    ref = ref.trim()
    if (isExternalUrl(ref)) return all
    const u = map.get(book.resolve(baseZipPath, ref))
    return u ? `url("${u}")` : all
  })
  return { css: imported + out }
}

/** Selectors that carry an `-ibooks-dropcap: <chars> <lines> <padding>` declaration. */
export function findDropcapRules(css) {
  const rules = []
  for (const m of css.matchAll(DROPCAP_RE)) {
    const selectors = m[1]
      .split(',')
      .map((s) => s.trim().replace(/^.*\}/s, '').trim())
      .filter((s) => s && !/[@:]/.test(s))
    if (selectors.length) rules.push({ selectors, chars: parseInt(m[2], 10), lines: parseInt(m[3], 10), padding: parseFloat(m[4]) })
  }
  return rules
}

export function readerCss(activeClass) {
  const act = `[class~="${activeClass}"]`
  return `
html{background:#fcfbf7;-webkit-text-size-adjust:none;text-size-adjust:none}
body{margin:0 auto;max-width:46em;padding:1.2em 1.4em 0;box-sizing:border-box;color:#000;overflow-wrap:break-word}
body::after{content:"";display:block;height:70vh}
img{max-width:100%;height:auto}
a{color:inherit;text-decoration:none;pointer-events:none}
span${act}{background:rgba(255,190,0,.42);box-shadow:0 0 0 .09em rgba(255,190,0,.42);border-radius:.14em}
.abs-para-on{box-shadow:-.5em 0 0 -.3em rgba(215,150,0,.75)}
.abs-sel{outline:.14em solid rgba(26,214,145,.85);outline-offset:.2em;border-radius:.1em}
span.abs-find{background:rgba(26,214,145,.4);border-radius:.14em}
.abs-widget{position:relative;display:block;width:fit-content;margin:1em auto;max-width:100%;overflow:hidden;cursor:pointer;-webkit-tap-highlight-color:transparent}
.abs-widget>img.abs-w-thumb{display:block;max-width:100%;height:auto;margin:0 auto}
.abs-widget .abs-w-badge{position:absolute;right:.6em;bottom:.6em;width:2.2em;height:2.2em;line-height:2.2em;text-align:center;border-radius:50%;background:rgba(0,0,0,.55);color:#fff;font:normal 1em/2.2em sans-serif;pointer-events:none}
.abs-widget iframe.abs-w-live{position:absolute;left:0;top:0;border:0;transform-origin:0 0;background:#fff;pointer-events:none}
.abs-hidden{display:none!important}
.abs-dropcap-letter{float:left;display:block;line-height:1;margin:0;padding:0 .08em 0 0}
.abs-ill{display:block;box-sizing:border-box;width:.8em;height:.8em;margin:.3em auto;border:.12em solid currentColor;border-radius:.2em;opacity:.35}
${nightCss(activeClass)}`
}

/**
 * Night mode: light text on black, switched by the `abs-night` class on <html> so that toggling needs no rebuild. The book's
 * colours are overridden (including -webkit-text-fill-color, which iBooks exports like to set); illustrations are not
 * touched. The active word becomes a solid amber block with black text: light text on a translucent amber would be weak.
 */
export function nightCss(activeClass) {
  const act = `[class~="${activeClass}"]`
  const text = '#e8e8e8'
  const accent = '#ffd27a'
  return `
html.abs-night{background:#000!important;color:${text};color-scheme:dark}
html.abs-night body{background:#000!important}
html.abs-night body,html.abs-night body *{color:${text}!important;-webkit-text-fill-color:${text}!important;background-color:transparent!important;border-color:#777!important;text-shadow:none!important}
html.abs-night h1,html.abs-night h2,html.abs-night h3,html.abs-night h4,html.abs-night h5,html.abs-night h6,html.abs-night h1 *,html.abs-night h2 *,html.abs-night h3 *,html.abs-night h4 *,html.abs-night h5 *,html.abs-night h6 *{color:#fff!important;-webkit-text-fill-color:#fff!important}
html.abs-night body *::first-letter{color:#fff!important;-webkit-text-fill-color:#fff!important}
html.abs-night body .abs-dropcap-letter,html.abs-night body .abs-dropcap-letter *{color:${accent}!important;-webkit-text-fill-color:${accent}!important}
html.abs-night body span${act}{background-color:#ffc400!important;box-shadow:0 0 0 .09em #ffc400;color:#000!important;-webkit-text-fill-color:#000!important}
html.abs-night body span${act}::first-letter{color:#000!important;-webkit-text-fill-color:#000!important}
html.abs-night body span.abs-find{background-color:#1ad691!important;color:#000!important;-webkit-text-fill-color:#000!important}
html.abs-night body .abs-widget .abs-w-badge{background-color:rgba(0,0,0,.55)!important;color:#fff!important;-webkit-text-fill-color:#fff!important}
html.abs-night body .abs-widget iframe.abs-w-live{background-color:#fff!important}
`
}

/**
 * @param {import('./epubBook.js').EpubBook} book
 * @param {number} chapterIdx
 * @param {{extractIllustrations?:boolean, illustrationsOnly?:boolean}} [opts] extractIllustrations: take every
 *   illustration (images, SVG images, widgets) out of the text flow, leaving a small marker, and list them in
 *   `illustrations` (document order); illustrationsOnly: skip styles and serialisation, only list the illustrations
 * @returns {Promise<{html:string, widgets:Array, images:number, dropcaps:Array, illustrations:Array}>}
 */
export async function buildChapterHtml(book, chapterIdx, opts = {}) {
  const only = !!opts.illustrationsOnly
  const extract = !!opts.extractIllustrations || only
  const ch = book.chapters[chapterIdx]
  const raw = await book.text(ch.href)
  let doc = new DOMParser().parseFromString(raw, 'application/xhtml+xml')
  if (doc.getElementsByTagName('parsererror').length || !doc.documentElement) {
    doc = new DOMParser().parseFromString(raw, 'text/html')
  }
  const ns = doc.documentElement.namespaceURI || XHTML_NS
  const make = (name) => doc.createElementNS(ns, name)
  const head = doc.querySelector('head') || doc.documentElement.insertBefore(make('head'), doc.documentElement.firstChild)
  const body = doc.querySelector('body')

  // ---- stylesheets: inline (url()s -> object URLs) ----
  const cssChunks = []
  let dropcapRules = []
  const pending = []
  const sheets = only ? [] : Array.from(doc.querySelectorAll('link[rel~="stylesheet"], link[type="text/css"]'))
  sheets.forEach((link, i) => {
    const href = link.getAttribute('href')
    if (!href || isExternalUrl(href)) return
    const p = book.resolve(ch.href, href)
    if (!book.has(p)) return
    pending.push(
      book
        .text(p)
        .then((css) => rewriteCssResolved(css, p, book).then((r) => ({ i, css, out: r.css })))
        .then(({ i: idx, css, out }) => {
          cssChunks[idx] = out
          dropcapRules = dropcapRules.concat(findDropcapRules(css))
        })
        .catch(() => {})
    )
  })
  const styleEls = only ? [] : Array.from(doc.querySelectorAll('style'))
  styleEls.forEach((st, i) => {
    const css = st.textContent || ''
    pending.push(
      rewriteCssResolved(css, ch.href, book).then((r) => {
        cssChunks[sheets.length + i] = r.css
        dropcapRules = dropcapRules.concat(findDropcapRules(css))
      })
    )
  })
  await Promise.all(pending)
  sheets.forEach((l) => l.parentNode && l.parentNode.removeChild(l))
  styleEls.forEach((s) => s.parentNode && s.parentNode.removeChild(s))
  const bookStyle = make('style')
  bookStyle.setAttribute('data-abs', 'book')
  bookStyle.textContent = cssChunks.filter(Boolean).join('\n')
  head.appendChild(bookStyle)
  const readerStyle = make('style')
  readerStyle.setAttribute('data-abs', 'reader')
  readerStyle.textContent = readerCss(book.activeClass)
  head.appendChild(readerStyle)

  // ---- remove active content ----
  doc.querySelectorAll('script, noscript, iframe, embed, audio, video, canvas').forEach((n) => n.parentNode && n.parentNode.removeChild(n))
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name)) el.removeAttribute(a.name)
    }
  })
  doc.querySelectorAll('a[href]').forEach((a) => {
    a.removeAttribute('href')
    a.removeAttribute('target')
  })
  doc.querySelectorAll('[style*="url("]').forEach((el) => {
    // inline style url()s are rare; drop them rather than resolving each
    el.setAttribute('style', el.getAttribute('style').replace(URL_RE, 'none'))
  })

  // ---- widgets ----
  const widgets = []
  doc.querySelectorAll('object').forEach((obj) => {
    const type = (obj.getAttribute('type') || '').toLowerCase()
    if (type !== 'application/x-ibooks+widget') {
      obj.parentNode.removeChild(obj)
      return
    }
    const kind = obj.getAttribute('data-widget-type') || 'html'
    const bundle = obj.getAttribute('data-bundle-path')
    if (kind !== 'html' || !bundle) {
      // pop-over / viewport widgets repeat text that is normally shown on tap: skip them
      obj.parentNode.removeChild(obj)
      return
    }
    const idx = widgets.length
    const start = obj.getAttribute('data-starting-file') || 'index.html'
    const stage = parseGeometry(obj.getAttribute('data-fullscreen-stage-geometry')) || parseGeometry(obj.getAttribute('data-geometry'))
    const thumb = obj.querySelector('img')
    const wrap = make('div')
    wrap.setAttribute('class', ((obj.getAttribute('class') || '') + ' abs-widget').trim())
    wrap.setAttribute('data-abs-w', String(idx))
    wrap.setAttribute('role', 'button')
    const title = obj.getAttribute('title')
    if (title) wrap.setAttribute('aria-label', title)
    if (thumb) {
      const img = thumb.cloneNode(true)
      img.setAttribute('class', ((img.getAttribute('class') || '') + ' abs-w-thumb').trim())
      wrap.appendChild(img)
    }
    const badge = make('div')
    badge.setAttribute('class', 'abs-w-badge')
    badge.textContent = '▶'
    wrap.appendChild(badge)
    obj.parentNode.replaceChild(wrap, obj)
    widgets.push({ index: idx, bundle: book.resolve(ch.href, bundle), start, stageW: stage ? stage.w : 0, stageH: stage ? stage.h : 0, title: title || '' })
  })

  // ---- images: resolved lazily after the document is shown (<img src> and SVG <image href>) ----
  let images = 0
  doc.querySelectorAll('img, image').forEach((img) => {
    const isSvg = img.localName === 'image'
    const src = isSvg ? img.getAttribute('href') || img.getAttribute('xlink:href') : img.getAttribute('src')
    if (!src || isExternalUrl(src)) return
    const p = book.resolve(ch.href, src)
    if (!book.has(p)) return
    if (isSvg) {
      img.removeAttribute('href')
      img.removeAttribute('xlink:href')
    } else img.removeAttribute('src')
    img.setAttribute('data-abs-src', p)
    images++
  })

  const illustrations = extract ? extractIllustrations(doc, make, widgets, chapterIdx) : []
  if (only) return { html: '', widgets, images, dropcaps: [], illustrations }

  let html = new XMLSerializer().serializeToString(doc)
  html = html.replace(/^<\?xml[^>]*\?>\s*/, '')
  html = '<!DOCTYPE html>' + html
  return { html, widgets, images, dropcaps: dropcapRules, illustrations }
}

const TEXT_BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,td,th,dd,dt,figcaption,pre'
const ORNAMENT_MAX = 90 // images declared smaller than this (px) in either direction are text ornaments, not illustrations
const MARK = 'abs-ill'

const lengthPx = (el, name) => {
  const a = parseFloat(el.getAttribute(name))
  if (a > 0) return a
  const m = new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([\\d.]+)px', 'i').exec(el.getAttribute('style') || '')
  return m ? parseFloat(m[1]) : 0
}

/** A small inline picture inside running text (glyph, flourish, icon) stays where it is. */
export function isOrnament(img) {
  const w = lengthPx(img, 'width')
  const h = lengthPx(img, 'height')
  if ((w && w < ORNAMENT_MAX) || (h && h < ORNAMENT_MAX)) return true
  if (w || h) return false
  // Unknown size: a picture standing in a block of its own is an illustration, one among words is an ornament
  const block = img.closest(TEXT_BLOCKS)
  return !!(block && block.querySelector('[id^="w"]'))
}

/** Highest ancestor (or the node itself) whose only content is `node`: that is what leaves the text flow. */
function wrapperOf(node, doc) {
  let c = node
  while (c.parentElement && c.parentElement !== doc.documentElement && c.parentElement.localName !== 'body') {
    const p = c.parentElement
    const other = Array.from(p.childNodes).some((n) => n !== c && ((n.nodeType === 1 && n.localName !== 'br') || (n.nodeType === 3 && n.nodeValue.trim())))
    if (other) break
    c = p
  }
  return c
}

/**
 * Replaces every illustration with a small marker and describes it. Narrated text (anything holding word spans, such as a
 * caption) is never removed: only the picture and wrappers that hold nothing else.
 * @returns {Array<{kind:'img'|'widget', path:string, w:number, h:number, alt:string, widget:object|null, chapter:number, index:number}>}
 */
export function extractIllustrations(doc, make, widgets, chapterIdx) {
  const out = []
  const nodes = Array.from(doc.querySelectorAll('.abs-widget, img, svg'))
  const done = new Set()
  for (const node of nodes) {
    if (done.has(node) || !node.parentNode) continue
    let desc = null
    if (node.classList && node.classList.contains('abs-widget')) {
      const spec = widgets[parseInt(node.getAttribute('data-abs-w'), 10)]
      if (!spec) continue
      const thumb = node.querySelector('img.abs-w-thumb')
      desc = { kind: 'widget', path: (thumb && thumb.getAttribute('data-abs-src')) || '', w: thumb ? lengthPx(thumb, 'width') : 0, h: thumb ? lengthPx(thumb, 'height') : 0, alt: spec.title || '', widget: spec }
    } else if (node.localName === 'svg') {
      if (node.closest('.abs-widget')) continue
      const image = node.querySelector('image[data-abs-src]')
      if (!image) continue
      node.querySelectorAll('image').forEach((n) => done.add(n))
      let w = lengthPx(node, 'width')
      let h = lengthPx(node, 'height')
      const vb = (node.getAttribute('viewBox') || '')
        .trim()
        .split(/[\s,]+/)
        .map(parseFloat)
      if ((!w || !h) && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
        w = vb[2]
        h = vb[3]
      }
      desc = { kind: 'img', path: image.getAttribute('data-abs-src'), w, h, alt: node.getAttribute('aria-label') || '', widget: null }
    } else {
      if (node.closest('.abs-widget') || node.closest('svg') || !node.getAttribute('data-abs-src')) continue
      if (isOrnament(node)) continue
      desc = { kind: 'img', path: node.getAttribute('data-abs-src'), w: lengthPx(node, 'width'), h: lengthPx(node, 'height'), alt: node.getAttribute('alt') || '', widget: null }
    }
    const wrap = wrapperOf(node, doc)
    wrap.querySelectorAll('.abs-widget, img, svg').forEach((n) => done.add(n))
    desc.chapter = chapterIdx
    desc.index = out.length
    const mark = make('span')
    mark.setAttribute('class', MARK)
    mark.setAttribute('data-abs-ill', String(desc.index))
    mark.setAttribute('aria-hidden', 'true')
    wrap.parentNode.replaceChild(mark, wrap)
    out.push(desc)
  }
  return out
}

/**
 * After the iframe is laid out: bring up images and the iBooks drop caps. Returns a cancel function.
 * @param {Document} doc
 * @param {import('./epubBook.js').EpubBook} book
 */
export function hydrateChapter(doc, book, dropcaps) {
  let cancelled = false
  const imgs = Array.from(doc.querySelectorAll('img[data-abs-src], image[data-abs-src]'))
  let next = 0
  const worker = async () => {
    while (!cancelled && next < imgs.length) {
      const img = imgs[next++]
      try {
        const url = await book.blobUrl(img.getAttribute('data-abs-src'))
        if (!cancelled) img.setAttribute(img.localName === 'image' ? 'href' : 'src', url)
      } catch (e) {
        // a missing image just stays blank
      }
    }
  }
  for (let i = 0; i < 3; i++) worker()
  applyDropcaps(doc, dropcaps)
  return () => {
    cancelled = true
  }
}

/**
 * Chrome does not know `-ibooks-dropcap`: emulate it by floating the first letter(s) so that they span the
 * requested number of text lines.
 */
export function applyDropcaps(doc, rules) {
  const win = doc.defaultView
  if (!win || !rules || !rules.length) return
  const seen = new Set()
  for (const rule of rules) {
    for (const sel of rule.selectors) {
      let els
      try {
        els = doc.querySelectorAll(sel)
      } catch (e) {
        continue
      }
      els.forEach((p) => {
        if (seen.has(p)) return
        seen.add(p)
        const cap = p.firstElementChild
        if (!cap || (cap.textContent || '').trim().length > Math.max(1, rule.chars) + 1) return
        const cs = win.getComputedStyle(p)
        const fs = parseFloat(cs.fontSize) || 16
        let lh = parseFloat(cs.lineHeight)
        if (!(lh > 0)) lh = fs * 1.25
        const lines = Math.max(2, rule.lines)
        const box = lh * lines // height the floated letter may occupy
        // Cap height of the usual book fonts is ~0.68em: size the glyph so its capitals fill `lines` lines
        const size = (box - lh * 0.15) / 0.68
        cap.classList.add('abs-dropcap-letter')
        cap.style.fontSize = size + 'px'
        cap.style.lineHeight = box * 0.92 + 'px'
        cap.style.height = box * 0.92 + 'px'
        cap.style.paddingRight = Math.max(0, rule.padding) + fs * 0.12 + 'px'
        p.style.textIndent = '0'
      })
    }
  }
}
