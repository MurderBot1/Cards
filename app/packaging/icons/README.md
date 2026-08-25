# App icon

Drop icon files here and `packaging/binder.spec` will pick them up
automatically — nothing else to configure. If a file isn't present,
the build just uses PyInstaller's default icon instead.

| File        | Used on | Notes                                              |
|-------------|---------|-----------------------------------------------------|
| `icon.ico`  | Windows | Multi-resolution .ico (16/32/48/256px recommended)  |
| `icon.icns` | macOS   | Standard macOS icon set converted to `.icns`        |

Linux doesn't have an equivalent "baked into the binary" icon
mechanism — a `.desktop` launcher file (not included here) is the
usual way to give a Linux app an icon in menus/taskbars, referencing
a plain `.png`.

Free tools to generate `.ico`/`.icns` from a single source PNG:
- `.ico`: e.g. `magick icon.png -define icon:auto-resize=256,48,32,16 icon.ico` (ImageMagick)
- `.icns`: macOS's built-in `iconutil`, or `png2icns` on Linux