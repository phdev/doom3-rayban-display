// gates/inspect_render/png-encode.mjs — worker-authored, dependency-free PNG writer.
//
// Fixed settings: 8-bit RGBA (color type 6), filter byte 0 (None) on every
// scanline, zlib deflate level 9. Node builtins only (node:zlib) — NO npm
// dependency (this is NOT a vendored package; it is code this packet authored,
// so there is no license / NOTICE.md impact).
//
// The PNG is an ARTIFACT for human / agent-vision eyeballing ONLY. The gate hash
// (H1/H2 in run_gate.sh) is computed over the RAW padding-stripped pixels the
// engine published, NEVER over this file. So any zlib-version / deflate variance
// in the encoded bytes is intentionally OUTSIDE the gate's trust surface — the
// PNG can differ byte-for-byte across zlib versions and the gate is unaffected.

import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * Encode an RGBA image to a PNG Buffer.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba  length width*height*4, RGBA row-major, no padding.
 * @returns {Buffer} PNG bytes.
 */
export function encodePNG(width, height, rgba) {
  if (rgba.length !== width * height * 4) {
    throw new Error(`encodePNG: rgba length ${rgba.length} != expected ${width * height * 4}`);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type: RGBA (truecolour with alpha)
  ihdr[10] = 0; // compression method (deflate)
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    src.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}
