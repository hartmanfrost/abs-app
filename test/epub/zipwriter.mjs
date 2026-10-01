// Minimal zip writer for tests (stored/deflate, optional zip64 structures).
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * @param {Array<{name:string,data:Uint8Array|string,method?:'store'|'deflate'}>} entries
 * @param {{zip64?:boolean, comment?:string, prefixPad?:number}} [opts] prefixPad = junk bytes before the first entry (offsets stay absolute)
 */
export function makeZip(entries, opts = {}) {
  const parts = []
  const central = []
  let offset = opts.prefixPad || 0
  if (offset) parts.push(Buffer.alloc(offset, 0x41))
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const raw = typeof e.data === 'string' ? Buffer.from(e.data, 'utf8') : Buffer.from(e.data)
    const store = e.method === 'store'
    const body = store ? raw : deflateRawSync(raw)
    const crc = crc32(raw)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(opts.zip64 ? 45 : 20, 4)
    lh.writeUInt16LE(0x0800, 6) // utf-8 names
    lh.writeUInt16LE(store ? 0 : 8, 8)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(name.length, 26)
    const lextra = Buffer.alloc(e.localExtra || 0, 0) // deliberately different from the central extra
    lh.writeUInt16LE(lextra.length, 28)
    parts.push(lh, name, lextra, body)
    const entryOffset = offset
    offset += lh.length + name.length + lextra.length + body.length

    let extra = Buffer.alloc(0)
    let cSize = body.length
    let uSize = raw.length
    let cOff = entryOffset
    if (opts.zip64) {
      extra = Buffer.alloc(28)
      extra.writeUInt16LE(1, 0)
      extra.writeUInt16LE(24, 2)
      extra.writeBigUInt64LE(BigInt(raw.length), 4)
      extra.writeBigUInt64LE(BigInt(body.length), 12)
      extra.writeBigUInt64LE(BigInt(entryOffset), 20)
      cSize = uSize = cOff = 0xffffffff
    }
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(opts.zip64 ? 45 : 20, 4)
    ch.writeUInt16LE(opts.zip64 ? 45 : 20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(store ? 0 : 8, 10)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(cSize, 20)
    ch.writeUInt32LE(uSize, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(extra.length, 30)
    ch.writeUInt32LE(cOff, 42)
    central.push(ch, name, extra)
  }
  const cdBuf = Buffer.concat(central)
  const cdOffset = offset
  parts.push(cdBuf)
  offset += cdBuf.length
  const comment = Buffer.from(opts.comment || '', 'utf8')
  if (opts.zip64) {
    const e64 = Buffer.alloc(56)
    e64.writeUInt32LE(0x06064b50, 0)
    e64.writeBigUInt64LE(44n, 4)
    e64.writeUInt16LE(45, 12)
    e64.writeUInt16LE(45, 14)
    e64.writeBigUInt64LE(BigInt(entries.length), 24)
    e64.writeBigUInt64LE(BigInt(entries.length), 32)
    e64.writeBigUInt64LE(BigInt(cdBuf.length), 40)
    e64.writeBigUInt64LE(BigInt(cdOffset), 48)
    const loc = Buffer.alloc(20)
    loc.writeUInt32LE(0x07064b50, 0)
    loc.writeBigUInt64LE(BigInt(offset), 8)
    loc.writeUInt32LE(1, 16)
    parts.push(e64, loc)
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  if (opts.zip64) {
    eocd.writeUInt16LE(0xffff, 8)
    eocd.writeUInt16LE(0xffff, 10)
    eocd.writeUInt32LE(0xffffffff, 12)
    eocd.writeUInt32LE(0xffffffff, 16)
  } else {
    eocd.writeUInt16LE(entries.length, 8)
    eocd.writeUInt16LE(entries.length, 10)
    eocd.writeUInt32LE(cdBuf.length, 12)
    eocd.writeUInt32LE(cdOffset, 16)
  }
  eocd.writeUInt16LE(comment.length, 20)
  parts.push(eocd, comment)
  return Buffer.concat(parts)
}
