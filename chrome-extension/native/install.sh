#!/bin/bash
set -euo pipefail

usage() {
  echo "Usage: $0 <extension-id> [--registry-dir <absolute-path>]"
  echo "Get the extension ID from chrome://extensions after loading unpacked"
  exit 1
}

die() {
  echo "Error: $*" >&2
  exit 1
}

shell_single_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}

EXTENSION_ID="${1:-}"
if [ -z "$EXTENSION_ID" ]; then
  usage
fi
shift

REGISTRY_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --registry-dir)
      shift
      [ $# -gt 0 ] || die "--registry-dir requires an absolute path"
      REGISTRY_DIR="$1"
      ;;
    *)
      die "Unexpected argument: $1"
      ;;
  esac
  shift
done

if [ -n "$REGISTRY_DIR" ]; then
  case "$REGISTRY_DIR" in
    *$'\n'*|*$'\r'*)
      die "--registry-dir must not contain newlines"
      ;;
    /*)
      ;;
    *)
      die "--registry-dir must be an absolute path"
      ;;
  esac
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_SCRIPT="$SCRIPT_DIR/host.cjs"

# Find node path (Chrome may not have node in PATH when launched from Dock)
NODE_PATH="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_PATH" ]; then
  for p in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$p" ]; then
      NODE_PATH="$p"
      break
    fi
  done
fi

if [ -z "$NODE_PATH" ]; then
  die "Could not find node. Please install Node.js."
fi

echo "Using node at: $NODE_PATH"

HOST_PATH="$SCRIPT_DIR/host-wrapper.sh"
{
  printf '#!/bin/bash\n'
  if [ -n "$REGISTRY_DIR" ]; then
    printf 'export PI_ANNOTATE_REGISTRY_DIR='
    shell_single_quote "$REGISTRY_DIR"
    printf '\n'
  fi
  printf 'exec '
  shell_single_quote "$NODE_PATH"
  printf ' '
  shell_single_quote "$HOST_SCRIPT"
  printf ' "$@"\n'
} > "$HOST_PATH"

chmod +x "$HOST_PATH"
chmod +x "$HOST_SCRIPT"

if [[ "$OSTYPE" == "darwin"* ]]; then
  MANIFEST_DIRS=(
    "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    "$HOME/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts"
    "$HOME/Library/Application Support/Chromium/NativeMessagingHosts"
  )
else
  CONFIG_HOME="${CHROME_CONFIG_HOME:-${XDG_CONFIG_HOME:-$HOME/.config}}"
  MANIFEST_DIRS=(
    "$CONFIG_HOME/google-chrome/NativeMessagingHosts"
    "$CONFIG_HOME/google-chrome-for-testing/NativeMessagingHosts"
    "$CONFIG_HOME/chromium/NativeMessagingHosts"
  )
fi

MANIFEST_PATH_JSON="$("$NODE_PATH" -p 'JSON.stringify(process.argv[1])' "$HOST_PATH")"

for MANIFEST_DIR in "${MANIFEST_DIRS[@]}"; do
  mkdir -p "$MANIFEST_DIR"

  cat > "$MANIFEST_DIR/com.pi.annotate.json" <<EOF
{
  "name": "com.pi.annotate",
  "description": "Pi Annotate native messaging host",
  "path": $MANIFEST_PATH_JSON,
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

  echo "Installed native host manifest to: $MANIFEST_DIR/com.pi.annotate.json"
done

echo "Fully quit and reopen the browser you loaded the extension in."
