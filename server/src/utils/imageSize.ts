/**
 * 從圖檔的檔頭解析像素尺寸（無外部依賴）。
 *
 * 用途：Asana inline 圖片（html_text 的 <img data-asana-gid>）需要帶
 * data-src-width / data-src-height，否則會渲染成極小且無法調整的縮圖
 * （Asana 的 metadata 是上傳後非同步算的，API 上傳時這兩個值會停在 0）。
 * 自己算出尺寸填進去就不必依賴那個非同步流程。
 *
 * 支援 PNG / JPEG / GIF / WebP；認不出來回 null（呼叫端應省略該屬性而非填 0）。
 */

export interface ImageSize {
  width: number;
  height: number;
}

/** 依副檔名推 MIME type（Asana 上傳的 file part 需要正確的 Content-Type）。 */
export function mimeTypeForImage(filename: string): string {
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  switch (ext) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.bmp': return 'image/bmp';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

function parsePng(buf: Buffer): ImageSize | null {
  // 8-byte signature + 4-byte length + "IHDR" + width(4) + height(4)
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function parseGif(buf: Buffer): ImageSize | null {
  // "GIF87a"/"GIF89a" + logical screen width/height as little-endian uint16
  if (buf.length < 10) return null;
  const sig = buf.toString('ascii', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

function parseJpeg(buf: Buffer): ImageSize | null {
  // SOI，然後逐段掃到 SOF（0xFFC0-0xFFCF，排除 C4/C8/CC 這三個非 SOF marker）
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  // SOF 需要讀到 offset+8（ff, marker, len×2, precision, height×2, width×2），
  // 故條件是 <=：用 < 會讓「SOF 剛好在檔尾」的 JPEG 解析不到
  while (offset + 9 <= buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue; } // 跳過填充位元組
    const marker = buf[offset + 1]!;
    // 無酬載的 marker（RSTn / SOI / EOI / TEM）
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const segLen = buf.readUInt16BE(offset + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      // SOF: len(2) precision(1) height(2) width(2)
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    }
    if (segLen < 2) return null; // 長度不合法，避免無限迴圈
    offset += 2 + segLen;
  }
  return null;
}

function parseWebp(buf: Buffer): ImageSize | null {
  // RIFF....WEBP + chunk（VP8 / VP8L / VP8X 三種格式各自不同）
  if (buf.length < 30) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buf.toString('ascii', 12, 16);

  if (chunk === 'VP8 ') {
    // lossy: 3-byte frame tag + 3-byte sync code，接著 14-bit width/height
    if (buf.readUInt8(23) !== 0x9d || buf.readUInt8(24) !== 0x01 || buf.readUInt8(25) !== 0x2a) return null;
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    // lossless: signature byte 0x2f，接著 14-bit width-1 / height-1（packed）
    if (buf.readUInt8(20) !== 0x2f) return null;
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    // extended: canvas width-1 / height-1 各 24-bit little-endian
    const w = buf.readUIntLE(24, 3) + 1;
    const h = buf.readUIntLE(27, 3) + 1;
    return { width: w, height: h };
  }
  return null;
}

/**
 * 解析圖檔尺寸。認不出格式或檔頭損壞回 null。
 * 只需要前段位元組，呼叫端給整個檔案 buffer 即可。
 */
export function readImageSize(buf: Buffer): ImageSize | null {
  const size = parsePng(buf) ?? parseGif(buf) ?? parseJpeg(buf) ?? parseWebp(buf);
  if (!size) return null;
  // 0 或負數視為解析失敗——填 0 進 data-src-width 等於沒填，反而觸發縮圖問題
  if (!Number.isInteger(size.width) || !Number.isInteger(size.height) || size.width <= 0 || size.height <= 0) return null;
  return size;
}
