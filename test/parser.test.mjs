import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const WebPAnim = require('../extension/src/webp-parser.js');
const fixture = (name) => readFileSync(new URL('./.fixtures/' + name, import.meta.url));

test('detects animated WebP from the header bytes', () => {
  assert.equal(WebPAnim.isAnimatedWebP(fixture('heavy.webp').subarray(0, 32)), true);
  assert.equal(WebPAnim.isAnimatedWebP(fixture('still.webp')), false);
  assert.equal(WebPAnim.isAnimatedWebP(new Uint8Array(10)), false);
});

test('parses canvas, frames and timing of the heavy fixture', () => {
  const anim = WebPAnim.parseAnimatedWebP(fixture('heavy.webp'));
  assert.equal(anim.width, 672);
  assert.equal(anim.height, 1024);
  assert.equal(anim.loopCount, 0);
  assert.equal(anim.frames.length, 40);
  assert.ok(anim.frames.every((f) => f.duration === 31));
  assert.equal(anim.frames[0].keyFrame, true);
  // The encoder was told to place a key frame at least every 5 frames.
  const keys = anim.frames.filter((f) => f.keyFrame).length;
  assert.ok(keys >= 8, 'expected key frames, got ' + keys);
  assert.ok(anim.frames.some((f) => !f.keyFrame && f.blend && f.hasAlpha));
});

test('parses dispose and lossless alpha frames', () => {
  const anim = WebPAnim.parseAnimatedWebP(fixture('alpha.webp'));
  assert.equal(anim.frames.length, 12);
  assert.ok(anim.frames.some((f) => f.disposeToBackground));
  assert.ok(anim.frames.every((f) => f.image.id === 'VP8L' && f.hasAlpha));
});

test('returns null for a still image', () => {
  assert.equal(WebPAnim.parseAnimatedWebP(fixture('still.webp')), null);
});

test('rejects a truncated file', () => {
  const bytes = fixture('heavy.webp');
  assert.throws(() => WebPAnim.parseAnimatedWebP(bytes.subarray(0, bytes.length - 100)));
});

test('builds a valid RIFF container for a frame', async () => {
  const bytes = fixture('heavy.webp');
  const anim = WebPAnim.parseAnimatedWebP(bytes);
  for (const frame of [anim.frames[0], anim.frames[1]]) {
    const out = new Uint8Array(await WebPAnim.frameToBlob(bytes, frame).arrayBuffer());
    assert.equal(String.fromCharCode(...out.subarray(0, 4)), 'RIFF');
    assert.equal(new DataView(out.buffer).getUint32(4, true), out.length - 8);
    assert.equal(String.fromCharCode(...out.subarray(8, 12)), 'WEBP');
  }
});

test('stream parser yields frames as the bytes arrive', () => {
  const bytes = fixture('heavy.webp');
  const whole = WebPAnim.parseAnimatedWebP(bytes);
  const parser = new WebPAnim.StreamParser();
  const counts = [];
  // Uneven piece sizes, including pieces smaller than the header.
  for (let offset = 0, i = 0; offset < bytes.length; i++) {
    const size = [7, 5, 3000, 40000, 123457][i % 5];
    parser.push(bytes.subarray(offset, offset + size));
    counts.push(parser.anim.frames.length);
    offset += size;
  }
  assert.equal(parser.status, 'animated');
  assert.equal(parser.finish(), true);
  assert.ok(counts.some((n) => n > 0 && n < 40), 'frames should appear before the end');
  assert.deepEqual(
    parser.anim.frames.map(({ x, y, width, height, keyFrame, blend }) => ({ x, y, width, height, keyFrame, blend })),
    whole.frames.map(({ x, y, width, height, keyFrame, blend }) => ({ x, y, width, height, keyFrame, blend })),
  );
});

test('stream parser stops early for a still image', () => {
  const parser = new WebPAnim.StreamParser();
  parser.push(fixture('still.webp').subarray(0, 64));
  assert.equal(parser.status, 'not-animated');
});

test('stream parser reports a cut-off download', () => {
  const bytes = fixture('heavy.webp');
  const parser = new WebPAnim.StreamParser();
  parser.push(bytes.subarray(0, bytes.length >> 1));
  assert.equal(parser.finish(), false);
  assert.ok(parser.anim.frames.length > 0 && parser.anim.complete);
});
