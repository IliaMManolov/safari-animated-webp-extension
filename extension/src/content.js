// Finds animated WebP images on the page and replaces each one with a
// canvas player. The original <img> stays in the DOM, hidden, so the page
// scripts that use it keep working.
(function () {
  'use strict';

  const ext = globalThis.browser || globalThis.chrome;
  const STATE = new WeakMap(); // img -> { url, player?, host?, observer? }
  const WEBP_URL = /\.webp($|[?#;&/])|[?&](fm|format|f)=webp\b/i;
  const PLAY = '▶';
  const PAUSE = '❚❚';

  let enabled = true;
  const siteKey = 'disabled:' + location.hostname;

  // ---- Fetching ----------------------------------------------------------

  async function fetchBytes(url) {
    try {
      const res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
      if (res.ok) return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      // A cross-origin image without CORS headers fails here. The
      // background script has host permissions and can fetch it.
    }
    return fetchViaBackground(url);
  }

  async function fetchViaBackground(url) {
    const head = await ext.runtime.sendMessage({ type: 'fetch', url });
    if (!head || head.error) throw new Error(head ? head.error : 'No response from background');
    const out = new Uint8Array(head.size);
    for (let offset = 0, i = 0; offset < head.size; i++) {
      const part = await ext.runtime.sendMessage({ type: 'chunk', id: head.id, index: i });
      if (!part || part.error) throw new Error(part ? part.error : 'Missing chunk');
      const bin = atob(part.data);
      for (let j = 0; j < bin.length; j++) out[offset + j] = bin.charCodeAt(j);
      offset += bin.length;
    }
    ext.runtime.sendMessage({ type: 'release', id: head.id });
    return out;
  }

  // ---- Detection ---------------------------------------------------------

  function candidateUrl(img) {
    const url = img.currentSrc || img.src;
    if (!url) return null;
    if (url.startsWith('data:image/webp') || WEBP_URL.test(url)) return url;
    return null;
  }

  async function inspect(img) {
    if (!enabled) return;
    const url = candidateUrl(img);
    const state = STATE.get(img);
    if (!url || (state && state.url === url)) return;
    teardown(img);
    const entry = { url };
    STATE.set(img, entry);

    let bytes;
    try {
      bytes = await fetchBytes(url);
    } catch (err) {
      console.debug('[WebP Player] fetch failed', url, err);
      return;
    }
    if (STATE.get(img) !== entry || !enabled) return;

    if (!WebPAnim.isAnimatedWebP(bytes)) return;
    let anim;
    try {
      anim = WebPAnim.parseAnimatedWebP(bytes);
    } catch (err) {
      console.debug('[WebP Player] parse failed', url, err);
      return;
    }
    if (!anim || anim.frames.length < 2) return;
    mount(img, entry, bytes, anim);
  }

  // ---- Player UI ---------------------------------------------------------

  function mount(img, entry, bytes, anim) {
    const rect = img.getBoundingClientRect();
    const cs = getComputedStyle(img);
    const width = rect.width || parseFloat(cs.width) || anim.width;
    const height = rect.height || parseFloat(cs.height) || anim.height;

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

    const player = new AnimatedWebPPlayer(canvas, bytes, anim, {
      onFrame(index) {
        if (!scrubbing) scrub.value = String(index);
        label.textContent = (index + 1) + ' / ' + anim.frames.length;
      },
      onStateChange() {
        playBtn.textContent = player.playing ? PAUSE : PLAY;
        playBtn.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
        speedBtn.textContent = player.speed + '×';
      },
      onError(err) {
        console.debug('[WebP Player] decode failed, showing the original image', err);
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
    observer.observe(host);

    img.before(host);
    img.dataset.webpPlayerHidden = '';
    img.style.setProperty('display', 'none', 'important');

    entry.player = player;
    entry.host = host;
    entry.observer = observer;
    player.start();
  }

  function teardown(img) {
    const entry = STATE.get(img);
    if (!entry) return;
    STATE.delete(img);
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
          // A changed src means a new image. Wait for the browser to pick
          // the URL up in currentSrc, then inspect it again.
          if (STATE.has(img)) teardown(img);
          if (img.complete) inspect(img);
          else img.addEventListener('load', () => inspect(img), { once: true });
        } else {
          m.addedNodes.forEach((n) => n.nodeType === 1 && scan(n));
          m.removedNodes.forEach((n) => {
            if (n.nodeType !== 1) return;
            const imgs = n.tagName === 'IMG' ? [n] : n.querySelectorAll ? n.querySelectorAll('img') : [];
            imgs.forEach((img) => !img.isConnected && teardown(img));
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
    document.querySelectorAll('img').forEach(teardown);
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
    watch();
    scan(document);
  }

  init();
})();
