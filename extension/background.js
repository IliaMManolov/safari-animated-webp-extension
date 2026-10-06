// Downloads images for the content script when the page's CORS rules
// block the content script's own fetch. Extension pages with host
// permissions are not limited by CORS.
//
// The content script opens a port and posts { url }. The background
// script posts each piece as { data } in base64 while the download runs,
// so playback can start early, then { done } or { error }. When either
// side closes the port, the download stops.
const ext = globalThis.browser || globalThis.chrome;

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

async function download(port, url, signal) {
  try {
    const res = await fetch(url, { credentials: 'include', cache: 'force-cache', signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const reader = res.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      port.postMessage({ data: toBase64(value) });
    }
    port.postMessage({ done: true });
  } catch (err) {
    if (!signal.aborted) port.postMessage({ error: String(err) });
  }
}

ext.runtime.onConnect.addListener((port) => {
  if (port.name !== 'download') return;
  const controller = new AbortController();
  port.onDisconnect.addListener(() => controller.abort());
  port.onMessage.addListener((msg) => download(port, msg.url, controller.signal));
});
