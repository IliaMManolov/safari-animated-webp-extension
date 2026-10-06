<div align="center">
  <img src="extension/icons/icon-256.png" width="128" height="128" alt="WebP Player icon">
  <h1>WebP Player</h1>
  <p>Smooth animated WebP in Safari, with player controls.</p>
</div>

Some animated WebP images play very slowly in Safari on the Mac. On the iPhone, they stop on the first frame. Chrome plays the same images at full speed.

WebP Player is a Safari extension for macOS and iOS that fixes this. It finds the animated WebP images on a page and plays them with its own player. You do not have to do anything on each page.

## Features

- Plays heavy animated WebP images at full speed in Safari on the Mac, iPhone and iPad.
- Starts to play while the image downloads.
- Adds play, pause, scrub and speed controls to each image. On a touch screen, a small button in the corner opens the controls.
- Keeps the links and the layout of the page.
- Turns off for one site from the toolbar button.

## How it works

The extension reads the frames of each animated WebP file itself and draws them on a canvas. It decodes only a few frames ahead, so it uses little memory. The original image stays in the page, hidden.

## Build and install

WebP Player is not in the App Store yet. To use it now, build it from the source code. You need a Mac with Xcode 26.

1. Run `scripts/make-xcode-project.sh` in the folder of the repository.
2. Open `xcode/WebP Player/WebP Player.xcodeproj` in Xcode.
3. For the iPhone, select your Apple ID team in the Signing & Capabilities tab.
4. Select the `WebP Player (macOS)` scheme or the `WebP Player (iOS)` scheme and click Run.
5. On the Mac, turn on Safari Settings > Developer > "Allow unsigned extensions".
6. Turn on WebP Player in Safari Settings > Extensions on the Mac, or in Settings > Apps > Safari > Extensions on the iPhone. Allow it on all websites.

To run the tests, use `npm install` and then `npm test`. The tests need Python 3 with Pillow.

## License

WebP Player uses the [GNU General Public License version 3](LICENSE), with an [additional permission](APP-STORE-EXCEPTION) for distribution through the App Store. To contribute, read [CONTRIBUTING.md](CONTRIBUTING.md).
