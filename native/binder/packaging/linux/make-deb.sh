#!/usr/bin/env bash
# Builds the Linux installer, a .deb, from the installed layout (`cmake --install ... --prefix dist` -> dist/Binder).
#   make-deb.sh <dist/Binder> <version without the v, e.g. 1.0.8> <output.deb> <icon.png>
# Installs into /opt/binder (the executable finds its frontend/, data and libonnxruntime next to itself), with a
# /usr/bin/binder launcher, a menu entry and an icon. The app's own data stays in the user's home directory.
set -euo pipefail
src=$1 version=$2 out=$3 icon=$4
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

mkdir -p "$root/opt" "$root/usr/bin" "$root/usr/share/applications" "$root/usr/share/icons/hicolor/256x256/apps" "$root/DEBIAN"
cp -a "$src" "$root/opt/binder"
ln -s /opt/binder/binder "$root/usr/bin/binder"
install -m 644 "$icon" "$root/usr/share/icons/hicolor/256x256/apps/binder.png"
cat > "$root/usr/share/applications/binder.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Binder
Comment=Scan and track your trading cards
Exec=/usr/bin/binder
Icon=binder
Categories=Utility;
Terminal=false
DESKTOP

size=$(du -sk "$root/opt" | cut -f1)
cat > "$root/DEBIAN/control" <<CONTROL
Package: binder
Version: $version
Section: utils
Priority: optional
Architecture: amd64
Installed-Size: $size
Depends: libgtk-3-0, libwebkit2gtk-4.1-0
Maintainer: Binder <noreply@users.noreply.github.com>
Homepage: https://github.com/MurderBot1/Cards
Description: Binder card tracker
 Scans trading cards with the camera, identifies them and keeps your collections.
CONTROL

# fast to build; the models in it don't compress much anyway
dpkg-deb -Zgzip --root-owner-group --build "$root" "$out"
dpkg-deb --info "$out"
