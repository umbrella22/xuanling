/**
 * Minimal ZIP container (W5.1). The archive is only a distribution vehicle —
 * inside it stays `blueprint.json + lib/`. The writer emits store-only
 * entries (no compression, deterministic bytes); the reader accepts store and
 * deflate but validates every structural property the security contract
 * needs: names, entry kinds, sizes and CRCs. Absolute paths, `..` traversal,
 * backslashes, NUL, drive letters, symlink entries, duplicates and
 * case-folded collisions are rejected before any byte reaches the filesystem.
 */
import { inflateRawSync } from 'node:zlib'

export class ArchiveUnsafeError extends Error {
  override readonly name = 'ArchiveUnsafeError'
  readonly code = 'ARCHIVE_UNSAFE'
  readonly reason: string
  readonly entry: string | undefined
  constructor(reason: string, entry?: string) {
    super(`archive unsafe: ${reason}${entry !== undefined ? ` (entry ${entry})` : ''}`)
    this.reason = reason
    this.entry = entry
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipEntryInput {
  name: string
  data: Buffer
  /** Unix mode stored in external attributes (default 0o100644). */
  mode?: number
}

/** Write a store-only zip with deterministic layout (sorted by name). */
export function writeZip(entries: readonly ZipEntryInput[]): Buffer {
  const sorted = [...entries].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of sorted) {
    const nameBuf = Buffer.from(entry.name, 'utf8')
    if (nameBuf.length > 0xffff) throw new ArchiveUnsafeError('entry name too long', entry.name)
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // UTF-8 names
    local.writeUInt16LE(0, 8) // store
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(entry.data.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    locals.push(local, entry.data)

    const central = Buffer.alloc(46 + nameBuf.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4) // made by unix
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(entry.data.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    nameBuf.copy(central, 46)
    centrals.push(central)
    offset += local.length + entry.data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(sorted.length, 8)
  eocd.writeUInt16LE(sorted.length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuf, eocd])
}

export interface ZipLimits {
  maxEntries: number
  maxTotalUncompressed: number
  maxNameLength: number
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 5_000,
  maxTotalUncompressed: 256 * 1024 * 1024,
  maxNameLength: 1_024,
}

export interface ZipEntry {
  name: string
  data: Buffer
  mode: number
}

function assertSafeName(name: string): void {
  if (name.length === 0) throw new ArchiveUnsafeError('empty entry name')
  if (name.length > DEFAULT_ZIP_LIMITS.maxNameLength) throw new ArchiveUnsafeError('entry name too long', name)
  if (name.includes('\u0000')) throw new ArchiveUnsafeError('NUL in entry name', name)
  if (name.includes('\\')) throw new ArchiveUnsafeError('backslash in entry name', name)
  if (name.startsWith('/')) throw new ArchiveUnsafeError('absolute entry path', name)
  if (/^[a-zA-Z]:/.test(name)) throw new ArchiveUnsafeError('drive-letter entry path', name)
  if (name.endsWith('/')) throw new ArchiveUnsafeError('directory entries are not part of the container contract', name)
  for (const segment of name.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') throw new ArchiveUnsafeError(`unsafe path segment "${segment}"`, name)
  }
}

/** Strict, limit-bounded zip reader. Returns entries in central-directory
 * order; every structural violation is ARCHIVE_UNSAFE before extraction. */
export function readZip(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  if (buf.length < 22) throw new ArchiveUnsafeError('truncated archive')
  // Locate the EOCD by scanning from the tail (comment up to 65535 bytes).
  let eocd = -1
  const scanStart = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new ArchiveUnsafeError('end-of-central-directory not found')
  const entryCount = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (entryCount > limits.maxEntries) throw new ArchiveUnsafeError(`entry count ${entryCount} exceeds budget ${limits.maxEntries}`)
  if (cdOffset + cdSize > buf.length) throw new ArchiveUnsafeError('central directory out of bounds')

  const entries: ZipEntry[] = []
  const seen = new Map<string, string>()
  let total = 0
  let cursor = cdOffset
  for (let i = 0; i < entryCount; i++) {
    if (cursor + 46 > buf.length || buf.readUInt32LE(cursor) !== 0x02014b50) {
      throw new ArchiveUnsafeError('corrupt central directory')
    }
    const method = buf.readUInt16LE(cursor + 10)
    const crc = buf.readUInt32LE(cursor + 16)
    const compressedSize = buf.readUInt32LE(cursor + 20)
    const uncompressedSize = buf.readUInt32LE(cursor + 24)
    const nameLen = buf.readUInt16LE(cursor + 28)
    const extraLen = buf.readUInt16LE(cursor + 30)
    const commentLen = buf.readUInt16LE(cursor + 32)
    const externalAttrs = buf.readUInt32LE(cursor + 38)
    const localOffset = buf.readUInt32LE(cursor + 42)
    const name = buf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8')
    cursor += 46 + nameLen + extraLen + commentLen

    assertSafeName(name)
    const unixMode = (externalAttrs >>> 16) & 0xffff
    if ((unixMode & 0xf000) === 0xa000) throw new ArchiveUnsafeError('symlink entries are rejected', name)
    if (method !== 0 && method !== 8) throw new ArchiveUnsafeError(`unsupported compression method ${method}`, name)
    total += uncompressedSize
    if (total > limits.maxTotalUncompressed) {
      throw new ArchiveUnsafeError(`uncompressed budget ${limits.maxTotalUncompressed} exceeded`, name)
    }
    const key = name.normalize('NFC').toLowerCase()
    const prior = seen.get(key)
    if (prior !== undefined) {
      throw new ArchiveUnsafeError(prior === name ? 'duplicate entry' : 'case/Unicode-colliding entries', name)
    }
    seen.set(key, name)

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new ArchiveUnsafeError('corrupt local header', name)
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const localName = buf.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString('utf8')
    if (localName !== name) throw new ArchiveUnsafeError('local/central name mismatch', name)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(dataStart, dataStart + compressedSize)
    if (raw.length !== compressedSize) throw new ArchiveUnsafeError('truncated entry data', name)
    let data: Buffer
    if (method === 0) {
      if (compressedSize !== uncompressedSize) throw new ArchiveUnsafeError('store entry size mismatch', name)
      data = Buffer.from(raw)
    } else {
      try {
        data = inflateRawSync(raw, { maxOutputLength: Math.max(1, uncompressedSize) })
      } catch {
        throw new ArchiveUnsafeError('deflate decompression failed or exceeded its declared size', name)
      }
      if (data.length !== uncompressedSize) throw new ArchiveUnsafeError('deflate size mismatch', name)
    }
    if (crc32(data) !== crc) throw new ArchiveUnsafeError('CRC mismatch', name)
    entries.push({ name, data, mode: unixMode === 0 ? 0o100644 : unixMode })
  }
  // Trailing garbage between the central directory and EOCD is a structural
  // violation only when it overlaps the CD; a valid zip may carry a comment.
  return entries
}
