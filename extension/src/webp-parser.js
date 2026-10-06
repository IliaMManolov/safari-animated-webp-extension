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

  // Reads the chunk header at offset. `next` is the offset of the chunk
  // after it: chunk data is padded to an even size.
  function readChunk(bytes, offset) {
    const id = fourcc(bytes, offset);
    const size = u32(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + size;
    return { id, offset, dataStart, dataEnd, next: dataEnd + (size & 1) };
  }

  // Iterates the chunks in bytes[start, end).
  function* chunks(bytes, start, end) {
    for (let offset = start; offset + 8 <= end;) {
      const chunk = readChunk(bytes, offset);
      if (chunk.dataEnd > end) throw new Error('Truncated WebP chunk ' + chunk.id);
      yield chunk;
      offset = chunk.next;
    }
  }

  function vp8lHasAlpha(bytes, dataStart) {
    // VP8L header: 0x2f signature, then 14 bits width-1, 14 bits height-1, 1 bit alpha.
    return ((u32(bytes, dataStart + 1) >>> 28) & 1) === 1;
  }

  // Parses an animated WebP while it downloads. Call push() with each
  // block of bytes as it arrives, and finish() when the download ends.
  //
  // `anim` is shared with the player and grows in place: each frame
  // appears in anim.frames as soon as all of its bytes are in, and
  // anim.complete turns true in finish(). So playback can start early.
  class StreamParser {
    constructor() {
      this.status = 'pending'; // 'pending' | 'animated' | 'not-animated'
      this.buffer = null; // The whole file, filled in as bytes arrive.
      this.length = 0; // Bytes received so far.
      this.riffEnd = 0;
      this.pos = 12; // Start of the next chunk to read.
      this.head = []; // Bytes that arrive before the header is complete.
      this.anim = {
        width: 0,
        height: 0,
        loopCount: 0,
        frames: [],
        complete: false,
      };
    }

    push(chunk) {
      if (this.status === 'not-animated') return;
      if (!this.buffer) {
        for (const b of chunk) this.head.push(b);
        if (this.head.length < 21) return;
        const head = Uint8Array.from(this.head);
        this.head = null;
        if (!isAnimatedWebP(head)) {
          this.status = 'not-animated';
          return;
        }
        this.status = 'animated';
        this.riffEnd = 8 + u32(head, 4);
        this.buffer = new Uint8Array(this.riffEnd);
        chunk = head;
      }
      const room = this.riffEnd - this.length;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      this.buffer.set(part, this.length);
      this.length += part.length;
      this.scan();
    }

    // The share of the file that has arrived, from 0 to 1.
    get progress() {
      return this.riffEnd ? this.length / this.riffEnd : 0;
    }

    // Reads every chunk that has fully arrived.
    scan() {
      const bytes = this.buffer;
      while (this.pos + 8 <= this.length) {
        const chunk = readChunk(bytes, this.pos);
        if (chunk.dataEnd > this.riffEnd) throw new Error('WebP chunk ' + chunk.id + ' runs past the end of the file');
        if (chunk.dataEnd > this.length) break;
        const d = chunk.dataStart;
        if (chunk.id === 'VP8X') {
          this.anim.width = u24(bytes, d + 4) + 1;
          this.anim.height = u24(bytes, d + 7) + 1;
        } else if (chunk.id === 'ANIM') {
          this.anim.loopCount = bytes[d + 4] | (bytes[d + 5] << 8);
        } else if (chunk.id === 'ANMF') {
          const frames = this.anim.frames;
          const frame = parseFrame(bytes, chunk, frames.length);
          frame.keyFrame = isKeyFrame(this.anim, frame, frames[frames.length - 1]);
          frames.push(frame);
        }
        this.pos = chunk.next;
      }
    }

    // Call when the download ends. Returns true when the whole file arrived.
    finish() {
      this.anim.complete = true;
      return this.status === 'animated' && this.length === this.riffEnd;
    }
  }

  // Parses a whole animated WebP from a Uint8Array. Returns null for a
  // still or non-WebP file.
  function parseAnimatedWebP(bytes) {
    const parser = new StreamParser();
    parser.push(bytes);
    if (parser.status !== 'animated') return null;
    if (!parser.finish()) throw new Error('Truncated WebP file');
    return parser.anim.frames.length ? parser.anim : null;
  }

  function parseFrame(bytes, chunk, index) {
    const d = chunk.dataStart;
    const flags = bytes[d + 15];
    const frame = {
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
  function isKeyFrame(anim, frame, prev) {
    const full = (f) => f.width === anim.width && f.height === anim.height;
    if (!prev) return true;
    if ((!frame.hasAlpha || !frame.blend) && full(frame)) return true;
    return prev.disposeToBackground && (full(prev) || prev.keyFrame);
  }

  // Builds a standalone still WebP Blob for one frame of `bytes` (the
  // whole file). Uses subarrays of the file, so the frame bytes are not
  // copied.
  function frameToBlob(bytes, frame) {
    const image = frame.image;
    const imageChunk = bytes.subarray(image.offset, image.next);

    if (!frame.alph) {
      const header = new Uint8Array(12);
      header.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
      writeU32(header, 4, 4 + imageChunk.length);
      header.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
      return new Blob([header, imageChunk], { type: 'image/webp' });
    }

    const alph = frame.alph;
    const alphChunk = bytes.subarray(alph.offset, alph.next);
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

  root.WebPAnim = { isAnimatedWebP, parseAnimatedWebP, frameToBlob, StreamParser };
})(globalThis);
