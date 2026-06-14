#!/usr/bin/env bash
set -euo pipefail

# Bake the area-streaming (Phase 4) artifacts from the committed boot pak.
#
# Produces, in public/wasm/base-stream/:
#   pak-display-stream.pk4.NNN  reduced boot pak (enpro.bproc -> boot proc; full
#                               collision/entities/textures) + chunk manifest
#   enpro.areas.stream(.json)   gzip blob of the deferred per-area render parts
#                               (raw verts) + offset manifest
#
# These are loaded only when the app runs with ?areastream (experimental, off by
# default). They are regeneratable build outputs (gitignored); run this after a
# bproc/cache format bump or to retune the boot region.
#
# Usage: scripts/bake-area-stream.sh [boot-areas]
#   boot-areas: comma list of render areas kept resident in the boot pak
#               (default 0-9). Smaller boot region = smaller boot pak.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BASE_STREAM="$ROOT/public/wasm/base-stream"
BOOT_AREAS="${1:-0,1,2,3,4,5,6,7,8,9}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Baking area-streaming artifacts (boot areas: $BOOT_AREAS)"

# 1. reassemble the committed boot pak from its chunks
manifest="$BASE_STREAM/pak-display.pk4.manifest.json"
if [[ ! -f "$manifest" ]]; then
  echo "error: $manifest not found (run build first / chunk-pk4.py)" >&2
  exit 1
fi
python3 - "$BASE_STREAM" "$manifest" "$TMP/pak.pk4" <<'PY'
import json, sys
base, manifest_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
m = json.load(open(manifest_path))
with open(out, "wb") as o:
    for c in m["chunks"]:
        o.write(open(f"{base}/{c['path']}", "rb").read())
print("reassembled pak:", out)
PY

# 2. extract the baked enpro.bproc (raw verts) from the pak
python3 - "$TMP/pak.pk4" "$TMP/enpro.bproc" <<'PY'
import zipfile, sys
z = zipfile.ZipFile(sys.argv[1])
open(sys.argv[2], "wb").write(z.read("maps/game/enpro.bproc"))
print("extracted enpro.bproc")
PY

# 3. split into per-area raw-vert parts + boot proc
python3 "$ROOT/scripts/split-bproc-areas.py" \
  --input "$TMP/enpro.bproc" --output-dir "$TMP/split" --name enpro \
  --boot-areas "$BOOT_AREAS" --verify

# 4. reduced boot pak (boot proc, no parts bundled) -> chunk into base-stream
python3 "$ROOT/scripts/build-stream-test-pak.py" \
  --pak "$TMP/pak.pk4" --split "$TMP/split" --out "$TMP/pak-display-stream.pk4" --no-parts
rm -f "$BASE_STREAM"/pak-display-stream.pk4.*
cp "$TMP/pak-display-stream.pk4" "$BASE_STREAM/pak-display-stream.pk4"
python3 "$ROOT/scripts/chunk-pk4.py" "$BASE_STREAM/pak-display-stream.pk4" 4.0
rm -f "$BASE_STREAM/pak-display-stream.pk4"

# 5. render-parts blob (raw verts) + manifest
python3 "$ROOT/scripts/pack-area-stream.py" \
  --input "$TMP/split" --output-dir "$BASE_STREAM" --name enpro

echo "Done. Run the app with ?areastream to use them."
