// Settings shared by the content script and the popup.
(function (root) {
  'use strict';

  // The storage.local key that is true when the extension is turned off
  // for a site.
  function siteKey(hostname) {
    return 'disabled:' + hostname;
  }

  root.WebPSettings = { siteKey };
})(globalThis);
