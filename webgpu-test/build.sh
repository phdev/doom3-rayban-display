#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../public/wasm-webgpu"
mkdir -p "$OUT"
emcc "$HERE/triangle.cpp" \
  --use-port=emdawnwebgpu \
  -O2 -std=c++17 \
  -sASYNCIFY=0 \
  -sALLOW_MEMORY_GROWTH=1 \
  -sINITIAL_MEMORY=64MB \
  -sMODULARIZE=1 \
  -sEXPORT_ES6=1 \
  -sEXPORT_NAME=WebGPUTriangle \
  -sENVIRONMENT=web \
  -o "$OUT/triangle.js"
echo "Built $OUT/triangle.{js,wasm}"
ls -la "$OUT"
