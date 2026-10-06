# WebP Player

WebP Player is a Safari web extension. It plays heavy animated WebP images smoothly and adds play, pause, scrub and speed controls.

## The problem

Safari decodes WebP with Apple's ImageIO library. Some animated WebP files play slowly in Safari on macOS and stop on the first frame on iOS. Chrome plays the same files at full speed.

The test file for this project has these properties:

- a 672x1024 canvas with 193 lossy frames at 31 ms each
- a complete opaque frame every 5 frames
- 4 frames between them that have alpha and blend over the previous frame

The likely cause is the decoder work for each frame and the memory for all frames. If the browser decodes all 193 frames at the same time, they need about 530 MB. This cause is an inference from the file structure. Nobody measured it inside Safari.

## How the extension works

1. The content script finds `<img>` elements with a WebP URL, for example a URL that ends in `.webp`.
2. It starts its own download of the file and reads the header from the first bytes. If the header has no animation flag, it stops the download and leaves the image alone.
3. `src/webp-parser.js` reads the frames while the file downloads. It packs each frame as a separate still WebP file.
4. When the first frame is in, the player draws it and replaces the image. The rest of the frames load while the player plays. If playback reaches a frame that is not in yet, the player waits for it.
5. `src/player.js` decodes each still frame with `createImageBitmap`. The browser decodes these off the main thread. The player then draws the frames on a canvas in order and applies the blend and dispose rules of the WebP format.
6. The player keeps a decoded frame only until it draws it. It decodes a maximum of 6 frames ahead, at about 3 MB each for the test file.

If Safari is still downloading the original image when the player starts, the extension sets the hidden image's `src` to a blank 1x1 GIF. This stops the second download of the same file. When the extension turns off for the site, it puts the original `src` back.

If the page's CORS rules block the content script's download, `background.js` downloads the file and sends it to the content script in pieces.

The original `<img>` stays in the page, hidden, so the page scripts can still use it. The player sits in the same place, inside the same link. A click on the picture follows the link. A click on the controls does not.

If the browser cannot decode a frame, the extension removes the player and shows the original image again.

The toolbar button opens a switch that turns the extension off for the current site.

## Build and run on a Mac

You need a Mac with Xcode.

1. Run `scripts/make-xcode-project.sh` from the repository folder. To use your own bundle ID, set `BUNDLE_ID` first, for example `BUNDLE_ID=com.yourname.webpplayer scripts/make-xcode-project.sh`.
2. Open `xcode/WebP Player/WebP Player.xcodeproj` in Xcode.
3. Select the `WebP Player (macOS)` scheme and click Run.
4. In Safari, open Settings > Advanced and turn on "Show features for web developers".
5. In Safari Settings > Developer, turn on "Allow unsigned extensions".
6. In Safari Settings > Extensions, turn on WebP Player. Click "Edit Websites…" and set "When visiting other websites" to Allow.
7. Open a page with an animated WebP image. Move the pointer over the image to see the controls.

If the toolbar popup says that WebP Player has no access to the page, Safari did not give the extension access to that site. Click "Allow on all websites" in the popup, or change the setting in step 6.

Safari turns off "Allow unsigned extensions" each time it quits. Turn it on again after a restart.

The Xcode project uses the `extension` folder in place. After you change a file there, build again in Xcode and reload the page.

## Run on an iPhone

1. In Xcode, select the `WebP Player (iOS)` scheme and your iPhone as the target.
2. In the Signing & Capabilities tab, select your Apple ID team for both the app target and the extension target.
3. Click Run.
4. On the iPhone, open Settings > Apps > Safari > Extensions. Turn on WebP Player and allow it on all websites.

On iOS the controls are always visible, because there is no pointer hover.

## Tests

The tests run in Node.js and in headless Chromium through Playwright. They need Python 3 with Pillow to make the test images.

```sh
npm install
npm test
```

`test/make-fixture.py` makes animated WebP files with the same structure as the problem file. Pillow decodes the same files with libwebp to make reference frames. The browser tests compare each frame from the player against these reference frames.

The tests do not run in Safari. Chromium on Linux does not use ImageIO, so the tests cannot reproduce the Safari problem. A test on a Mac and an iPhone is the only check for the Safari speed.

## Known limits

- The extension finds WebP images by URL. It does not check images whose URL has no WebP sign.
- CSS background images and `<picture>` sources are not supported yet.
- While the player runs, the page sees the original `<img>` as hidden, with a size of zero.
