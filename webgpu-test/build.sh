#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../public/wasm-webgpu"
mkdir -p "$OUT"

# Build a specific target: ./build.sh [triangle|wall|all]
TARGET="${1:-all}"

build_one() {
  local name="$1"
  local export_name="$2"
  emcc "$HERE/${name}.cpp" \
    --use-port=emdawnwebgpu \
    -O2 -std=c++17 \
    -sASYNCIFY=0 \
    -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=64MB \
    -sMODULARIZE=1 \
    -sEXPORT_ES6=1 \
    -sEXPORT_NAME="${export_name}" \
    -sENVIRONMENT=web \
    -o "$OUT/${name}.js"
  echo "Built $OUT/${name}.{js,wasm}"
}

case "$TARGET" in
  triangle) build_one triangle WebGPUTriangle ;;
  wall)     build_one wall     WebGPUWall ;;
  all)      build_one triangle WebGPUTriangle; build_one wall WebGPUWall ;;
  *)        echo "Unknown target: $TARGET. Use triangle | wall | all"; exit 1 ;;
esac
ls -la "$OUT"
