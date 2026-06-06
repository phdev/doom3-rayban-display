#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${GL4ES_BUILD_DIR:-$ROOT_DIR/.build/gl4es}"
UPSTREAM_REPO="${GL4ES_REPO:-https://github.com/ptitSeb/gl4es.git}"
# Pin the GL4ES commit so patches/gl4es-*.patch applies cleanly.
GL4ES_COMMIT="${GL4ES_COMMIT:-e6bb082b495820b308d34b9e1338bc87bfa8e2fa}"

if ! command -v emcmake >/dev/null 2>&1; then
  echo "emcmake was not found. Install and activate the Emscripten SDK first." >&2
  exit 1
fi

if [[ ! -d "$BUILD_DIR/.git" ]]; then
  mkdir -p "$(dirname "$BUILD_DIR")"
  git clone --depth 1 "$UPSTREAM_REPO" "$BUILD_DIR"
  git -C "$BUILD_DIR" fetch --depth 1 origin "$GL4ES_COMMIT"
  git -C "$BUILD_DIR" checkout --detach "$GL4ES_COMMIT"
fi

# Reset to the pinned commit, then (re-)apply our GL4ES source patches. The key one is
# gl4es-invariant-position.patch, which makes every vertex shader declare
# `invariant gl_Position;` — DOOM 3 runs a fixed-function depth pre-pass and a separate
# ARB (ftransform) lit pass, and without invariance a tile-based mobile GPU (iPhone)
# compiles them to slightly different depth, so the lit pass's depth-equal test rejects
# every fragment (black scene). Desktop GPUs match by luck, so it only broke on-device.
git -C "$BUILD_DIR" checkout -- . 2>/dev/null || true
for patch in "$ROOT_DIR"/patches/gl4es-*.patch; do
  [ -e "$patch" ] || continue
  git -C "$BUILD_DIR" apply "$patch"
  echo "Applied GL4ES patch: $(basename "$patch")"
done

python3 - "$BUILD_DIR/CMakeLists.txt" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()
needle = "add_definitions("

lines = text.splitlines()
for index, line in enumerate(lines):
    if "CMAKE_SYSTEM_NAME MATCHES \"Emscripten\"" in line:
        for next_index in range(index + 1, min(index + 6, len(lines))):
            if needle in lines[next_index] and "-fPIC" not in lines[next_index]:
                lines[next_index] = lines[next_index].replace(needle, f"{needle}-fPIC ")
                path.write_text("\n".join(lines) + "\n")
                raise SystemExit(0)
        break
PY

emcmake cmake \
  -S "$BUILD_DIR" \
  -B "$BUILD_DIR/build" \
  -DCMAKE_BUILD_TYPE=RelWithDebInfo \
  -DNOX11=ON \
  -DNOEGL=ON \
  -DSTATICLIB=ON

cmake --build "$BUILD_DIR/build" --parallel "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

test -f "$BUILD_DIR/lib/libGL.a"
echo "Built GL4ES static library at $BUILD_DIR/lib/libGL.a"
