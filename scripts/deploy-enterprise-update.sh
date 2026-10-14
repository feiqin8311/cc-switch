#!/usr/bin/env bash
# Publish the signed desktop build(s) to the enterprise server over SSH, so
# installed clients pick up the new version (background download, then a
# "restart now" prompt).
#
#   export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.cc-switch/enterprise-updater.key"
#   pnpm tauri build                       # after bumping the version
#   scripts/deploy-enterprise-update.sh --base https://ccse.example.com --notes "修复 xx"
#
# Run it once per platform build of the same version (e.g. the macOS bundle
# here, then the Windows bundle via --bundle <dir>); platforms are merged.
#
# Options:
#   --host   SSH target                      (default: $CCSE_DEPLOY_HOST)
#   --base   public server URL clients use   (default: $CCSE_PUBLIC_URL)
#   --dir    updates dir on the server       (default: <host path of the server
#            container's /data>/updates, found via docker)
#   --notes  release notes shown in the dialog
#   --bundle bundle dir to publish           (default: src-tauri/target/release/bundle)
set -euo pipefail

host="${CCSE_DEPLOY_HOST:-}"
base="${CCSE_PUBLIC_URL:-}"
dir=""
chown_cmd=""
notes="Enterprise update"
bundle="src-tauri/target/release/bundle"

while [ $# -gt 0 ]; do
  case "$1" in
    --host) host="$2"; shift 2 ;;
    --base) base="$2"; shift 2 ;;
    --dir) dir="$2"; shift 2 ;;
    --notes) notes="$2"; shift 2 ;;
    --bundle) bundle="$2"; shift 2 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ -z "$host" ] || [ -z "$base" ]; then
  echo "usage: $0 --host root@server --base https://server [--notes text] [--bundle dir] [--dir path]" >&2
  exit 2
fi
base="${base%/}"
cd "$(dirname "$0")/.."

if [ -z "$dir" ]; then
  # Host path of /data in the compose "server" container (named volume or bind mount).
  data=$(ssh "$host" 'docker inspect -f "{{range .Mounts}}{{if eq .Destination \"/data\"}}{{.Source}}{{end}}{{end}}" \
    $(docker ps -q --filter label=com.docker.compose.service=server | head -n1)' 2>/dev/null || true)
  if [ -z "$data" ]; then
    echo "Could not find the server container's /data on $host; pass --dir." >&2
    exit 1
  fi
  dir="$data/updates"
  # The container runs as node (uid 1000).
  chown_cmd="chown -R 1000:1000 '$dir' && "
fi

staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT

# Start from the live manifest so another platform of the same version is kept.
scp -q "$host:$dir/latest.json" "$staging/latest.json" 2>/dev/null || true
node scripts/publish-enterprise-update.mjs --base "$base" --out "$staging" --notes "$notes" --bundle "$bundle"

# Bundles first, manifest last: clients never see a manifest pointing at a missing file.
ssh "$host" "mkdir -p '$dir'"
rsync -a --chmod=F644 --exclude latest.json "$staging/" "$host:$dir/"
rsync -a --chmod=F644 "$staging/latest.json" "$host:$dir/latest.json.tmp"
ssh "$host" "${chown_cmd}mv '$dir/latest.json.tmp' '$dir/latest.json'"

echo "Live manifest:"
curl -fsS "$base/updates/latest.json"
