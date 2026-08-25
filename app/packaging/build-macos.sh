#!/usr/bin/env bash
# packaging/build-macos.sh
# Run from anywhere: ./packaging/build-macos.sh
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

python3 -m pip install --upgrade pip
pip3 install -r "$REPO_ROOT/backend/requirements.txt"
pip3 install -r "$REPO_ROOT/packaging/requirements-build.txt"

python3 "$REPO_ROOT/packaging/build.py"