#!/usr/bin/env bash
# Creates the key the Android builds are signed with and (optionally) stores it as the four GitHub secrets the build
# workflow reads. Run it on YOUR computer, not in a shared or logged environment: the key can never be replaced without
# breaking updates for everyone who installed the app, so it must stay with you.
#
#   scripts/setup-android-signing.sh                          # make the key; prints what to add as secrets
#   scripts/setup-android-signing.sh --set-secrets            # ...and add them to the current repo with the GitHub CLI (gh)
#   scripts/setup-android-signing.sh --set-secrets --repo MurderBot1/Cards
#   scripts/setup-android-signing.sh --out ~/keys             # where to put the key files (default: here)
#
# Needs: keytool (comes with any JDK), openssl and base64; gh only for --set-secrets (and `gh auth login` done once).
set -euo pipefail

OUT="."
SET_SECRETS=0
REPO=""
ALIAS="binder"
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="$2"; shift 2 ;;
    --set-secrets) SET_SECRETS=1; shift ;;
    --repo) REPO="$2"; shift 2 ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
done

for tool in keytool openssl base64; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Missing '$tool'. Install a JDK (it includes keytool) and try again." >&2; exit 1; }
done
if [ "$SET_SECRETS" = 1 ]; then
  command -v gh >/dev/null 2>&1 || { echo "--set-secrets needs the GitHub CLI (gh): https://cli.github.com, then 'gh auth login'." >&2; exit 1; }
  gh auth status >/dev/null 2>&1 || { echo "gh isn't logged in: run 'gh auth login' first." >&2; exit 1; }
fi

mkdir -p "$OUT"
KEYSTORE="$OUT/binder.keystore"
NOTES="$OUT/binder.keystore.secrets.txt"
# Never overwrite: a key that is replaced or lost can't be recovered, and the next release would not install over the old ones.
if [ -e "$KEYSTORE" ] || [ -e "$NOTES" ]; then
  echo "$KEYSTORE (or its notes file) already exists. Not touching it: delete it yourself only if you are sure." >&2
  exit 1
fi

PASSWORD="$(openssl rand -base64 36 | tr -d '/+=\n' | cut -c1-28)"
# PKCS12 keystores use one password for the store and the key, so the same value goes in both secrets.
keytool -genkeypair -v -keystore "$KEYSTORE" -storetype PKCS12 -alias "$ALIAS" \
  -keyalg RSA -keysize 2048 -validity 10000 -storepass "$PASSWORD" -keypass "$PASSWORD" \
  -dname "CN=Binder, O=BinderCardTracker" >/dev/null 2>&1
chmod 600 "$KEYSTORE"
KEYSTORE_B64="$(base64 < "$KEYSTORE" | tr -d '\n')"

umask 077
cat > "$NOTES" <<NOTES_EOF
Binder Android signing key. KEEP BOTH FILES SAFE (a password manager or an encrypted backup); never commit them.
If this key is lost, the next release can't be installed over the old ones.

keystore file:  binder.keystore
alias:          $ALIAS
password:       $PASSWORD     (the same for the store and the key)

GitHub secrets the build reads:
  ANDROID_KEYSTORE_B64       = the base64 of binder.keystore (one long line: base64 < binder.keystore | tr -d '\n')
  ANDROID_KEYSTORE_PASSWORD  = $PASSWORD
  ANDROID_KEY_ALIAS          = $ALIAS
  ANDROID_KEY_PASSWORD       = $PASSWORD
NOTES_EOF

echo "Created $KEYSTORE"
echo "Saved the password and instructions in $NOTES  <- back both up now."
echo
keytool -list -keystore "$KEYSTORE" -storepass "$PASSWORD" 2>/dev/null | grep -i "fingerprint" || true
echo

if [ "$SET_SECRETS" = 1 ]; then
  repo_args=()
  [ -n "$REPO" ] && repo_args=(--repo "$REPO")
  printf '%s' "$KEYSTORE_B64" | gh secret set ANDROID_KEYSTORE_B64 "${repo_args[@]}"
  printf '%s' "$PASSWORD"     | gh secret set ANDROID_KEYSTORE_PASSWORD "${repo_args[@]}"
  printf '%s' "$ALIAS"        | gh secret set ANDROID_KEY_ALIAS "${repo_args[@]}"
  printf '%s' "$PASSWORD"     | gh secret set ANDROID_KEY_PASSWORD "${repo_args[@]}"
  echo "Added the four secrets. The next Android build is signed with this key."
else
  echo "Now add these four secrets in GitHub (repo -> Settings -> Secrets and variables -> Actions -> New repository secret),"
  echo "or re-run with --set-secrets to have the GitHub CLI do it:"
  echo "  ANDROID_KEY_ALIAS          = $ALIAS"
  echo "  ANDROID_KEYSTORE_PASSWORD  = $PASSWORD"
  echo "  ANDROID_KEY_PASSWORD       = $PASSWORD"
  echo "  ANDROID_KEYSTORE_B64       = (the contents of the line below)"
  echo "$KEYSTORE_B64"
fi
echo
echo "The first build signed with this key can't be installed over a copy signed with the old throwaway key:"
echo "uninstall the old app once (signed-in collections come back through sync)."
