// Fetches image bytes for the content script when the page's CORS rules
// block the content script's own fetch. Extension pages with host
// permissions are not limited by CORS.
const ext = globalThis.browser || globalThis.chrome;
const CHUNK = 1024 * 1024; // Bytes per message, before base64.
const pending = new Map(); // id -> Uint8Array
let nextId = 1;

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'fetch') {
    fetch(msg.url, { credentials: 'include', cache: 'force-cache' })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.arrayBuffer();
      })
      .then((buf) => {
        const id = nextId++;
        pending.set(id, new Uint8Array(buf));
        sendResponse({ id, size: buf.byteLength });
      })
      .catch((err) => sendResponse({ error: String(err) }));
    return true;
  }
  if (msg.type === 'chunk') {
    const bytes = pending.get(msg.id);
    if (!bytes) {
      sendResponse({ error: 'Unknown fetch id' });
      return false;
    }
    const start = msg.index * CHUNK;
    sendResponse({ data: toBase64(bytes.subarray(start, start + CHUNK)) });
    return false;
  }
  if (msg.type === 'release') {
    pending.delete(msg.id);
    return false;
  }
  return false;
});
