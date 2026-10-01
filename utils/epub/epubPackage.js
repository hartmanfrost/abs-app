/**
 * EPUB package parsing (container.xml, OPF, encryption.xml) with a small tag scanner.
 * No DOM: runs in node tests and in the WebView alike.
 */
import { sha1 } from './sha1.js'

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m
    }
    return ENTITIES[e.toLowerCase()] || m
  })
}

/** Attributes of a start tag body; names are lower-cased and namespace prefixes are kept (xml:lang etc.). */
function parseAttrs(src) {
  const attrs = {}
  const re = /([^\s=/>"']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  let m
  while ((m = re.exec(src))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] !== undefined ? m[2] : m[3])
  return attrs
}

const local = (name) => name.replace(/^.*:/, '').toLowerCase()

/**
 * Scan all elements: calls fn(localName, attrs, innerText|null) for every start tag.
 * innerText is the raw text up to the matching close tag for simple (non nested) elements, else null for empty tags.
 */
function scanTags(xml, wanted, fn) {
  const re = /<([A-Za-z_][\w.:-]*)((?:\s+[^<>]*?)?)(\/?)>/g
  let m
  while ((m = re.exec(xml))) {
    const name = local(m[1])
    if (!wanted.has(name)) continue
    let text = null
    if (!m[3]) {
      const close = xml.indexOf('</', re.lastIndex)
      if (close >= 0) text = decodeEntities(xml.slice(re.lastIndex, close)).trim()
    }
    fn(name, parseAttrs(m[2]), text)
  }
}

export function splitHref(href) {
  const s = String(href || '')
  const hash = s.indexOf('#')
  const frag = hash >= 0 ? s.slice(hash + 1) : ''
  let path = hash >= 0 ? s.slice(0, hash) : s
  const q = path.indexOf('?')
  if (q >= 0) path = path.slice(0, q)
  return { path, fragment: frag }
}

/** Resolve an href found in the file at baseZipPath to a percent-decoded path relative to the zip root. */
export function resolveZipPath(baseZipPath, href) {
  let { path } = splitHref(href)
  try {
    path = decodeURIComponent(path)
  } catch (e) {
    // keep raw
  }
  const parts = path.startsWith('/') ? [] : String(baseZipPath || '').split('/').slice(0, -1)
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}

export function parseContainer(xml) {
  let out = null
  scanTags(xml, new Set(['rootfile']), (n, a) => {
    if (!out && a['full-path']) out = a['full-path']
  })
  if (!out) throw new Error('container.xml has no rootfile')
  return out
}

export function parseClockSeconds(s) {
  // media:duration is a SMIL clock value; the full parser lives in smil.js but this avoids a dependency cycle
  const t = String(s).trim()
  let m
  if ((m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(t))) return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3]
  if ((m = /^(\d+(?:\.\d+)?)(h|min|s|ms)?$/.exec(t))) return +m[1] * { h: 3600, min: 60, s: 1, ms: 0.001, '': 1 }[m[2] || '']
  return NaN
}

export function parseOpf(xml, opfPath) {
  let uidRef = null
  const identifiers = []
  let title = ''
  const manifest = new Map()
  const spine = []
  let activeClass = null
  let playbackActiveClass = null
  const durations = new Map()
  let totalDuration = 0

  scanTags(xml, new Set(['package', 'identifier', 'title', 'item', 'itemref', 'meta']), (n, a, text) => {
    if (n === 'package') uidRef = a['unique-identifier'] || null
    else if (n === 'identifier') identifiers.push({ id: a.id || null, text: text || '' })
    else if (n === 'title') {
      if (!title && text) title = text
    } else if (n === 'item') {
      if (!a.id) return
      manifest.set(a.id, {
        id: a.id,
        href: resolveZipPath(opfPath, a.href || ''),
        mediaType: a['media-type'] || '',
        mediaOverlay: a['media-overlay'] || null,
        properties: (a.properties || '').split(/\s+/).filter(Boolean)
      })
    } else if (n === 'itemref') {
      if (a.idref) spine.push({ idref: a.idref, linear: a.linear !== 'no' })
    } else if (n === 'meta') {
      const prop = a.property
      if (prop === 'media:active-class') activeClass = text
      else if (prop === 'media:playback-active-class') playbackActiveClass = text
      else if (prop === 'media:duration') {
        const secs = parseClockSeconds(text || '')
        if (!Number.isFinite(secs)) return
        if (a.refines) durations.set(a.refines.replace(/^#/, ''), secs)
        else totalDuration = secs
      }
    }
  })

  let uid = ''
  const ident = identifiers.find((i) => i.id && i.id === uidRef) || identifiers[0]
  if (ident) uid = ident.text
  for (const s of spine) s.item = manifest.get(s.idref) || null
  const overlays = spine
    .filter((s) => s.item && s.item.mediaOverlay)
    .map((s) => ({ idref: s.idref, item: s.item, smil: manifest.get(s.item.mediaOverlay) || null }))
    .filter((o) => o.smil)
  return { uid, title, manifest, spine, activeClass: activeClass || '-epub-media-overlay-active', playbackActiveClass, durations, totalDuration, overlays }
}

/** @returns {Map<string,string>} zip path -> encryption algorithm URI */
export function parseEncryption(xml) {
  const out = new Map()
  let alg = null
  const re = /<(?:\w+:)?EncryptedData[\s>][\s\S]*?<\/(?:\w+:)?EncryptedData>/g
  let m
  while ((m = re.exec(xml))) {
    alg = null
    let uri = null
    scanTags(m[0], new Set(['encryptionmethod', 'cipherreference']), (n, a) => {
      if (n === 'encryptionmethod') alg = a.algorithm
      else uri = a.uri
    })
    if (alg && uri) out.set(resolveZipPath('', uri), alg)
  }
  return out
}

export const ALG_IDPF = 'http://www.idpf.org/2008/embedding'
export const ALG_ADOBE = 'http://ns.adobe.com/pdf/enc#RC'

/** Returns the de-obfuscated copy of the bytes, or null when the algorithm is not a font obfuscation we know. */
export function deobfuscate(bytes, algorithm, uid) {
  let key
  let n
  if (algorithm === ALG_IDPF) {
    key = sha1(new TextEncoder().encode(String(uid).replace(/[ \u0009\u000d\u000a]/g, '')))
    n = 1040
  } else if (algorithm === ALG_ADOBE) {
    const hex = String(uid).replace(/^urn:uuid:/i, '').replace(/[^0-9a-f]/gi, '')
    if (hex.length !== 32) return null
    key = new Uint8Array(16)
    for (let i = 0; i < 16; i++) key[i] = parseInt(hex.substr(i * 2, 2), 16)
    n = 1024
  } else return null
  const out = new Uint8Array(bytes)
  const lim = Math.min(n, out.length)
  for (let i = 0; i < lim; i++) out[i] ^= key[i % key.length]
  return out
}
