import { describe, it, expect } from 'vitest';
import { readImageSize, mimeTypeForImage } from '../imageSize.js';

/** 造一張最小合法 PNG 檔頭（只需 IHDR 前 24 bytes 即可解析） */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8); // IHDR length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

function gifHeader(width: number, height: number, sig = 'GIF89a'): Buffer {
  const buf = Buffer.alloc(10);
  buf.write(sig, 0, 'ascii');
  buf.writeUInt16LE(width, 6);
  buf.writeUInt16LE(height, 8);
  return buf;
}

/** SOI + 一段 APP0 + SOF0，模擬真實 JPEG 需要跳段才找到 SOF 的情形 */
function jpegWithApp0(width: number, height: number): Buffer {
  const app0Len = 16;
  const buf = Buffer.alloc(2 + 2 + app0Len + 2 + 2 + 1 + 2 + 2);
  let o = 0;
  buf.writeUInt16BE(0xffd8, o); o += 2;          // SOI
  buf.writeUInt16BE(0xffe0, o); o += 2;          // APP0
  buf.writeUInt16BE(app0Len, o); o += app0Len;   // APP0 length（含自身 2 bytes）
  buf.writeUInt16BE(0xffc0, o); o += 2;          // SOF0
  buf.writeUInt16BE(11, o); o += 2;              // segment length
  buf.writeUInt8(8, o); o += 1;                  // precision
  buf.writeUInt16BE(height, o); o += 2;
  buf.writeUInt16BE(width, o); o += 2;
  return buf;
}

describe('readImageSize', () => {
  it('解析 PNG 尺寸', () => {
    expect(readImageSize(pngHeader(1536, 1400))).toEqual({ width: 1536, height: 1400 });
  });

  it('解析 GIF 尺寸（87a 與 89a 都支援）', () => {
    expect(readImageSize(gifHeader(320, 240))).toEqual({ width: 320, height: 240 });
    expect(readImageSize(gifHeader(1, 1, 'GIF87a'))).toEqual({ width: 1, height: 1 });
  });

  it('解析 JPEG 尺寸——需跳過 APP0 段才找到 SOF0', () => {
    expect(readImageSize(jpegWithApp0(1898, 813))).toEqual({ width: 1898, height: 813 });
  });

  it('解析 WebP（VP8X extended）尺寸', () => {
    const buf = Buffer.alloc(30);
    buf.write('RIFF', 0, 'ascii');
    buf.write('WEBP', 8, 'ascii');
    buf.write('VP8X', 12, 'ascii');
    buf.writeUIntLE(799, 24, 3);  // canvas width - 1
    buf.writeUIntLE(599, 27, 3);  // canvas height - 1
    expect(readImageSize(buf)).toEqual({ width: 800, height: 600 });
  });

  it('非圖片內容回 null（不可回 0，填 0 等於沒填）', () => {
    expect(readImageSize(Buffer.from('not an image at all, just text'))).toBeNull();
    expect(readImageSize(Buffer.alloc(0))).toBeNull();
  });

  it('尺寸為 0 的損壞檔頭視為解析失敗', () => {
    expect(readImageSize(pngHeader(0, 100))).toBeNull();
    expect(readImageSize(pngHeader(100, 0))).toBeNull();
  });

  it('截斷的檔頭不會拋錯', () => {
    expect(() => readImageSize(pngHeader(10, 10).subarray(0, 20))).not.toThrow();
    expect(() => readImageSize(Buffer.from([0xff, 0xd8, 0xff]))).not.toThrow();
  });
});

describe('mimeTypeForImage', () => {
  it('依副檔名回對應 MIME type（大小寫不敏感）', () => {
    expect(mimeTypeForImage('a.png')).toBe('image/png');
    expect(mimeTypeForImage('a.PNG')).toBe('image/png');
    expect(mimeTypeForImage('shot.jpg')).toBe('image/jpeg');
    expect(mimeTypeForImage('shot.jpeg')).toBe('image/jpeg');
    expect(mimeTypeForImage('x.gif')).toBe('image/gif');
    expect(mimeTypeForImage('x.webp')).toBe('image/webp');
  });

  it('未知副檔名回 octet-stream', () => {
    expect(mimeTypeForImage('report.pdf')).toBe('application/octet-stream');
    expect(mimeTypeForImage('noext')).toBe('application/octet-stream');
  });
});
