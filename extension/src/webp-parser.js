// Parses the RIFF container of an animated WebP file into frames.
// Each frame is repackaged as a standalone still WebP, so the browser's
// still-image decoder can decode it. Compositing happens in player.js.
(function (root) {
  'use strict';

  const ANIMATION_FLAG = 0x02;
  const ALPHA_FLAG = 0x10;

  function fourcc(bytes, offset) {
    return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  }

  function u24(bytes, offset) {
    return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
  }

  function u32(bytes, offset) {
    return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
  }

  function writeU24(bytes, offset, value) {
    bytes[offset] = value & 0xff;
    bytes[offset + 1] = (value >> 8) & 0xff;
    bytes[offset + 2] = (value >> 16) & 0xff;
  }

  function writeU32(bytes, offset, value) {
    writeU24(bytes, offset, value);
    bytes[offset + 3] = (value >>> 24) & 0xff;
  }

  // Returns true when the first bytes of a file show an animated WebP.
  // Needs at least 21 bytes (RIFF header + VP8X flags).
  function isAnimatedWebP(bytes) {
    if (bytes.length < 21) return false;
    return fourcc(bytes, 0) === 'RIFF' &&
      fourcc(bytes, 8) === 'WEBP' &&
      fourcc(bytes, 12) === 'VP8X' &&
      (bytes[20] & ANIMATION_FLAG) !== 0;
  }

  // Iterates the chunks in bytes[start, end).
  function* chunks(bytes, start, end) {
    let offset = start;
    while (offset + 8 <= end) {
      const id = fourcc(bytes, offset);
      const size = u32(bytes, offset + 4);
      const dataStart = offset + 8;
      const dataEnd = dataStart + size;
      if (dataEnd > end) throw new Error('Truncated WebP chunk ' + id);
      yield { id, offset, dataStart, dataEnd };
      offset = dataEnd + (size & 1);
    }
  }

  function vp8lHasAlpha(bytes, dataStart) {
    // VP8L header: 0x2f signature, then 14 bits width-1, 14 bits height-1, 1 bit alpha.
    return ((u32(bytes, dataStart + 1) >>> 28) & 1) === 1;
  }

  // Parses an animated WebP. Returns null for a still or non-WebP file.
  function parseAnimatedWebP(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (!isAnimatedWebP(bytes)) return null;

    const riffEnd = Math.min(bytes.length, 8 + u32(bytes, 4));
    const result = {
      width: 0,
      height: 0,
      loopCount: 0,
      backgroundColor: 0,
      frames: [],
    };

    for (const chunk of chunks(bytes, 12, riffEnd)) {
      if (chunk.id === 'VP8X') {
        result.width = u24(bytes, chunk.dataStart + 4) + 1;
        result.height = u24(bytes, chunk.dataStart + 7) + 1;
      } else if (chunk.id === 'ANIM') {
        result.backgroundColor = u32(bytes, chunk.dataStart);
        result.loopCount = bytes[chunk.dataStart + 4] | (bytes[chunk.dataStart + 5] << 8);
      } else if (chunk.id === 'ANMF') {
        result.frames.push(parseFrame(bytes, chunk, result.frames.length));
      }
    }

    if (result.frames.length === 0) return null;
    markKeyFrames(result);
    return result;
  }

  function parseFrame(bytes, chunk, index) {
    const d = chunk.dataStart;
    const flags = bytes[d + 15];
    const frame = {
      index,
      x: u24(bytes, d) * 2,
      y: u24(bytes, d + 3) * 2,
      width: u24(bytes, d + 6) + 1,
      height: u24(bytes, d + 9) + 1,
      duration: u24(bytes, d + 12),
      blend: (flags & 0x02) === 0,
      disposeToBackground: (flags & 0x01) !== 0,
      hasAlpha: false,
      keyFrame: false,
      alph: null,
      image: null,
    };

    for (const sub of chunks(bytes, d + 16, chunk.dataEnd)) {
      if (sub.id === 'ALPH') {
        frame.alph = sub;
        frame.hasAlpha = true;
      } else if (sub.id === 'VP8 ' || sub.id === 'VP8L') {
        frame.image = sub;
        if (sub.id === 'VP8L' && vp8lHasAlpha(bytes, sub.dataStart)) frame.hasAlpha = true;
      }
    }
    if (!frame.image) throw new Error('WebP frame ' + index + ' has no image data');
    return frame;
  }

  // Same rule as libwebp's anim_decode.c IsKeyFrame(): a key frame does not
  // depend on earlier frames, so decoding can start there after a seek.
  function markKeyFrames(anim) {
    const full = (f) => f.width === anim.width && f.height === anim.height;
    anim.frames.forEach((frame, i) => {
      if (i === 0) {
        frame.keyFrame = true;
      } else if ((!frame.hasAlpha || !frame.blend) && full(frame)) {
        frame.keyFrame = true;
      } else {
        const prev = anim.frames[i - 1];
        frame.keyFrame = prev.disposeToBackground && (full(prev) || prev.keyFrame);
      }
    });
  }

  // Builds a standalone still WebP Blob for one frame. Uses subarrays of
  // the original file, so the frame bytes are not copied.
  function frameToBlob(buffer, frame) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const image = frame.image;
    const imageChunk = bytes.subarray(image.offset, image.dataEnd + ((image.dataEnd - image.dataStart) & 1));

    if (!frame.alph) {
      const header = new Uint8Array(12);
      header.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
      writeU32(header, 4, 4 + imageChunk.length);
      header.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
      return new Blob([header, imageChunk], { type: 'image/webp' });
    }

    const alph = frame.alph;
    const alphChunk = bytes.subarray(alph.offset, alph.dataEnd + ((alph.dataEnd - alph.dataStart) & 1));
    const header = new Uint8Array(30);
    header.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
    writeU32(header, 4, 4 + 18 + alphChunk.length + imageChunk.length);
    header.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
    header.set([0x56, 0x50, 0x38, 0x58], 12); // VP8X
    writeU32(header, 16, 10);
    header[20] = ALPHA_FLAG;
    writeU24(header, 24, frame.width - 1);
    writeU24(header, 27, frame.height - 1);
    return new Blob([header, alphChunk, imageChunk], { type: 'image/webp' });
  }

  const api = { isAnimatedWebP, parseAnimatedWebP, frameToBlob };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.WebPAnim = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
