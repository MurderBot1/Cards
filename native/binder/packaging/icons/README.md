# App icon

`native/binder/CMakeLists.txt` picks these up automatically — nothing else to configure.

| File        | Used on | How                                                                          |
|-------------|---------|-------------------------------------------------------------------------------|
| `icon.ico`  | Windows | compiled into `binder.exe` through `packaging/binder.rc` (the file Explorer and the taskbar show), and set on the app window itself by `cardview` (`use_exe_icon`), because webview gives its window only the stock icon, so the title bar showed that one |
| `icon.icns` | macOS   | copied into `Binder.app/Contents/Resources` (`CFBundleIconFile` in `Info.plist`) |

Linux has no equivalent "baked into the binary" icon mechanism — a `.desktop` launcher file (not included here) is the
usual way to give a Linux app an icon in menus and the taskbar, referencing a plain `.png`.

Free tools to generate the formats from a single source PNG:
- `.ico`: e.g. `magick icon.png -define icon:auto-resize=256,48,32,16 icon.ico` (ImageMagick)
- `.icns`: macOS's built-in `iconutil`, or `png2icns` on Linux

Keep the `.ico` holding **16, 20, 24, 32, 40, 48 and 64 px as plain bitmaps** plus the 256 px PNG: Windows picks the frame nearest
the size it wants (16 px for the title bar at 100 % scale, more at higher scaling), and plain bitmaps are the form every
Windows API and the installer tool read without trouble. `magick` writes PNG frames by default; the current file was built
with bitmap frames (the sizes above, scaled from the 256 px art).
