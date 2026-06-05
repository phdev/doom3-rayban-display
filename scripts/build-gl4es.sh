#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${GL4ES_BUILD_DIR:-$ROOT_DIR/.build/gl4es}"
UPSTREAM_REPO="${GL4ES_REPO:-https://github.com/ptitSeb/gl4es.git}"

if ! command -v emcmake >/dev/null 2>&1; then
  echo "emcmake was not found. Install and activate the Emscripten SDK first." >&2
  exit 1
fi

if [[ ! -d "$BUILD_DIR/.git" ]]; then
  mkdir -p "$(dirname "$BUILD_DIR")"
  git clone --depth 1 "$UPSTREAM_REPO" "$BUILD_DIR"
fi

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
