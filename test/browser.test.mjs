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
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname));
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
  for (const src of ['webp-parser.js', 'player.js', 'content.js']) {
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
