import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.webp': 'image/webp', '.png': 'image/png' };
let server, base, browser;

before(async () => {
  server = createServer(async (req, res) => {
    let path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
    // /slow/... serves the file at about 250 KB/s, to test playback during
    // a download.
    if (path.startsWith('/slow/')) {
      path = path.slice(5);
      try {
        const body = await readFile(join(root, path));
        res.writeHead(200, { 'content-type': types[extname(path)], 'cache-control': 'no-store' });
        for (let i = 0; i < body.length && !res.destroyed; i += 8 * 1024) {
          res.write(body.subarray(i, i + 8 * 1024));
          await new Promise((r) => setTimeout(r, 30));
        }
        res.end();
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    try {
      const body = await readFile(join(root, path));
      res.writeHead(200, { 'content-type': types[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
});

async function playerPage() {
  const page = await browser.newPage();
  await page.goto(base + '/test/pages/player.html');
  return page;
}

// Lossy frames and premultiplied canvas blending give small rounding
// differences against libwebp. A compositing bug gives large ones.
function assertClose(results) {
  for (const r of results) {
    assert.equal(r.current, r.k);
    assert.ok(r.mean < 0.5 && r.max <= 6, `frame ${r.k}: max ${r.max}, mean ${r.mean.toFixed(3)}`);
  }
}

test('sequential frames match libwebp (heavy fixture)', async () => {
  const page = await playerPage();
  const order = Array.from({ length: 40 }, (_, i) => i);
  assertClose(await page.evaluate((o) => checkOrder('heavy', o), order));
});

test('seeking backwards and across key frames matches libwebp', async () => {
  const page = await playerPage();
  assertClose(await page.evaluate(() => checkOrder('heavy', [37, 3, 22, 21, 9, 0, 39])));
});

test('dispose-to-background and lossless alpha match libwebp', async () => {
  const page = await playerPage();
  const order = [...Array.from({ length: 12 }, (_, i) => i), 5, 11, 2];
  assertClose(await page.evaluate((o) => checkOrder('alpha', o), order));
});

test('seeking while playing keeps playing', async () => {
  const page = await playerPage();
  const result = await page.evaluate(() => seekWhilePlaying('heavy'));
  assert.deepEqual(result, { landed: 10, playing: true, advanced: true, stateChanges: 0 });
});

test('reports decode time per frame', async () => {
  const page = await playerPage();
  const ms = await page.evaluate(() => timeSequential('heavy'));
  console.log(`# chromium: ${ms.toFixed(2)} ms per 672x1024 frame (decode + composite)`);
  assert.ok(ms < 31, 'slower than the 31 ms frame time');
});

test('content script swaps in the player and leaves other images alone', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/test/pages/site.html');
  // Read the canvas at the moment the player enters the page.
  await page.evaluate(() => {
    new MutationObserver((records) => {
      for (const r of records) {
        for (const n of r.addedNodes) {
          if (n.tagName === 'WEBP-PLAYER' && !window.__pixelAtInsert) {
            const canvas = n.shadowRoot.querySelector('canvas');
            window.__pixelAtInsert = Array.from(canvas.getContext('2d').getImageData(336, 512, 1, 1).data);
          }
        }
      }
    }).observe(document.body, { subtree: true, childList: true });
  });
  for (const src of ['settings.js', 'webp-parser.js', 'player.js', 'view.js', 'content.js']) {
    await page.addScriptTag({ url: '/extension/src/' + src });
  }
  await page.waitForSelector('webp-player');

  // The player is inserted only after it drew the first frame, so the
  // canvas is never empty on screen.
  const centre = await page.evaluate(() => window.__pixelAtInsert);
  assert.equal(centre[3], 255, 'first frame not drawn when the player appeared');

  const state = await page.evaluate(() => {
    const host = document.querySelector('webp-player');
    const r = host.getBoundingClientRect();
    return {
      count: document.querySelectorAll('webp-player').length,
      parentIsLink: host.parentElement.tagName,
      nextIsImg: host.nextElementSibling.id,
      imgDisplay: getComputedStyle(document.getElementById('img')).display,
      stillDisplay: getComputedStyle(document.getElementById('still')).display,
      size: [Math.round(r.width), Math.round(r.height)],
    };
  });
  assert.deepEqual(state, {
    count: 1, parentIsLink: 'A', nextIsImg: 'img', imgDisplay: 'none', stillDisplay: 'inline', size: [672, 1024],
  });

  // The animation advances on its own.
  const label = () => page.evaluate(() => document.querySelector('webp-player').shadowRoot.querySelector('.label').textContent);
  const first = await label();
  await page.waitForTimeout(400);
  assert.notEqual(await label(), first);

  // The pause button pauses and does not follow the surrounding link.
  await page.evaluate(() => document.querySelector('webp-player').shadowRoot.querySelector('.play').click());
  const paused = await label();
  await page.waitForTimeout(300);
  assert.equal(await label(), paused);
  assert.equal(await page.evaluate(() => location.hash), '');

  // A click on the picture itself still follows the link.
  await page.click('webp-player', { position: { x: 100, y: 100 } });
  assert.equal(await page.evaluate(() => location.hash), '#navigated');

  // Turning the site off restores the original image.
  await page.evaluate(() => window.__storageListener({ ['disabled:' + location.hostname]: { newValue: true } }, 'local'));
  assert.equal(await page.evaluate(() => document.querySelectorAll('webp-player').length), 0);
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('img')).display), 'inline');

  // A new src on the same element gets a new player.
  await page.evaluate(() => window.__storageListener({ ['disabled:' + location.hostname]: { newValue: undefined } }, 'local'));
  await page.waitForSelector('webp-player');
  await page.evaluate(() => { document.getElementById('img').src = '/test/.fixtures/alpha.webp'; });
  await page.waitForFunction(() => {
    const h = document.querySelector('webp-player');
    return h && h.shadowRoot.querySelector('.label').textContent.endsWith('/ 12');
  });
  assert.equal(await page.evaluate(() => document.querySelectorAll('webp-player').length), 1);
});

test('playback starts before a slow download ends', async () => {
  const page = await browser.newPage();
  await page.goto(base + '/test/pages/site.html?slow');
  // Point the image at the slow path before the scripts run.
  await page.evaluate(() => {
    document.getElementById('img').src = '/slow/test/.fixtures/heavy.webp';
  });
  for (const src of ['settings.js', 'webp-parser.js', 'player.js', 'view.js', 'content.js']) {
    await page.addScriptTag({ url: '/extension/src/' + src });
  }
  const label = () => page.evaluate(() => {
    const h = document.querySelector('webp-player');
    return h ? h.shadowRoot.querySelector('.label').textContent : null;
  });

  await page.waitForSelector('webp-player');
  const early = await label();
  assert.match(early, /^Loading \d+%$/, 'the label shows the download progress: ' + early);
  const scrubOff = () => page.evaluate(() => document.querySelector('webp-player').shadowRoot.querySelector('.scrub').disabled);
  assert.equal(await scrubOff(), true, 'scrub bar is off while loading');
  // Safari's own copy of the download was stopped.
  assert.match(await page.evaluate(() => document.getElementById('img').getAttribute('src')), /^data:image\/gif/);

  await page.waitForFunction(() => {
    const t = document.querySelector('webp-player').shadowRoot.querySelector('.label').textContent;
    return /\/ 40$/.test(t);
  }, null, { timeout: 15000 });
  assert.equal(await scrubOff(), false, 'scrub bar is on after loading');

  // Turning the site off puts the original src back.
  await page.evaluate(() => window.__storageListener({ ['disabled:' + location.hostname]: { newValue: true } }, 'local'));
  assert.equal(await page.evaluate(() => document.getElementById('img').getAttribute('src')), '/slow/test/.fixtures/heavy.webp');
  assert.equal(await page.evaluate(() => document.querySelectorAll('webp-player').length), 0);
});

test('on a touch screen the controls open from the corner button', async () => {
  const context = await browser.newContext({ isMobile: true, hasTouch: true, viewport: { width: 800, height: 1200 } });
  const page = await context.newPage();
  await page.goto(base + '/test/pages/site.html');
  assert.equal(await page.evaluate(() => matchMedia('(hover: none)').matches), true);
  // A second animated image, to check that only one bar opens at a time.
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = '#second';
    a.innerHTML = '<img id="img2" src="/test/.fixtures/alpha.webp">';
    document.body.append(a);
  });
  for (const src of ['settings.js', 'webp-parser.js', 'player.js', 'view.js', 'content.js']) {
    await page.addScriptTag({ url: '/extension/src/' + src });
  }
  await page.waitForFunction(() => document.querySelectorAll('webp-player').length === 2);

  const bars = () => page.evaluate(() => [...document.querySelectorAll('webp-player')].map((h) => {
    const bar = h.shadowRoot.querySelector('.bar');
    const cs = getComputedStyle(bar);
    return cs.opacity === '1' && cs.pointerEvents !== 'none';
  }));
  const tapToggle = (i) => page.evaluate((i) => {
    document.querySelectorAll('webp-player')[i].shadowRoot.querySelector('.toggle').click();
  }, i);

  // The bars start hidden, and a tap on the picture follows the link.
  assert.deepEqual(await bars(), [false, false]);
  await page.tap('webp-player', { position: { x: 100, y: 500 } });
  assert.equal(await page.evaluate(() => location.hash), '#navigated');
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(200);
  assert.deepEqual(await bars(), [false, false], 'a tap on the picture does not open the bar');

  // The corner button opens the bar and does not follow the link.
  await tapToggle(0);
  await page.waitForTimeout(200);
  assert.deepEqual(await bars(), [true, false]);
  assert.equal(await page.evaluate(() => location.hash), '');

  // Opening the second bar closes the first.
  await tapToggle(1);
  await page.waitForTimeout(200);
  assert.deepEqual(await bars(), [false, true]);

  // The bar closes on its own after a few seconds.
  await page.waitForTimeout(4300);
  assert.deepEqual(await bars(), [false, false]);
  await context.close();
});
