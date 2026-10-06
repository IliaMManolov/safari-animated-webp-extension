// Renders the PNG icons in extension/icons from the SVG files in
// design/app-icon. Run `npm install` first, then `npm run icons`.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const design = path.join(repo, 'design/app-icon');
const out = path.join(repo, 'extension/icons');

const dataUrl = (file) =>
  'data:image/svg+xml;base64,' + readFileSync(path.join(design, file)).toString('base64');

// Same opacities as the Icon Composer file. The gradient and the rounded
// mask stand in for what Icon Composer adds on the app icon.
const layers = [
  ['layers/1-frame-back.svg', 0.35],
  ['layers/2-frame-middle.svg', 0.6],
  ['layers/3-frame-front.svg', 1],
  ['layers/4-play.svg', 1],
  ['layers/5-seek-bar.svg', 1],
];

const appIcon = (size) => `
  <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#4F7BFF"/><stop offset="1" stop-color="#2A3FD6"/>
      </linearGradient>
      <clipPath id="mask"><rect width="1024" height="1024" rx="230"/></clipPath>
    </defs>
    <g clip-path="url(#mask)">
      <rect width="1024" height="1024" fill="url(#bg)"/>
      ${layers.map(([file, opacity]) =>
        `<image href="${dataUrl(file)}" width="1024" height="1024" opacity="${opacity}"/>`).join('')}
    </g>
  </svg>`;

const toolbarIcon = (size) =>
  `<img src="${dataUrl('toolbar.svg')}" width="${size}" height="${size}">`;

const browser = await chromium.launch();

async function render(html, size, file) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0;background:transparent">${html}</body>`);
  await page.waitForLoadState('load');
  await page.screenshot({ path: path.join(out, file), omitBackground: true });
  await page.close();
}

for (const size of [48, 96, 128, 256, 512]) await render(appIcon(size), size, `icon-${size}.png`);
for (const size of [16, 19, 32, 38, 48, 72]) await render(toolbarIcon(size), size, `toolbar-${size}.png`);

await browser.close();
