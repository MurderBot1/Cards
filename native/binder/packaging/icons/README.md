# App icon

`native/binder/CMakeLists.txt` picks these up automatically — nothing else to configure.

| File        | Used on | How                                                                          |
|-------------|---------|-------------------------------------------------------------------------------|
| `icon.ico`  | Windows | compiled into `binder.exe` through `packaging/binder.rc`                      |
| `icon.icns` | macOS   | copied into `Binder.app/Contents/Resources` (`CFBundleIconFile` in `Info.plist`) |

Linux has no equivalent "baked into the binary" icon mechanism — a `.desktop` launcher file (not included here) is the
usual way to give a Linux app an icon in menus and the taskbar, referencing a plain `.png`.

Free tools to generate the formats from a single source PNG:
- `.ico`: e.g. `magick icon.png -define icon:auto-resize=256,48,32,16 icon.ico` (ImageMagick)
- `.icns`: macOS's built-in `iconutil`, or `png2icns` on Linux
