/**
 * Lazy zip reader over HTTP Range requests. Dependency free (DecompressionStream for inflate).
 * Only the central directory and the entries that are asked for are ever fetched.
 */

const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_LOC64 = 0x07064b50
const SIG_CEN = 0x02014b50
const SIG_LOCAL = 0x04034b50
const TAIL = 65535 + 22 + 20 + 64
// Extra bytes fetched after a known-size local entry so a local extra field (unknown length) fits in one request
const LOCAL_SLACK = 512

// cp437 high half, for archives that do not set the UTF-8 flag
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '

function decodeName(bytes, utf8) {
  let ascii = true
  for (let i = 0; i < bytes.length; i++) if (bytes[i] > 127) { ascii = false; break }
  if (ascii) return String.fromCharCode.apply(null, bytes)
  if (utf8) return new TextDecoder('utf-8').decode(bytes)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i] < 128 ? String.fromCharCode(bytes[i]) : CP437[bytes[i] - 128]
  return s
}

/** Canonical form used for lookups: percent-decoded when possible, backslashes and a leading slash removed. */
export function normalizeName(name) {
  let n = String(name).replace(/\\/g, '/')
  try {
    n = decodeURIComponent(n)
  } catch (e) {
    // keep as is
  }
  return n.replace(/^\/+/, '')
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const u16 = (dv, o) => dv.getUint16(o, true)
const u32 = (dv, o) => dv.getUint32(o, true)
const u64 = (dv, o) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 4294967296

/**
 * @param {(start:number, endInclusive:number)=>Promise<Uint8Array>} readRange
 * @param {number} size total archive size in bytes
 */
export async function openZip(readRange, size) {
  const stats = { rangeRequests: 0, bytesFetched: 0 }
  const fetchRange = async (start, end) => {
    end = Math.min(end, size - 1)
    if (end < start) return new Uint8Array(0)
    const b = await readRange(start, end)
    stats.rangeRequests++
    stats.bytesFetched += b.length
    if (b.length < end - start + 1) throw new Error(`Short range read ${start}-${end}: got ${b.length}`)
    return b
  }

  const tailStart = Math.max(0, size - TAIL)
  const tail = await fetchRange(tailStart, size - 1)
  const tdv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tdv, i) === SIG_EOCD && i + 22 + u16(tdv, i + 20) <= tail.length) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a zip file (no end of central directory)')
  let count = u16(tdv, eocd + 10)
  let cdSize = u32(tdv, eocd + 12)
  let cdOffset = u32(tdv, eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    if (eocd < 20 || u32(tdv, eocd - 20) !== SIG_LOC64) throw new Error('Zip64 locator missing')
    const e64Off = u64(tdv, eocd - 20 + 8)
    let e64
    if (e64Off >= tailStart) e64 = tail.subarray(e64Off - tailStart, e64Off - tailStart + 56)
    else e64 = await fetchRange(e64Off, e64Off + 55)
    const d = new DataView(e64.buffer, e64.byteOffset, e64.byteLength)
    if (u32(d, 0) !== SIG_EOCD64) throw new Error('Bad zip64 end record')
    count = u64(d, 32)
    cdSize = u64(d, 40)
    cdOffset = u64(d, 48)
  }
  const cd = cdOffset >= tailStart ? tail.subarray(cdOffset - tailStart, cdOffset - tailStart + cdSize) : await fetchRange(cdOffset, cdOffset + cdSize - 1)
  const cdv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)

  /** @type {Map<string, object>} */
  const entries = new Map()
  const lookup = new Map()
  let p = 0
  while (p + 46 <= cd.length && u32(cdv, p) === SIG_CEN) {
    const flags = u16(cdv, p + 8)
    const method = u16(cdv, p + 10)
    const crc = u32(cdv, p + 16)
    let compressedSize = u32(cdv, p + 20)
    let usize = u32(cdv, p + 24)
    const nlen = u16(cdv, p + 28)
    const elen = u16(cdv, p + 30)
    const clen = u16(cdv, p + 32)
    let offset = u32(cdv, p + 42)
    const name = decodeName(cd.subarray(p + 46, p + 46 + nlen), !!(flags & 0x800))
    if (compressedSize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) {
      // zip64 extra: fields present only for the saturated values, in this order
      let q = p + 46 + nlen
      const qEnd = q + elen
      while (q + 4 <= qEnd) {
        const id = u16(cdv, q)
        const len = u16(cdv, q + 2)
        if (id === 1) {
          let r = q + 4
          if (usize === 0xffffffff) { usize = u64(cdv, r); r += 8 }
          if (compressedSize === 0xffffffff) { compressedSize = u64(cdv, r); r += 8 }
          if (offset === 0xffffffff) { offset = u64(cdv, r) }
          break
        }
        q += 4 + len
      }
    }
    const entry = { name, method, compressedSize, size: usize, offset, crc, flags }
    entries.set(name, entry)
    lookup.set(normalizeName(name), entry)
    p += 46 + nlen + elen + clen
  }

  const find = (name) => entries.get(name) || lookup.get(normalizeName(name)) || null
  const need = (name) => {
    const e = find(name)
    if (!e) throw new Error(`Zip entry not found: ${name}`)
    return e
  }

  /** Reads the local header; returns absolute offset of the data, plus any bytes already fetched past it. */
  async function locate(e, wantDataBytes) {
    const guess = 30 + Buffer_len(e.name) + LOCAL_SLACK
    const first = await fetchRange(e.offset, e.offset + guess + wantDataBytes - 1)
    const dv = new DataView(first.buffer, first.byteOffset, first.byteLength)
    if (first.length < 30 || u32(dv, 0) !== SIG_LOCAL) throw new Error(`Bad local header for ${e.name}`)
    const dataStart = 30 + u16(dv, 26) + u16(dv, 28)
    return { first, dataStart }
  }
  const Buffer_len = (s) => new TextEncoder().encode(s).length

  async function readRaw(e) {
    const { first, dataStart } = await locate(e, e.compressedSize)
    if (dataStart + e.compressedSize <= first.length) return first.subarray(dataStart, dataStart + e.compressedSize)
    if (dataStart >= first.length) return fetchRange(e.offset + dataStart, e.offset + dataStart + e.compressedSize - 1)
    const rest = await fetchRange(e.offset + first.length, e.offset + dataStart + e.compressedSize - 1)
    const out = new Uint8Array(e.compressedSize)
    out.set(first.subarray(dataStart))
    out.set(rest, first.length - dataStart)
    return out
  }

  async function read(name) {
    const e = need(name)
    if (e.compressedSize === 0) return new Uint8Array(0)
    // A STORED entry with the data beyond the slack never needs the speculative extra, but one request is the goal
    const raw = await readRaw(e)
    let out
    if (e.method === 0) out = raw
    else if (e.method === 8) out = await inflateRaw(raw)
    else throw new Error(`Unsupported zip method ${e.method} for ${name}`)
    if (out.length !== e.size) throw new Error(`Size mismatch for ${name}: ${out.length} != ${e.size}`)
    return out
  }

  async function readSlice(name, start, endInclusive) {
    const e = need(name)
    if (e.method !== 0) return (await read(name)).subarray(start, endInclusive + 1)
    endInclusive = Math.min(endInclusive, e.size - 1)
    if (endInclusive < start) return new Uint8Array(0)
    // Header only (no data bytes requested), then exactly the slice
    const { first, dataStart } = await locate(e, 0)
    const s = e.offset + dataStart + start
    const t = e.offset + dataStart + endInclusive
    const have = e.offset + first.length
    if (t < have) return first.subarray(s - e.offset, t - e.offset + 1)
    if (s >= have) return fetchRange(s, t)
    const tailPart = await fetchRange(have, t)
    const out = new Uint8Array(t - s + 1)
    out.set(first.subarray(s - e.offset))
    out.set(tailPart, have - s)
    return out
  }

  return {
    entries,
    stats,
    has: (name) => !!find(name),
    names: () => [...entries.keys()],
    entry: find,
    read,
    readText: async (name) => new TextDecoder('utf-8').decode(await read(name)),
    readSlice
  }
}
