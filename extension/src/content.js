// Finds animated WebP images on the page and replaces each one with a
// canvas player. The original <img> stays in the DOM, hidden, so the page
// scripts that use it keep working.
(function () {
  'use strict';

  const ext = globalThis.browser || globalThis.chrome;
  const STATE = new WeakMap(); // img -> { url, view?, override? }
  // src values that the extension itself set. The observer skips them.
  const OWN_SRC = new WeakMap(); // img -> src
  // A 1x1 transparent GIF. It replaces the src of a hidden image that is
  // still downloading, so Safari stops its own copy of the download.
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const WEBP_URL = /\.webp($|[?#;&/])|[?&](fm|format|f)=webp\b/i;

  let enabled = true;
  // Visible in the page's Web Inspector console. Filter by "WebP Player".
  const log = (...args) => console.info('[WebP Player]', ...args);
  const siteKey = WebPSettings.siteKey(location.hostname);

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

  // The background script sends the file over a port, one message per
  // piece: { data } in base64, then { done } or { error }. Closing the
  // port cancels the download.
  async function* streamViaBackground(url) {
    const port = ext.runtime.connect({ name: 'download' });
    const inbox = [];
    let wake = null;
    const deliver = (msg) => {
      inbox.push(msg);
      if (wake) wake();
    };
    port.onMessage.addListener(deliver);
    port.onDisconnect.addListener(() => deliver({ error: 'The background script closed the download' }));
    port.postMessage({ url });
    try {
      for (;;) {
        while (!inbox.length) await new Promise((resolve) => { wake = resolve; });
        const msg = inbox.shift();
        if (msg.error) throw new Error(msg.error);
        if (msg.done) return;
        yield fromBase64(msg.data);
      }
    } finally {
      port.disconnect();
    }
  }

  function fromBase64(text) {
    const bin = atob(text);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
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
        parser.push(piece);
        if (parser.status === 'not-animated') {
          log('not an animated WebP', url);
          return;
        }
        if (entry.view) {
          entry.view.setProgress(parser.progress);
        } else if (parser.anim.frames.length) {
          log(`playing while the file downloads (${parser.anim.width}x${parser.anim.height})`, url);
          mount(img, entry, parser);
        }
      }
    } catch (err) {
      log('download or parse stopped early', url, err);
    }
    if (STATE.get(img) !== entry || !entry.view) return;
    const whole = parser.finish();
    log(`downloaded ${parser.anim.frames.length} frames` + (whole ? '' : ' (file incomplete, playing what arrived)'), url);
    entry.view.setProgress(1);
  }

  function mount(img, entry, parser) {
    entry.view = new PlayerView(img, parser.buffer, parser.anim, (err) => {
      log('could not decode a frame, showing the original image', err);
      teardown(img);
    });
    entry.view.attach().then((attached) => {
      if (attached) entry.override = new ImageOverride(img);
    });
  }

  function teardown(img) {
    const entry = STATE.get(img);
    if (!entry) return;
    STATE.delete(img);
    if (entry.override) entry.override.restore();
    if (entry.view) entry.view.destroy();
  }

  // ---- The hidden original image -----------------------------------------

  // Hides the original image while the player stands in for it. The
  // extension has its own copy of the file, so if Safari is still
  // downloading the image, this also stops that second download.
  class ImageOverride {
    constructor(img) {
      this.img = img;
      this.saved = null; // The src and srcset that the blank replaced.
      img.style.setProperty('display', 'none', 'important');
      if (!img.complete) {
        this.saved = { src: img.getAttribute('src'), srcset: img.getAttribute('srcset') };
        OWN_SRC.set(img, BLANK);
        img.removeAttribute('srcset');
        img.setAttribute('src', BLANK);
      }
    }

    // Shows the image again. The saved src comes back only while the
    // blank is still in place and the image is still in the page. If the
    // page set a new src or srcset, or removed the image, the page's
    // choice stays.
    restore() {
      const img = this.img;
      img.style.removeProperty('display');
      const blankInPlace = img.getAttribute('src') === BLANK && !img.hasAttribute('srcset');
      if (!this.saved || !blankInPlace || !img.isConnected) return;
      const { src, srcset } = this.saved;
      OWN_SRC.set(img, src);
      if (srcset !== null) img.setAttribute('srcset', srcset);
      if (src === null) img.removeAttribute('src');
      else img.setAttribute('src', src);
    }
  }

  // ---- Page scanning -----------------------------------------------------

  function scan(root) {
    if (root.tagName === 'IMG') inspect(root);
    if (root.querySelectorAll) root.querySelectorAll('img').forEach(inspect);
  }

  function imagesIn(node) {
    if (node.nodeType !== 1) return [];
    if (node.tagName === 'IMG') return [node];
    return node.querySelectorAll('img');
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
          teardown(img);
          if (img.complete) inspect(img);
          else img.addEventListener('load', () => inspect(img), { once: true });
        } else {
          m.addedNodes.forEach((n) => n.nodeType === 1 && scan(n));
          m.removedNodes.forEach((n) => {
            for (const img of imagesIn(n)) if (!img.isConnected) teardown(img);
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
    log('running on ' + location.hostname + (enabled ? '' : ' (turned off for this site)'));
    watch();
    scan(document);
  }

  init();
})();
