const ext = globalThis.browser || globalThis.chrome;
const ALL_SITES = { origins: ['<all_urls>'] };

function show(id) {
  for (const section of document.querySelectorAll('section')) section.hidden = section.id !== id;
}

async function main() {
  // Safari sometimes returns no tab for currentWindow in a popup.
  let [tab] = await ext.tabs.query({ active: true, currentWindow: true });
  if (!tab) [tab] = await ext.tabs.query({ active: true, lastFocusedWindow: true });
  let host = '';
  try {
    host = new URL(tab.url).hostname;
  } catch (err) {
    // Safari hides the URL of a page that the extension has no access to.
  }

  if (!host) {
    const granted = await ext.permissions.contains(ALL_SITES).catch(() => false);
    if (granted) {
      show('none');
      return;
    }
    show('access');
    document.getElementById('allow').addEventListener('click', async () => {
      const ok = await ext.permissions.request(ALL_SITES).catch(() => false);
      if (ok) {
        ext.tabs.reload(tab.id);
        window.close();
      }
    });
    return;
  }

  show('main');
  const toggle = document.getElementById('toggle');
  document.getElementById('site').textContent = host;
  const key = 'disabled:' + host;
  const stored = await ext.storage.local.get(key);
  toggle.checked = !stored[key];
  toggle.addEventListener('change', () => {
    if (toggle.checked) ext.storage.local.remove(key);
    else ext.storage.local.set({ [key]: true });
  });
}

main();
