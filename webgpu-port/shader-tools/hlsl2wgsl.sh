#!/usr/bin/env bash
# HLSL → SPIR-V → WGSL conversion pipeline.
#
# Toolchain (install via brew):
#   brew install shaderc          # provides glslc (HLSL → SPIR-V)
#   brew install naga-cli         # provides naga (SPIR-V → WGSL)
#
# HLSL caveat: source must use [[vk::binding(slot, set)]] decorators
# rather than register(t0)/register(s0) — naga rejects the latter due
# to slot conflicts between SRV/sampler/CBV/UAV (all use slot 0 in
# different register classes; SPIR-V flattens them and they collide).
# For RBDOOM-3-BFG shader corpus, this means writing a preprocessing
# step (Phase 6 follow-up) that rewrites register(tN)/(sN)/(bN) into
# vk::binding decorators with a non-overlapping mapping.
#
# Usage:
#   ./hlsl2wgsl.sh <input.hlsl> <stage> [<entry>]
#     stage:  vertex | fragment | compute
#     entry:  default "main"

set -euo pipefail
if [ "$#" -lt 2 ]; then
  echo "usage: $0 <input.hlsl> <stage:vertex|fragment|compute> [<entry>]" >&2
  exit 1
fi
IN="$1"
STAGE="$2"
ENTRY="${3:-main}"

BASE="${IN%.hlsl}"
SPV="${BASE}.${STAGE}.spv"
WGSL="${BASE}.${STAGE}.wgsl"

echo "[$STAGE/$ENTRY] $IN"
echo "  HLSL → SPIR-V via glslc"
glslc -x hlsl \
  -fshader-stage="$STAGE" \
  --target-env=vulkan1.1 \
  -fentry-point="$ENTRY" \
  "$IN" -o "$SPV"

echo "  SPIR-V → WGSL via naga"
naga "$SPV" "$WGSL"

echo "  Wrote $WGSL ($(wc -c < "$WGSL") bytes)"
