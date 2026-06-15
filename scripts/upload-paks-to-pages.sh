#!/usr/bin/env bash
#
# Deploy the display paks to Cloudflare Pages (used when R2 is not enabled on the
# account). Pages is public by default and gets CORS from a _headers file, so the
# hosted app can fetch the paks cross-origin via ?pak=https://<project>.pages.dev/.
#
# Stages base/ (monolith, the ?noareastream fallback) + the LEAN areastream set
# (the files the default config actually fetches — not the now-dead texture-stream
# blobs) + a CORS _headers file, then deploys with wrangler.
#
# Prereqs: wrangler authenticated to your Cloudflare account, e.g.
#   export CLOUDFLARE_API_TOKEN=...   export CLOUDFLARE_ACCOUNT_ID=...
#   (or run `wrangler login`)
#
# Usage:
#   [CF_PAGES_PROJECT=doom3-pak] scripts/upload-paks-to-pages.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT="${CF_PAGES_PROJECT:-doom3-pak}"
W="$ROOT/public/wasm"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/base-stream"
cp -r "$W/base" "$STAGE/base"
cp "$W"/base-stream/pak-display-stream.pk4.0*          "$STAGE/base-stream/"
cp "$W"/base-stream/pak-display-stream.pk4.manifest.json "$STAGE/base-stream/"
cp "$W"/base-stream/enpro.areas.stream*                "$STAGE/base-stream/"
# Add base256/ too if you want ?hd support:
#   cp -r "$W/base256" "$STAGE/base256"

printf '/*\n  Access-Control-Allow-Origin: *\n  Cross-Origin-Resource-Policy: cross-origin\n  Cache-Control: public, max-age=31536000, immutable\n' > "$STAGE/_headers"

echo "Staged $(du -sh "$STAGE" | cut -f1) ($(find "$STAGE" -type f | wc -l | tr -d ' ') files) -> Pages project '$PROJECT'"
wrangler pages project create "$PROJECT" --production-branch main 2>/dev/null || true
wrangler pages deploy "$STAGE" --project-name "$PROJECT" --branch main --commit-dirty=true

echo
echo "Done -> https://$PROJECT.pages.dev/"
echo "Launch: https://phdev.github.io/doom3-rayban-display/?pak=https://$PROJECT.pages.dev/"
