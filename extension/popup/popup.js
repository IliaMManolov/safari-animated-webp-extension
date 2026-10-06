const ext = globalThis.browser || globalThis.chrome;

async function main() {
  const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  let host = '';
  try {
    host = new URL(tab.url).hostname;
  } catch (err) {
    // Pages such as the start page have no hostname.
  }
  const toggle = document.getElementById('toggle');
  const site = document.getElementById('site');
  if (!host) {
    site.textContent = 'Not available on this page';
    toggle.disabled = true;
    return;
  }
  site.textContent = host;
  const key = 'disabled:' + host;
  const stored = await ext.storage.local.get(key);
  toggle.checked = !stored[key];
  toggle.addEventListener('change', () => {
    if (toggle.checked) ext.storage.local.remove(key);
    else ext.storage.local.set({ [key]: true });
  });
}

main();
