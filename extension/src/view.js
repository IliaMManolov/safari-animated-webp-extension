// The on-page player that stands in for one <img>: a <webp-player>
// element with a canvas and a control bar in its shadow root. It owns the
// AnimatedWebPPlayer that draws on the canvas.
(function (root) {
  'use strict';

  const PLAY = '▶';
  const PAUSE = '❚❚';

  // The control bar sits inside the page's links. These events stop at
  // the bar so that the controls do not follow the link.
  const BAR_EVENTS = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick'];

  const HTML = `
<style>
  :host { all: initial; }
  canvas { display: block; width: 100%; height: 100%; }
  .bar {
    position: absolute; left: 0; right: 0; bottom: 0;
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px; box-sizing: border-box;
    background: linear-gradient(transparent, rgba(0,0,0,.65));
    color: #fff; font: 12px/1 -apple-system, system-ui, sans-serif;
    opacity: 0; transition: opacity .15s;
    line-height: normal;
  }
  :host(:hover) .bar, .bar:focus-within { opacity: 1; }
  @media (hover: none) { .bar { opacity: .85; } }
  button {
    all: unset; cursor: pointer; color: #fff;
    min-width: 32px; height: 32px; text-align: center;
    border-radius: 6px; font-size: 13px;
  }
  button:hover { background: rgba(255,255,255,.15); }
  button:focus-visible { outline: 2px solid #fff; }
  .scrub { flex: 1; min-width: 40px; margin: 0; accent-color: #fff; }
  .label { min-width: 72px; text-align: right; font-variant-numeric: tabular-nums; }
  .scrub:disabled { opacity: .35; cursor: default; }
  /* Download progress: a thin line along the bottom edge. */
  .loading {
    position: absolute; left: 0; right: 0; bottom: 0; height: 2px;
    background: rgba(0,0,0,.25); pointer-events: none;
    transition: opacity .4s;
  }
  .loading.done { opacity: 0; }
  .fill {
    height: 100%; background: rgba(255,255,255,.8);
    transform-origin: left; transform: scaleX(0); transition: transform .2s;
  }
  @media (hover: none) { button { min-width: 44px; height: 44px; } }
</style>
<canvas></canvas>
<div class="loading"><div class="fill"></div></div>
<div class="bar">
  <button class="play" aria-label="Pause">${PAUSE}</button>
  <input class="scrub" type="range" min="0" max="0" value="0" aria-label="Frame" disabled>
  <span class="label"></span>
  <button class="speed" aria-label="Speed">1×</button>
</div>`;

  // The CSS size of the player. While the image downloads, its box can
  // still be empty, so a missing side comes from the animation's aspect
  // ratio.
  function displaySize(img, cs, anim) {
    const rect = img.getBoundingClientRect();
    const width = rect.width || parseFloat(cs.width) || 0;
    const height = rect.height || parseFloat(cs.height) || 0;
    if (!width && !height) return [anim.width, anim.height];
    if (!height) return [width, width * anim.height / anim.width];
    if (!width) return [height * anim.width / anim.height, height];
    return [width, height];
  }

  class PlayerView {
    // Builds the player for `img`. Nothing changes on the page until
    // attach(). onError runs when a frame cannot be decoded.
    constructor(img, bytes, anim, onError) {
      this.img = img;
      this.anim = anim;
      this.progress = 0;
      this.scrubbing = false;
      this.host = this.createHost();

      const shadow = this.host.attachShadow({ mode: 'open' });
      shadow.innerHTML = HTML;
      const $ = (selector) => shadow.querySelector(selector);
      this.bar = $('.bar');
      this.playBtn = $('.play');
      this.scrub = $('.scrub');
      this.speedBtn = $('.speed');
      this.label = $('.label');
      this.loading = $('.loading');
      this.fill = $('.fill');

      this.player = new AnimatedWebPPlayer($('canvas'), bytes, anim, {
        onFrame: (index) => this.showFrame(index),
        onStateChange: () => this.showState(),
        onError,
      });
      this.observer = new IntersectionObserver((entries) => {
        for (const e of entries) this.player.setVisible(e.isIntersecting);
      });
      this.wireControls();
      this.setProgress(0);
    }

    createHost() {
      const img = this.img;
      const cs = getComputedStyle(img);
      const [width, height] = displaySize(img, cs, this.anim);
      const host = document.createElement('webp-player');
      host.style.cssText = [
        'display:' + (cs.display === 'block' ? 'block' : 'inline-block'),
        'position:relative',
        'width:' + width + 'px',
        'max-width:100%',
        'aspect-ratio:' + width + ' / ' + height,
        'height:auto',
        'margin:' + cs.margin,
        'vertical-align:' + cs.verticalAlign,
        'float:' + cs.cssFloat,
        'line-height:0',
      ].join(';');
      if (img.title) host.title = img.title;
      if (img.alt) {
        host.setAttribute('role', 'img');
        host.setAttribute('aria-label', img.alt);
      }
      return host;
    }

    wireControls() {
      const player = this.player;
      for (const type of BAR_EVENTS) {
        this.bar.addEventListener(type, (e) => {
          e.stopPropagation();
          if (type === 'click' || type === 'dblclick') e.preventDefault();
        });
      }
      this.playBtn.addEventListener('click', () => player.toggle());
      this.speedBtn.addEventListener('click', () => player.cycleSpeed());

      // Dragging the scrub bar pauses playback, and letting go resumes
      // it if it was playing before.
      let wasPlaying = false;
      this.scrub.addEventListener('pointerdown', () => {
        this.scrubbing = true;
        wasPlaying = player.playing;
        player.pause();
      });
      this.scrub.addEventListener('input', () => player.seek(Number(this.scrub.value)));
      const endScrub = () => {
        if (!this.scrubbing) return;
        this.scrubbing = false;
        if (wasPlaying) player.play();
      };
      this.scrub.addEventListener('change', endScrub);
      this.scrub.addEventListener('pointerup', endScrub);
    }

    // Draws the first frame, then puts the player in the page in front of
    // the image and starts playback. The image stays on screen until the
    // first frame is drawn, so the page never shows an empty canvas.
    // Resolves to false when the view was destroyed first.
    async attach() {
      await this.player.seek(0);
      if (this.player.destroyed) return false;
      this.img.before(this.host);
      this.observer.observe(this.host);
      this.player.play();
      return true;
    }

    // `fraction` is the share of the file that has arrived. While the
    // file downloads, the frame count still grows, so the scrub bar stays
    // off and the label shows the download progress.
    setProgress(fraction) {
      this.progress = fraction;
      this.fill.style.transform = 'scaleX(' + fraction + ')';
      if (this.anim.complete) {
        this.scrub.max = String(this.anim.frames.length - 1);
        this.scrub.value = String(Math.max(this.player.current, 0));
        this.scrub.disabled = false;
        this.loading.classList.add('done');
      }
      this.showLabel(Math.max(this.player.current, 0));
    }

    showFrame(index) {
      if (!this.scrubbing) this.scrub.value = String(index);
      this.showLabel(index);
    }

    showLabel(index) {
      this.label.textContent = this.anim.complete
        ? (index + 1) + ' / ' + this.anim.frames.length
        : 'Loading ' + Math.floor(this.progress * 100) + '%';
    }

    showState() {
      const playing = this.player.playing;
      this.playBtn.textContent = playing ? PAUSE : PLAY;
      this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
      this.speedBtn.textContent = this.player.speed + '×';
    }

    destroy() {
      this.player.destroy();
      this.observer.disconnect();
      this.host.remove();
    }
  }

  root.PlayerView = PlayerView;
})(globalThis);
