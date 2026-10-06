// Downloads images for the content script when the page's CORS rules
// block the content script's own fetch. Extension pages with host
// permissions are not limited by CORS. The bytes go to the content
// script in pieces while the download runs, so playback can start early.
const ext = globalThis.browser || globalThis.chrome;
const MAX_PIECE = 512 * 1024; // Bytes per message, before base64.
const streams = new Map(); // id -> stream state
let nextId = 1;

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function open(url) {
  const controller = new AbortController();
  const res = await fetch(url, { credentials: 'include', cache: 'force-cache', signal: controller.signal });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const id = nextId++;
  const s = { chunks: [], done: false, error: null, wake: null, controller };
  streams.set(id, s);
  (async () => {
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        s.chunks.push(value);
        if (s.wake) s.wake();
      }
    } catch (err) {
      s.error = String(err);
    }
    s.done = true;
    if (s.wake) s.wake();
  })();
  return id;
}

// Returns the bytes that arrived since the last read. Waits when none
// arrived yet.
async function read(id) {
  const s = streams.get(id);
  if (!s) return { error: 'Unknown stream' };
  while (!s.chunks.length && !s.done) {
    await new Promise((resolve) => { s.wake = resolve; });
    s.wake = null;
  }
  if (s.error && !s.chunks.length) {
    streams.delete(id);
    return { error: s.error };
  }
  const parts = [];
  let size = 0;
  while (s.chunks.length && size < MAX_PIECE) {
    let c = s.chunks.shift();
    if (size + c.length > MAX_PIECE) {
      s.chunks.unshift(c.subarray(MAX_PIECE - size));
      c = c.subarray(0, MAX_PIECE - size);
    }
    parts.push(c);
    size += c.length;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  const done = s.done && !s.chunks.length;
  if (done) streams.delete(id);
  return { data: toBase64(out), done };
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'open') {
    open(msg.url).then((id) => sendResponse({ id }), (err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (msg.type === 'read') {
    read(msg.id).then(sendResponse, (err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (msg.type === 'release') {
    const s = streams.get(msg.id);
    if (s) s.controller.abort();
    streams.delete(msg.id);
    return false;
  }
  return false;
});
