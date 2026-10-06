<img src="extension/icons/icon-128.png" width="96" height="96" alt="WebP Player icon: three fanned picture frames with a play button and a seek bar">

# WebP Player

WebP Player is a Safari web extension for macOS and iOS. It plays heavy animated WebP images smoothly. Each image gets play, pause, scrub and speed controls.

## The problem

Safari decodes WebP images with the ImageIO library from Apple. Some animated WebP files play slowly in Safari on macOS. On iOS, the same files stop on the first frame. Chrome plays them at full speed.

The test file for this project has these properties:

- A canvas of 672 x 1024 px with 193 lossy frames at 31 ms each
- A complete opaque frame every 5 frames, also called a keyframe
- 4 frames between the keyframes that have transparency and blend over the previous frame

The likely cause is the decode work for each frame and the memory for all frames. If the browser decodes all 193 frames at the same time, they need about 530 MB. This cause is an inference from the structure of the file. Nobody measured it inside Safari.

## How the extension works

1. The content script finds each `<img>` element with a WebP URL, for example a URL that ends in `.webp`. A content script is extension code that runs inside the web page.
2. The content script starts its own download of the file and reads the header in the first bytes. If the header has no animation flag, the script stops the download and does not change the image.
3. `src/webp-parser.js` reads the frames while the file downloads. It packs each frame as a separate still WebP file.
4. When the first frame is ready, the player draws it and replaces the image. `src/view.js` makes the player element and its controls. The other frames load while the player plays. If playback gets to a frame that is not ready, the player waits for it.
5. `src/player.js` decodes each still frame with `createImageBitmap`. The browser decodes these frames off the main thread. The player draws the frames on a canvas in order and applies the blend and dispose rules of the WebP format.
6. The player keeps a decoded frame only until it draws it. It decodes a maximum of 6 frames ahead. For the test file, each decoded frame uses about 3 MB.

Safari can still be downloading the original image when the player starts. In that case, the extension sets the `src` of the hidden image to a blank 1 x 1 GIF. This stops a second download of the same file. When you turn off the extension for the site, it puts the original `src` back.

If the CORS rules of the page block the download in the content script, `background.js` downloads the file. It sends the file to the content script in parts.

The original `<img>` stays in the page, hidden, so that the scripts of the page can still use it. The player is in the same place, inside the same link. A click on the picture opens the link. A click on the controls does not open the link.

If the browser cannot decode a frame, the extension removes the player and shows the original image again.

Safari sometimes runs the content script two times in one page, for example after an extension reload. In that case, the newest copy of the script removes the players of the older copy. Each image gets one player only.

The toolbar button opens a popup. The popup has a switch that turns off the extension for the current site.

## Files in the repository

- `extension`: the web extension. It contains `manifest.json`, the content scripts in `src`, `background.js`, the toolbar popup in `popup`, and the icons in `icons`.
- `scripts/make-xcode-project.sh`: makes the Xcode project that wraps the extension in a macOS app and an iOS app.
- `design/app-icon`: the source files of the app icon and the toolbar icon. `design/app-icon/README.md` tells you how to change them.
- `test`: the tests and the script that makes the test images.

## Build and run on a Mac

You need a Mac with Xcode 26. Do these steps in the folder of the repository:

1. Run `scripts/make-xcode-project.sh`. The default bundle ID is `com.imanolov.largewebpplayer`. To use a different bundle ID, set `BUNDLE_ID` first, for example `BUNDLE_ID=com.yourname.webpplayer scripts/make-xcode-project.sh`.
2. Open `xcode/WebP Player/WebP Player.xcodeproj` in Xcode.
3. Drag `design/app-icon/AppIcon.icon` into the Xcode project. In the General tab of the macOS app target and of the iOS app target, make sure that App Icon says `AppIcon`.
4. Select the `WebP Player (macOS)` scheme and click Run.
5. In Safari, open Settings > Advanced. Turn on "Show features for web developers".
6. In Safari Settings > Developer, turn on "Allow unsigned extensions".
7. In Safari Settings > Extensions, turn on WebP Player. Click "Edit Websites…" and set "When visiting other websites" to Allow.
8. Open a page with an animated WebP image. Move the pointer over the image to show the controls.

If you skip step 3, the app uses the plain `AppIcon` asset catalog that the script makes. The extension icon in Safari does not change, because it comes from `extension/icons`.

If the toolbar popup says that WebP Player has no access to the page, Safari did not give the extension access to that site. Click "Allow on all websites" in the popup, or change the choice in step 7.

Safari turns off "Allow unsigned extensions" each time it quits. After a restart of Safari, turn it on again.

The Xcode project uses the `extension` folder in place. After you change a file in that folder, build again in Xcode and reload the page. You do not have to run the script again.

## Run on an iPhone

Do the first three steps of the Mac build before you start. Then:

1. In Xcode, select the `WebP Player (iOS)` scheme and select your iPhone as the target.
2. In the Signing & Capabilities tab, select your Apple ID team for the app target and for the extension target.
3. Click Run.
4. On the iPhone, open Settings > Apps > Safari > Extensions. Turn on WebP Player and allow it on all websites.

A free Apple ID can install the app on your own iPhone. The install stops working after 7 days. Then you run it from Xcode again.

On a touch screen, there is no pointer hover, so the control bar stays hidden. A small round button in the top right corner of each player opens the bar. A tap on the picture still opens the link of the page. Only one player shows its bar at a time. The bar closes 4 seconds after the last touch.

## App icon

The icon shows three fanned picture frames. The front frame has a play button and a seek bar. The shapes are white and blue on a blue gradient.

`design/app-icon/AppIcon.icon` is the Icon Composer file for the app on macOS and iOS. The SVG files in `design/app-icon/layers` are its layers. The extension icons and the toolbar icons in `extension/icons` are PNG files that come from the same SVG files. If you change an SVG file, run `npm run icons` to make the PNG files again.

## Tests

The tests run in Node.js and in headless Chromium through Playwright. To make the test images, the tests need Python 3 with Pillow. Run these commands in the folder of the repository:

```sh
npm install
npm test
```

`test/make-fixture.py` makes animated WebP files with the same structure as the problem file. Pillow decodes the same files with libwebp to make reference frames. The browser tests compare each frame from the player with these reference frames.

The tests do not run in Safari. Chromium on Linux does not use ImageIO, so the tests cannot show the Safari problem. To test the speed in Safari, you must use a Mac and an iPhone.

## Known limits

- The extension finds WebP images by their URL. It does not look at images whose URL has no WebP sign.
- The extension does not support CSS background images and `<picture>` sources yet.
- While the player runs, the page sees the original `<img>` as hidden, with a size of zero.

## License

WebP Player uses the GNU General Public License version 3, in `LICENSE`. `APP-STORE-EXCEPTION` gives an additional permission under section 7 of the GPL. This permission allows distribution through the App Store, the Mac App Store and TestFlight from Apple. The condition is that the source code is available to the public at no charge. The wording follows the App Store permission that Signal used for its iOS app. `CONTRIBUTING.md` says that contributions use the same terms.
