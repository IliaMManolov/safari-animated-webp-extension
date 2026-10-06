# App icon

The icon shows three fanned picture frames. The front frame has a play button and a seek bar. The shapes are white and blue on a blue gradient.

## Files

- `layers/1-frame-back.svg` to `layers/5-seek-bar.svg`: the layers of the app icon, from back to front. Each file is 1024 x 1024 px and has no background and no rounded mask.
- `toolbar.svg`: the toolbar button. It is a black shape on a transparent background, because Safari colors the toolbar icon itself.

The PNG files in `extension/icons` come from these files. If you change an SVG file, run `npm run icons` to make the PNG files again.

## Make the app icon in Icon Composer

Xcode 26 uses one Icon Composer file for the iPhone, iPad, Mac and App Store icon. You need a Mac to make it.

1. In Xcode, select Xcode > Open Developer Tool > Icon Composer.
2. Drag the five files from `layers` into the sidebar.
3. Select the icon name in the sidebar. Set Fill to Gradient, from `#4F7BFF` at the top to `#2A3FD6` at the bottom.
4. Set the opacity of `1-frame-back` to 35% and of `2-frame-middle` to 60%.
5. Preview the Default, Dark and Mono appearances.
6. Save the file as `AppIcon.icon` in this folder.
7. Drag `AppIcon.icon` into the Xcode project. In the General tab of the macOS app target and of the iOS app target, make sure that App Icon says `AppIcon`.

The Icon Composer file replaces the `AppIcon` asset catalog that `scripts/make-xcode-project.sh` makes.

Do not use SF Symbols or shapes that look like them in the icon. The SF Symbols license does not allow this. The symbols `play.square.stack` and `play.rectangle.on.rectangle` are close to this design, so keep the frames fanned and keep the seek bar.
