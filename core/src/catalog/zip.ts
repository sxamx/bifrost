import zlib from 'node:zlib';

export interface ZipEntry {
  filename: string;
  uncompressedSize: number;
  readText: () => string;
  readBuffer: () => Buffer;
}

const EOCD_SIGNATURE = 0x06054b50;
const CEN_SIGNATURE = 0x02014b50;
const LOC_SIGNATURE = 0x04034b50;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Zero-dependency in-memory PKZIP reader reading the Central Directory so even
 * entries using data descriptors (bit 3) are parsed reliably, with lazy per-entry
 * decompression so excluded files (like `*_external.csv`) never even get inflated.
 */
export function readZipArchive(
  zipBuffer: Buffer,
  maxEntryUncompressedBytes = 32 * 1024 * 1024,
): ZipEntry[] {
  if (zipBuffer.length < 22) {
    throw new Error('Invalid ZIP buffer: smaller than End of Central Directory record.');
  }

  // Locate End of Central Directory (EOCD) scanning backwards up to 65,557 bytes
  const minEocdOffset = Math.max(0, zipBuffer.length - 65557);
  let eocdOffset = -1;
  for (let pos = zipBuffer.length - 22; pos >= minEocdOffset; pos -= 1) {
    if (zipBuffer.readUInt32LE(pos) === EOCD_SIGNATURE) {
      eocdOffset = pos;
      break;
    }
  }
  if (eocdOffset === -1) {
    throw new Error('Invalid ZIP buffer: End of Central Directory signature not found.');
  }

  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const centralDirSize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  if (centralDirOffset + centralDirSize > zipBuffer.length) {
    throw new Error('Invalid ZIP buffer: Central Directory bounds exceed archive size.');
  }

  const entries: ZipEntry[] = [];
  let cursor = centralDirOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (cursor + 46 > zipBuffer.length || zipBuffer.readUInt32LE(cursor) !== CEN_SIGNATURE) {
      throw new Error('Invalid ZIP buffer: corrupt Central Directory file header.');
    }

    const compressionMethod = zipBuffer.readUInt16LE(cursor + 10);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(cursor + 24);
    const fileNameLen = zipBuffer.readUInt16LE(cursor + 28);
    const extraLen = zipBuffer.readUInt16LE(cursor + 30);
    const commentLen = zipBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42);

    const filename = zipBuffer
      .subarray(cursor + 46, cursor + 46 + fileNameLen)
      .toString('utf8');

    cursor += 46 + fileNameLen + extraLen + commentLen;

    if (filename.endsWith('/')) {
      continue;
    }

    const readBuffer = (): Buffer => {
      if (uncompressedSize > maxEntryUncompressedBytes) {
        throw new Error(
          `ZIP entry "${filename}" exceeds maximum allowed uncompressed size (${maxEntryUncompressedBytes} bytes).`,
        );
      }
      if (
        localHeaderOffset + 30 > zipBuffer.length ||
        zipBuffer.readUInt32LE(localHeaderOffset) !== LOC_SIGNATURE
      ) {
        throw new Error(`Invalid local file header for ZIP entry "${filename}".`);
      }
      const localNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
      const localExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
      const dataEnd = dataStart + compressedSize;
      if (dataEnd > zipBuffer.length) {
        throw new Error(`Truncated compressed payload for ZIP entry "${filename}".`);
      }

      const slice = zipBuffer.subarray(dataStart, dataEnd);
      if (compressionMethod === 0) {
        return Buffer.from(slice);
      }
      if (compressionMethod === 8) {
        return zlib.inflateRawSync(slice, { maxOutputLength: maxEntryUncompressedBytes });
      }
      throw new Error(
        `Unsupported ZIP compression method ${compressionMethod} for entry "${filename}".`,
      );
    };

    entries.push({
      filename,
      uncompressedSize,
      readBuffer,
      readText: () => readBuffer().toString('utf8'),
    });
  }

  return entries;
}

/**
 * Builds a valid standard PKZIP buffer in memory from `{ filename, content }` entries
 * (used for deterministic offline unit testing of Epoch AI archive filtering).
 */
export function buildZipArchive(
  files: ReadonlyArray<{ filename: string; content: string | Buffer }>,
): Buffer {
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBuf = Buffer.from(file.filename, 'utf8');
    const rawBuf =
      typeof file.content === 'string' ? Buffer.from(file.content, 'utf8') : file.content;
    const compressedBuf = zlib.deflateRawSync(rawBuf);
    const crc = crc32(rawBuf);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(LOC_SIGNATURE, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedBuf.length, 18);
    localHeader.writeUInt32LE(rawBuf.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, nameBuf, compressedBuf);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(CEN_SIGNATURE, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedBuf.length, 20);
    centralHeader.writeUInt32LE(rawBuf.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt16LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralChunks.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compressedBuf.length;
  }

  const centralDirBuf = Buffer.concat(centralChunks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIGNATURE, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralDirBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirBuf, eocd]);
}
