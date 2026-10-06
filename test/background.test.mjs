import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Runs background.js with a stand-in for the extension API and checks
// that a download arrives in order and in more than one piece.
const file = readFileSync(new URL('./.fixtures/heavy.webp', import.meta.url));
let server, url, onConnect;

before(async () => {
  server = createServer(async (req, res) => {
    if (req.url !== '/a.webp') {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'image/webp' });
    for (let i = 0; i < file.length && !res.destroyed; i += 64 * 1024) {
      res.write(file.subarray(i, i + 64 * 1024));
      await new Promise((r) => setTimeout(r, 5));
    }
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}/a.webp`;
  const context = vm.createContext({
    fetch, AbortController, Uint8Array, String, btoa, Error,
    chrome: { runtime: { onConnect: { addListener(fn) { onConnect = fn; } } } },
  });
  vm.runInContext(readFileSync(new URL('../extension/background.js', import.meta.url), 'utf8'), context);
});

after(() => server.close());

// A stand-in for one end of a runtime.Port. `received` collects what the
// background script posts.
function connect(target) {
  const listeners = { message: [], disconnect: [] };
  const received = [];
  let notify = () => {};
  const port = {
    name: 'download',
    postMessage(msg) {
      // Copy out of the script's realm, as a real port would.
      received.push(JSON.parse(JSON.stringify(msg)));
      notify();
    },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
  };
  onConnect(port);
  listeners.message.forEach((fn) => fn({ url: target }));
  return {
    received,
    disconnect: () => listeners.disconnect.forEach((fn) => fn()),
    until: (check) => new Promise((resolve) => {
      notify = () => check(received) && resolve(received);
      notify();
    }),
  };
}

const ended = (msgs) => msgs.some((m) => m.done || m.error);

test('background streams the file in pieces', async () => {
  const msgs = await connect(url).until(ended);
  const last = msgs.pop();
  assert.deepEqual(last, { done: true });
  assert.ok(msgs.length > 1);
  assert.ok(Buffer.concat(msgs.map((m) => Buffer.from(m.data, 'base64'))).equals(file));
});

test('background reports HTTP errors', async () => {
  const msgs = await connect(url.replace('/a.webp', '/missing.webp')).until(ended);
  assert.deepEqual(msgs, [{ error: 'Error: HTTP 404' }]);
});

test('closing the port stops the download', async () => {
  const conn = connect(url);
  await conn.until((msgs) => msgs.length > 0);
  conn.disconnect();
  const count = conn.received.length;
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(conn.received.length <= count + 1, 'pieces kept arriving after the port closed');
  assert.ok(!ended(conn.received));
});
