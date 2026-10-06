import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Runs background.js with a stand-in for the extension API and checks
// that a download arrives in order and in more than one piece.
const file = readFileSync(new URL('./.fixtures/heavy.webp', import.meta.url));
let server, url, listener;

before(async () => {
  server = createServer(async (req, res) => {
    if (req.url !== '/a.webp') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'image/webp' });
    for (let i = 0; i < file.length; i += 64 * 1024) {
      res.write(file.subarray(i, i + 64 * 1024));
      await new Promise((r) => setTimeout(r, 5));
    }
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/a.webp`;
  const context = vm.createContext({
    fetch, AbortController, Uint8Array, String, btoa, Promise, Map,
    chrome: { runtime: { onMessage: { addListener(fn) { listener = fn; } } } },
  });
  vm.runInContext(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8'), context);
});

after(() => server.close());

const send = (msg) => new Promise((resolve) => {
  if (!listener(msg, {}, resolve)) resolve(undefined);
});

test('background streams the file in pieces', async () => {
  const { id, error } = await send({ type: 'open', url });
  assert.equal(error, undefined);
  const pieces = [];
  for (;;) {
    const part = await send({ type: 'read', id });
    assert.equal(part.error, undefined);
    pieces.push(Buffer.from(part.data, 'base64'));
    if (part.done) break;
  }
  assert.ok(pieces.length > 1);
  assert.ok(Buffer.concat(pieces).equals(file));
});

test('background reports HTTP errors', async () => {
  const res = await send({ type: 'open', url: url.replace('/a.webp', '/missing.webp') });
  assert.equal(res.error, 'Error: HTTP 404');
});
