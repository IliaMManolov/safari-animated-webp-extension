// Plays a parsed animated WebP on a canvas.
// The browser decodes each frame as a still image off the main thread
// (createImageBitmap). The player composites the frames in order, so each
// frame is decoded once and only a few decoded frames exist at a time.
//
// Each frame's still WebP is built once and kept, because the player
// decodes every frame again on every loop. A new Blob for each decode
// gave Safari about 30 new Blobs a second per player to free, and Safari
// frees Blob memory only when garbage collection runs.
(function (root) {
  'use strict';

  const DECODE_AHEAD = 6;
  const SPEEDS = [0.25, 0.5, 1, 2];

  // Browsers show very short frame durations as 100 ms. Do the same, so
  // the animation keeps the speed that the page author saw.
  function frameDuration(frame) {
    return frame.duration <= 10 ? 100 : frame.duration;
  }

  class AnimatedWebPPlayer {
    constructor(canvas, buffer, anim, options = {}) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.buffer = buffer;
      this.anim = anim;
      this.frames = anim.frames;
      this.onFrame = options.onFrame || (() => {});
      this.onStateChange = options.onStateChange || (() => {});
      this.onError = options.onError || (() => {});

      canvas.width = anim.width;
      canvas.height = anim.height;

      this.speed = 1;
      this.playing = false;
      this.destroyed = false;
      this.visible = true;
      this.seeking = false; // A seek owns the canvas. Ticks wait for it.
      this.current = -1; // Index of the frame shown on the canvas.
      this.pendingDispose = null; // Frame to clear before drawing the next one.
      this.loopsDone = 0;
      this.nextDue = 0;
      this.rafId = 0;
      this.seekToken = 0;
      // frame index -> { promise, bitmap }. bitmap is null until decoded.
      this.decodes = new Map();
      // frame index -> the frame as a still WebP Blob. Built once per frame.
      this.blobs = [];
      this.blobCount = 0;
      this.tick = this.tick.bind(this);
    }

    play() {
      if (this.destroyed || this.playing) return;
      if (this.anim.loopCount > 0 && this.loopsDone >= this.anim.loopCount) this.loopsDone = 0;
      this.playing = true;
      this.restartClock();
      this.schedule();
      this.onStateChange();
    }

    pause() {
      if (!this.playing) return;
      this.playing = false;
      this.unschedule();
      this.onStateChange();
    }

    toggle() {
      if (this.playing) this.pause();
      else this.play();
    }

    setSpeed(speed) {
      this.speed = speed;
      this.onStateChange();
    }

    cycleSpeed() {
      const i = SPEEDS.indexOf(this.speed);
      this.setSpeed(SPEEDS[(i + 1) % SPEEDS.length]);
    }

    // Pauses drawing while the canvas is off screen. Playback time does
    // not advance while hidden.
    setVisible(visible) {
      if (this.visible === visible) return;
      this.visible = visible;
      if (visible && this.playing) {
        this.nextDue = performance.now();
        this.schedule();
      }
    }

    destroy() {
      this.destroyed = true;
      this.pause();
      this.releaseAll();
      this.buffer = null;
      this.blobs = [];
    }

    schedule() {
      if (!this.rafId && this.playing && this.visible && !this.seeking && !this.destroyed) {
        this.rafId = requestAnimationFrame(this.tick);
      }
    }

    unschedule() {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }

    // The frame on the canvas starts its full duration from now.
    restartClock() {
      this.nextDue = performance.now() + frameDuration(this.frames[Math.max(this.current, 0)]) / this.speed;
    }

    // Returns the frame after i, or -1 while that frame is still
    // downloading. anim.frames grows while the file downloads, and
    // anim.complete turns true at the end.
    nextIndex(i) {
      if (i + 1 < this.frames.length) return i + 1;
      return this.anim.complete ? 0 : -1;
    }

    // Starts decoding frame `index` once. Resolves to the bitmap, or to
    // null when the frame was released before the decode finished.
    decode(index) {
      let slot = this.decodes.get(index);
      if (!slot) {
        slot = { promise: null, bitmap: null };
        slot.promise = createImageBitmap(this.frameBlob(index)).then((bitmap) => {
          if (this.decodes.get(index) !== slot) {
            bitmap.close();
            return null;
          }
          slot.bitmap = bitmap;
          return bitmap;
        });
        slot.promise.catch((err) => this.fail(err));
        this.decodes.set(index, slot);
      }
      return slot.promise;
    }

    // The still WebP for frame `index`. When every frame has one and the
    // download is over, the player lets go of the file bytes, because the
    // Blobs hold the same bytes.
    frameBlob(index) {
      let blob = this.blobs[index];
      if (!blob) {
        blob = WebPAnim.frameToBlob(this.buffer, this.frames[index]);
        this.blobs[index] = blob;
        this.blobCount++;
      }
      if (this.buffer && this.anim.complete && this.blobCount === this.frames.length) this.buffer = null;
      return blob;
    }

    release(index) {
      const slot = this.decodes.get(index);
      if (slot && slot.bitmap) slot.bitmap.close();
      this.decodes.delete(index);
    }

    releaseAll() {
      for (const index of [...this.decodes.keys()]) this.release(index);
    }

    // Starts decodes for the frames after `from`.
    prefetch(from = this.current) {
      let i = from;
      for (let n = 0; n < Math.min(DECODE_AHEAD, this.frames.length - 1); n++) {
        i = this.nextIndex(i);
        if (i < 0) break;
        this.decode(i);
      }
    }

    fail(err) {
      if (this.destroyed) return;
      this.destroy();
      this.onError(err);
    }

    // Draws frame `index` over the canvas state. The caller makes sure
    // that the canvas holds frame index - 1, or that `index` is a key frame.
    composite(index, bitmap) {
      const frame = this.frames[index];
      const ctx = this.ctx;
      if (this.pendingDispose) {
        const d = this.pendingDispose;
        ctx.clearRect(d.x, d.y, d.width, d.height);
        this.pendingDispose = null;
      }
      if (frame.keyFrame) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (!frame.blend) ctx.clearRect(frame.x, frame.y, frame.width, frame.height);
      ctx.drawImage(bitmap, frame.x, frame.y);
      if (frame.disposeToBackground) this.pendingDispose = frame;
      this.current = index;
      this.release(index);
    }

    tick(now) {
      this.rafId = 0;
      if (!this.playing || this.destroyed) return;

      let drew = false;
      // Composite every frame that is due and decoded. When decoding falls
      // behind, playback waits for it; frames are never skipped, because
      // each frame builds on the one before.
      while (now >= this.nextDue) {
        const next = this.nextIndex(this.current);
        // The next frame is still downloading. Wait for it.
        if (next < 0) {
          this.nextDue = now;
          break;
        }
        const wraps = next === 0 && this.current >= 0;
        if (wraps && this.anim.loopCount > 0 && this.loopsDone + 1 >= this.anim.loopCount) {
          this.loopsDone++;
          this.pause();
          break;
        }
        const slot = this.decodes.get(next);
        const bitmap = slot && slot.bitmap;
        if (!bitmap) {
          this.decode(next);
          break;
        }
        if (wraps) this.loopsDone++;
        this.composite(next, bitmap);
        drew = true;
        this.nextDue += frameDuration(this.frames[next]) / this.speed;
        // After a long stall, do not rush through the backlog.
        if (now - this.nextDue > 250) this.nextDue = now;
      }

      this.prefetch();
      if (drew) this.onFrame(this.current);
      this.schedule();
    }

    // Shows frame `target`. Playback keeps its play or pause state and
    // continues from the target. A newer seek replaces an older one.
    async seek(target) {
      target = Math.max(0, Math.min(target, this.frames.length - 1));
      const token = ++this.seekToken;
      this.seeking = true;
      this.unschedule();

      const start = this.seekStart(target);
      if (start !== this.current + 1) {
        this.releaseAll();
        this.pendingDispose = null;
      }

      try {
        for (let i = start; i <= target; i++) {
          this.prefetch(i - 1);
          const bitmap = await this.decode(i);
          if (token !== this.seekToken || this.destroyed || !bitmap) return;
          this.composite(i, bitmap);
        }
      } catch (err) {
        this.fail(err);
        return;
      }

      this.seeking = false;
      this.onFrame(this.current);
      this.prefetch();
      this.restartClock();
      this.schedule();
    }

    // The first frame to composite for a seek to `target`. Each frame
    // builds on the one before, so that is the frame after the current
    // one, or the nearest key frame at or before the target if that is
    // less work.
    seekStart(target) {
      let key = target;
      while (key > 0 && !this.frames[key].keyFrame) key--;
      const fromCurrent = this.current >= 0 && this.current <= target;
      return fromCurrent && this.current + 1 > key ? this.current + 1 : key;
    }
  }

  root.AnimatedWebPPlayer = AnimatedWebPPlayer;
})(globalThis);
