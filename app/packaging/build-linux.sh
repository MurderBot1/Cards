#!/usr/bin/env bash
# packaging/build-linux.sh
# Run from anywhere: ./packaging/build-linux.sh
#
# pywebview's GTK backend needs a system WebKit package that pip cannot
# install for you. On Debian/Ubuntu:
#   sudo apt-get install -y python3-gi python3-gi-cairo gir1.2-gtk-3.0 \
#       gir1.2-webkit2-4.1 libgirepository1.0-dev
# (older distros may only have gir1.2-webkit2-4.0 — install whichever
# exists). See BUILD.md for other distros. This script checks for it and
# fails with that same message rather than producing a build that crashes
# on launch.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 -m pip install --upgrade pip
pip3 install -r "$REPO_ROOT/backend/requirements.txt"
pip3 install -r "$REPO_ROOT/packaging/requirements-build.txt"

python3 - <<'EOF'
import sys
try:
    import gi
    gi.require_version("WebKit2", "4.1")
    from gi.repository import WebKit2  # noqa: F401
except Exception:
    try:
        import gi
        gi.require_version("WebKit2", "4.0")
        from gi.repository import WebKit2  # noqa: F401
    except Exception as exc:
        print(f"GTK WebKit backend not available ({exc}).")
        print("Install it first — see the comment at the top of this script.")
        sys.exit(1)
EOF

python3 "$REPO_ROOT/packaging/build.py"