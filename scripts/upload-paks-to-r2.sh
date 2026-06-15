#!/usr/bin/env bash
#
# Upload the display paks to a Cloudflare R2 bucket (S3-compatible), so they can
# be served to the hosted app via ?pak=<public-base-url>. The paks are NOT in
# the repo (they contain reduced DOOM 3 game data); the engine .js/.wasm/.data
# stay on GitHub Pages.
#
# Prereqs:
#   1. A Cloudflare R2 bucket with PUBLIC access (enable the r2.dev public URL,
#      or attach a custom domain).
#   2. CORS on the bucket allowing your GitHub Pages origin to GET. Example
#      rule (R2 dashboard -> bucket -> Settings -> CORS Policy):
#        [{ "AllowedOrigins": ["https://phdev.github.io"],
#           "AllowedMethods": ["GET","HEAD"],
#           "AllowedHeaders": ["*"] }]
#   3. aws-cli configured with your R2 credentials (R2 is S3-compatible):
#        aws configure  # use your R2 Access Key ID / Secret Access Key
#
# Usage:
#   R2_BUCKET=<bucket> \
#   R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com \
#   [R2_PREFIX=doom3] \
#     scripts/upload-paks-to-r2.sh
#
# Then launch the app with the bucket's PUBLIC base URL (the folder that contains
# base/, base-stream/, base256/), URL-encoded after ?pak= :
#   https://phdev.github.io/doom3-rayban-display/?pak=https%3A%2F%2F<public-host>%2Fdoom3%2F
#
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${R2_BUCKET:?set R2_BUCKET}"
: "${R2_ENDPOINT:?set R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com}"
PREFIX="${R2_PREFIX:-doom3}"

for d in base base-stream base256; do
  src="$ROOT/public/wasm/$d"
  [ -d "$src" ] || { echo "skip $d (not present)"; continue; }
  echo "Uploading $src -> s3://$R2_BUCKET/$PREFIX/$d ..."
  # Long-cache the immutable chunked paks; let aws-cli infer content-types by
  # extension (.json -> application/json, chunks -> binary). Do NOT set
  # content-encoding on the .stream blobs (the app inflates them itself).
  aws s3 sync "$src" "s3://$R2_BUCKET/$PREFIX/$d" \
    --endpoint-url "$R2_ENDPOINT" --no-progress \
    --cache-control "public, max-age=31536000, immutable"
done

echo
echo "Done. Pak base = <your public R2 URL>/$PREFIX/"
echo "Launch: https://phdev.github.io/doom3-rayban-display/?pak=<url-encoded public base>"
