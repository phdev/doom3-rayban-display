#!/usr/bin/env bash
set -euo pipefail

# Prepare a display-optimized DOOM 3 PK4 from data you legally own.
#
# DOOM 3 game data is proprietary and is NOT downloaded by this script. Point it
# at your owned data and it will build a reduced single-map pak-display.pk4 plus
# a gzip copy and a chunk manifest for the web app, mirroring the GLQuake II
# Display packaging flow.
#
# Provide ONE of:
#   D3_INPUT_PK4=/path/to/base/pak000.pk4      (a single owned PK4), or
#   D3_DATA_DIR=/path/to/doom3/base            (a dir of owned *.pk4)
#
# Optional:
#   D3_MAP=game/mars_city1     map to keep (default game/mars_city1)
#   D3_MAX_TEXTURE=128         downsize in-pak textures to <= N px (0 = full size;
#                              128 matches the mobile GPU's image_downSizeLimit, so
#                              it is lossless on-device and keeps the pak small)
#   D3_NO_AUDIO=yes            drop all audio (smallest pak); overrides D3_AUDIO_RATE
#   D3_AUDIO_RATE=11025        downsample retained audio (0 to skip)
#   D3_AUDIO_WIDTH=1           audio sample width in bytes
#   D3_CHUNK_SIZE=262144       chunk size for the manifest
#   D3_WRITE_GZIP=yes          also write pak-display.pk4.gz

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${D3_BUILD_DIR:-$ROOT_DIR/.build/d3-data}"
PUBLIC_BASE="$ROOT_DIR/public/wasm/base"
REDUCED_PK4="$BUILD_DIR/pak-display.pk4"
D3_MAP="${D3_MAP:-game/mars_city1}"
D3_AUDIO_RATE="${D3_AUDIO_RATE:-11025}"
D3_AUDIO_WIDTH="${D3_AUDIO_WIDTH:-1}"
D3_CHUNK_SIZE="${D3_CHUNK_SIZE:-262144}"
D3_WRITE_GZIP="${D3_WRITE_GZIP:-yes}"

mkdir -p "$BUILD_DIR" "$PUBLIC_BASE"

INPUT_PK4=""
if [[ -n "${D3_INPUT_PK4:-}" ]]; then
  INPUT_PK4="$D3_INPUT_PK4"
elif [[ -n "${D3_DATA_DIR:-}" ]]; then
  # Merge all owned base PK4s (ZIP archives) into one combined archive first.
  COMBINED="$BUILD_DIR/combined.pk4"
  python3 "$ROOT_DIR/scripts/pk4tool.py" --merge "$D3_DATA_DIR" --output "$COMBINED"
  INPUT_PK4="$COMBINED"
else
  cat >&2 <<'MSG'
No DOOM 3 data provided.

Set D3_INPUT_PK4 to an owned base/pak000.pk4, or D3_DATA_DIR to an owned
base/ directory containing your *.pk4 files. DOOM 3 data is proprietary and is
not distributed with this project.
MSG
  exit 1
fi

if [[ ! -f "$INPUT_PK4" ]]; then
  echo "Input PK4 not found: $INPUT_PK4" >&2
  exit 1
fi

REDUCE_ARGS=(--input "$INPUT_PK4" --map "$D3_MAP" --output "$REDUCED_PK4")
if [[ "${D3_MAX_TEXTURE:-128}" != "0" ]]; then
  REDUCE_ARGS+=(--max-texture "${D3_MAX_TEXTURE:-128}")
fi
if [[ "${D3_NO_AUDIO:-}" == "yes" ]]; then
  REDUCE_ARGS+=(--no-audio)
elif [[ "$D3_AUDIO_RATE" != "0" ]]; then
  REDUCE_ARGS+=(--audio-rate "$D3_AUDIO_RATE" --audio-width "$D3_AUDIO_WIDTH")
fi

python3 "$ROOT_DIR/scripts/reduce-d3-map-pk4.py" "${REDUCE_ARGS[@]}"
install -m 0644 "$REDUCED_PK4" "$PUBLIC_BASE/pak-display.pk4"

if [[ "$D3_WRITE_GZIP" == "yes" ]]; then
  gzip -c -9 "$PUBLIC_BASE/pak-display.pk4" > "$PUBLIC_BASE/pak-display.pk4.gz"
fi

python3 - "$PUBLIC_BASE/pak-display.pk4" "$D3_CHUNK_SIZE" <<'PY'
import hashlib
import json
import math
import sys
from pathlib import Path

pk4_path = Path(sys.argv[1])
chunk_size = int(sys.argv[2])
sources = [pk4_path]
gzip_path = Path(f"{pk4_path}.gz")

if gzip_path.exists():
    sources.append(gzip_path)

for source in sources:
    data = source.read_bytes()
    chunks = []
    count = math.ceil(len(data) / chunk_size)

    for index in range(count):
        chunk = data[index * chunk_size:(index + 1) * chunk_size]
        chunk_name = f"{source.name}.part{index:03d}"
        (source.parent / chunk_name).write_bytes(chunk)
        chunks.append({
            "path": chunk_name,
            "size": len(chunk),
            "sha256": hashlib.sha256(chunk).hexdigest(),
        })

    manifest = {
        "format": "d3-pk4-chunks-v1",
        "name": source.name,
        "encoding": "gzip" if source.suffix == ".gz" else "identity",
        "chunkSize": chunk_size,
        "totalSize": len(data),
        "sha256": hashlib.sha256(data).hexdigest(),
        "chunks": chunks,
    }

    (source.parent / f"{source.name}.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
PY

echo "Installed display PK4 into $PUBLIC_BASE"
