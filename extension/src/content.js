// Finds animated WebP images on the page and replaces each one with a
// canvas player. The original <img> stays in the DOM, hidden, so the page
// scripts that use it keep working.
(function () {
  'use strict';

  const ext = globalThis.browser || globalThis.chrome;
  const STATE = new WeakMap(); // img -> { url, player?, host?, observer? }
  // src values that the extension itself set. The observer skips them.
  const OWN_SRC = new WeakMap(); // img -> src
  // A 1x1 transparent GIF. It replaces the src of a hidden image that is
  // still downloading, so Safari stops its own copy of the download.
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const WEBP_URL = /\.webp($|[?#;&/])|[?&](fm|format|f)=webp\b/i;
  const PLAY = '▶';
  const PAUSE = '❚❚';

  let enabled = true;
  // Visible in the page's Web Inspector console. Filter by "WebP Player".
  const log = (...args) => console.info('[WebP Player]', ...args);
  const siteKey = 'disabled:' + location.hostname;

  // ---- Fetching ----------------------------------------------------------

  // Yields the file in pieces while it downloads. Breaking out of the
  // loop that reads it cancels the download.
  async function* streamBytes(url) {
    let res = null;
    try {
      res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
      if (!res.ok) {
        log('page fetch returned HTTP ' + res.status, url);
        res = null;
      }
    } catch (err) {
      // A cross-origin image without CORS headers fails here. The
      // background script has host permissions and can fetch it.
      log('page fetch failed, asking the background script', String(err));
    }
    if (res && res.body) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          yield value;
        }
      } finally {
        reader.cancel().catch(() => {});
      }
    }
    yield* streamViaBackground(url);
  }

  async function* streamViaBackground(url) {
    const head = await ext.runtime.sendMessage({ type: 'open', url });
    if (!head || head.error) throw new Error(head ? head.error : 'No response from background');
    let done = false;
    try {
      while (!done) {
        const part = await ext.runtime.sendMessage({ type: 'read', id: head.id });
        if (!part || part.error) throw new Error(part ? part.error : 'Missing data from background');
        done = part.done;
        const bin = atob(part.data);
        const out = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
        if (out.length) yield out;
      }
    } finally {
      if (!done) ext.runtime.sendMessage({ type: 'release', id: head.id });
    }
  }

  // ---- Detection ---------------------------------------------------------

  function candidateUrl(img) {
    const url = img.currentSrc || img.src;
    if (!url || url === BLANK) return null;
    if (url.startsWith('data:image/webp') || WEBP_URL.test(url)) return url;
    return null;
  }

  // Downloads the file and starts the player as soon as the first frame
  // is in. The rest of the frames load while it plays.
  async function inspect(img) {
    if (!enabled) return;
    const url = candidateUrl(img);
    const state = STATE.get(img);
    if (!url || (state && state.url === url)) return;
    teardown(img);
    const entry = { url };
    STATE.set(img, entry);

    log('checking', url);
    const parser = new WebPAnim.StreamParser();
    try {
      for await (const piece of streamBytes(url)) {
        if (STATE.get(img) !== entry || !enabled) return;
        const added = parser.push(piece);
        if (parser.status === 'not-animated') {
          log('not an animated WebP', url);
          return;
        }
        if (!entry.player && parser.anim.frames.length) {
          log(`playing while the file downloads (${parser.anim.width}x${parser.anim.height})`, url);
          mount(img, entry, parser.buffer, parser.anim);
        } else if (added && entry.update) {
          entry.update();
        }
      }
    } catch (err) {
      log('download or parse stopped early', url, err);
      if (!entry.player) return;
    }
    if (STATE.get(img) !== entry) return;
    const whole = parser.finish();
    const frames = parser.anim.frames.length;
    if (parser.status !== 'animated' || !frames) return;
    log(`downloaded ${frames} frames` + (whole ? '' : ' (file incomplete, playing what arrived)'), url);
    if (!entry.player && frames > 1) mount(img, entry, parser.buffer, parser.anim);
    else if (entry.update) entry.update();
  }

  // ---- Player UI ---------------------------------------------------------

  function mount(img, entry, bytes, anim) {
    const rect = img.getBoundingClientRect();
    const cs = getComputedStyle(img);
    // While the image downloads, its box can still be empty. Fill a
    // missing side from the animation's own aspect ratio.
    let width = rect.width || parseFloat(cs.width) || 0;
    let height = rect.height || parseFloat(cs.height) || 0;
    if (!width && !height) {
      width = anim.width;
      height = anim.height;
    } else if (!height) {
      height = width * anim.height / anim.width;
    } else if (!width) {
      width = height * anim.width / anim.height;
    }

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

    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = PLAYER_HTML;
    const canvas = shadow.querySelector('canvas');
    const bar = shadow.querySelector('.bar');
    const playBtn = shadow.querySelector('.play');
    const scrub = shadow.querySelector('.scrub');
    const speedBtn = shadow.querySelector('.speed');
    const label = shadow.querySelector('.label');
    scrub.max = String(anim.frames.length - 1);

    const showLabel = (index) => {
      label.textContent = (index + 1) + ' / ' + anim.frames.length + (anim.complete ? '' : '\u2026');
    };
    const player = new AnimatedWebPPlayer(canvas, bytes, anim, {
      onFrame(index) {
        if (!scrubbing) scrub.value = String(index);
        showLabel(index);
      },
      onStateChange() {
        playBtn.textContent = player.playing ? PAUSE : PLAY;
        playBtn.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
        speedBtn.textContent = player.speed + '×';
      },
      onError(err) {
        log('could not decode a frame, showing the original image', err);
        teardown(img);
      },
    });

    // The player sits inside the page's links. Stop clicks on the controls
    // from reaching them.
    for (const type of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'dblclick']) {
      bar.addEventListener(type, (e) => {
        e.stopPropagation();
        if (type === 'click' || type === 'dblclick') e.preventDefault();
      });
    }
    playBtn.addEventListener('click', () => player.toggle());
    speedBtn.addEventListener('click', () => player.cycleSpeed());

    let scrubbing = false;
    let wasPlaying = false;
    scrub.addEventListener('pointerdown', () => {
      scrubbing = true;
      wasPlaying = player.playing;
      player.pause();
    });
    scrub.addEventListener('input', () => player.seek(Number(scrub.value)));
    const endScrub = () => {
      if (!scrubbing) return;
      scrubbing = false;
      if (wasPlaying) player.play();
    };
    scrub.addEventListener('change', endScrub);
    scrub.addEventListener('pointerup', endScrub);

    const observer = new IntersectionObserver((entries) => {
      for (const e of entries) player.setVisible(e.isIntersecting);
    });
    entry.player = player;
    entry.observer = observer;
    // Called when more frames finish downloading.
    entry.update = () => {
      scrub.max = String(anim.frames.length - 1);
      showLabel(Math.max(player.current, 0));
    };

    // Draw the first frame before the swap. The original image stays on
    // screen until then, so the page never shows an empty canvas.
    player.seek(0).then(() => {
      if (STATE.get(img) !== entry || player.destroyed) return;
      img.before(host);
      img.dataset.webpPlayerHidden = '';
      img.style.setProperty('display', 'none', 'important');
      entry.host = host;
      observer.observe(host);
      player.play();
      // The extension has its own copy of the file now. If Safari is still
      // downloading the image, stop that second download.
      if (!img.complete) {
        entry.savedSrc = img.getAttribute('src');
        entry.savedSrcset = img.getAttribute('srcset');
        OWN_SRC.set(img, BLANK);
        img.removeAttribute('srcset');
        img.setAttribute('src', BLANK);
      }
    });
  }

  // restoreSrc puts back an src that the extension replaced. It is false
  // when the page itself changed the src or removed the image.
  function teardown(img, restoreSrc = true) {
    const entry = STATE.get(img);
    if (!entry) return;
    STATE.delete(img);
    if (entry.savedSrc !== undefined && restoreSrc) {
      OWN_SRC.set(img, entry.savedSrc);
      if (entry.savedSrcset !== null) img.setAttribute('srcset', entry.savedSrcset);
      if (entry.savedSrc === null) img.removeAttribute('src');
      else img.setAttribute('src', entry.savedSrc);
    }
    if (entry.player) entry.player.destroy();
    if (entry.observer) entry.observer.disconnect();
    if (entry.host) entry.host.remove();
    if ('webpPlayerHidden' in img.dataset) {
      delete img.dataset.webpPlayerHidden;
      img.style.removeProperty('display');
    }
  }

  const PLAYER_HTML = `
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
  .label { min-width: 64px; text-align: right; font-variant-numeric: tabular-nums; }
  @media (hover: none) { button { min-width: 44px; height: 44px; } }
</style>
<canvas></canvas>
<div class="bar">
  <button class="play" aria-label="Pause">${PAUSE}</button>
  <input class="scrub" type="range" min="0" value="0" aria-label="Frame">
  <span class="label"></span>
  <button class="speed" aria-label="Speed">1×</button>
</div>`;

  // ---- Page scanning -----------------------------------------------------

  function scan(root) {
    if (root.tagName === 'IMG') inspect(root);
    if (root.querySelectorAll) root.querySelectorAll('img').forEach(inspect);
  }

  function watch() {
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes') {
          const img = m.target;
          if (img.tagName !== 'IMG') continue;
          if (OWN_SRC.has(img) && OWN_SRC.get(img) === img.getAttribute('src')) continue;
          OWN_SRC.delete(img);
          // A changed src means a new image. Wait for the browser to pick
          // the URL up in currentSrc, then inspect it again.
          if (STATE.has(img)) teardown(img, false);
          if (img.complete) inspect(img);
          else img.addEventListener('load', () => inspect(img), { once: true });
        } else {
          m.addedNodes.forEach((n) => n.nodeType === 1 && scan(n));
          m.removedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            const imgs = n.tagName === 'IMG' ? [n] : n.querySelectorAll ? n.querySelectorAll('img') : [];
            imgs.forEach((img) => !img.isConnected && teardown(img, false));
          });
        }
      }
    }).observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['src', 'srcset'],
    });
  }

  function disableAll() {
    document.querySelectorAll('img').forEach((img) => teardown(img));
  }

  async function init() {
    try {
      const stored = await ext.storage.local.get(siteKey);
      enabled = !stored[siteKey];
    } catch (err) {
      enabled = true;
    }
    ext.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !(siteKey in changes)) return;
      enabled = !changes[siteKey].newValue;
      if (enabled) scan(document);
      else disableAll();
    });
    log('running on ' + location.hostname + (enabled ? '' : ' (turned off for this site)'));
    watch();
    scan(document);
  }

  init();
})();
