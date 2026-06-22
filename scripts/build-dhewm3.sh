#!/usr/bin/env bash
set -euo pipefail

# Build dhewm3 (DOOM 3) as a WebAssembly engine for Meta Ray-Ban Display.
#
# This is an EXPERIMENTAL target: dhewm3 does not ship an official Emscripten
# build. The patches in patches/rayban-base.patch + patches/rayban-renderer.patch are
# generated against the pinned commit below (split by file: neo/renderer vs the rest, so the
# renderer and game/combat can be regenerated independently); if you bump DHEWM3_COMMIT you may
# need to regenerate them. See NOTICE.md / README.md for status.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BUILD_DIR="${DHEWM3_BUILD_DIR:-$ROOT_DIR/.build/dhewm3}"
UPSTREAM_REPO="${DHEWM3_REPO:-https://github.com/dhewm/dhewm3.git}"
DHEWM3_COMMIT="${DHEWM3_COMMIT:-8ebc11260d52638d2aff12ce73fbfccaa70db1b9}"
BASE_PATCH="$ROOT_DIR/patches/rayban-base.patch"
RENDER_PATCH="$ROOT_DIR/patches/rayban-renderer.patch"
PUBLIC_WASM="$ROOT_DIR/public/wasm"
EMBED_DIR="$BUILD_DIR/neo/sys/wasm/embed"
# Vendored OpenAL-Soft EFX headers — Emscripten's OpenAL port ships only stub
# AL/alext.h without the EFX/ALC-extension typedefs dhewm3's sound system needs.
VENDOR_EFX="$ROOT_DIR/vendor/openal-efx"

if ! command -v emcmake >/dev/null 2>&1; then
  echo "emcmake was not found. Install and activate the Emscripten SDK first." >&2
  exit 1
fi

if [[ -z "${GL4ES_PATH:-}" || ! -d "$GL4ES_PATH" ]]; then
  echo "Set GL4ES_PATH to a GL4ES build directory compiled with Emscripten (run build:gl4es)." >&2
  exit 1
fi

if [[ ! -d "$BUILD_DIR/.git" ]]; then
  mkdir -p "$(dirname "$BUILD_DIR")"
  git clone "$UPSTREAM_REPO" "$BUILD_DIR"
fi

cd "$BUILD_DIR"
git fetch --all --tags --quiet || true
git checkout --quiet "$DHEWM3_COMMIT"
git reset --hard --quiet "$DHEWM3_COMMIT"
# The patch ADDS new files (d3_wearable.cpp, the WebGPU backend, neo/sys/wasm,
# etc.). Those are untracked, so `git reset --hard` does NOT remove them, and a
# subsequent `git apply` aborts with "already exists in working directory" —
# which previously fell through to "continuing" and silently built the
# UNPATCHED tree (e.g. -march=pentium3 reaching wasm32 → idlib build failure).
# Clean untracked files under neo/ so the patch always applies to a pristine
# tree. The CMake build dir lives at $BUILD_DIR/build (outside neo/), so this
# preserves incremental build state.
git clean -fdq neo

# The Ray-Ban patch is SPLIT into two disjoint-file patches so the renderer (Session D) and the
# game/combat (Session A) can be regenerated INDEPENDENTLY without clobbering one shared file:
#   rayban-base.patch     = everything EXCEPT neo/renderer (game/combat, sys, framework, cm, CMakeLists, ...)
#   rayban-renderer.patch = neo/renderer (the WebGPU backend)
# They touch DISJOINT files, so they apply in either order and together == the old single patch
# (proven by a git tree-hash compare). Regenerate ONLY your half (run in $BUILD_DIR after editing):
#   base:     git add -A -N neo && git diff -- . ':!neo/renderer' > "$ROOT_DIR"/patches/rayban-base.patch
#   renderer: git add -A -N neo && git diff -- neo/renderer        > "$ROOT_DIR"/patches/rayban-renderer.patch
for P in "$BASE_PATCH" "$RENDER_PATCH"; do
  if git apply --check "$P" >/dev/null 2>&1; then
    git apply "$P"; echo "Applied $(basename "$P")."
  else
    echo "ERROR: $(basename "$P") does not apply cleanly to $DHEWM3_COMMIT; aborting" >&2
    echo "       (regenerate it from the working tree — see the comment above)" >&2
    exit 1
  fi
done

# Generate embedded WGSL header from webgpu-port/shaders/*.wgsl. The patch's
# RenderBackend_WebGPU.cpp #includes wgsl/embedded_shaders.h which lives
# outside the patch (regenerated each build so shader edits don't require
# re-patching).
WGSL_DIR="$BUILD_DIR/neo/renderer/wgsl"
mkdir -p "$WGSL_DIR"
python3 "$ROOT_DIR/scripts/embed_wgsl.py" "$WGSL_DIR" "$ROOT_DIR/webgpu-port/shaders"

# Files baked into dhewm3.data. The web app shell still installs the user PK4
# and config at runtime; this just guarantees a writable /base exists.
install -d "$EMBED_DIR/base"
cat > "$EMBED_DIR/base/autoexec.cfg" <<'CFG'
seta com_skipIntroVideos "1"
seta r_fullscreen "0"
seta r_customWidth "600"
seta r_customHeight "600"
seta r_mode "-1"
seta in_mouse "0"
CFG

if [[ -n "${D3_REDUCED_PK4:-}" ]]; then
  install -m 0644 "$D3_REDUCED_PK4" "$EMBED_DIR/base/pak-display.pk4"
fi

# Phase 5 prep: D3_WEBGPU_BACKEND turns on the real WebGPU code path in
# neo/renderer/RenderBackend_WebGPU.cpp (otherwise it's a fail-loud stub).
# --use-port=emdawnwebgpu pulls Dawn into the link. WebGPU is only compiled
# in on Emscripten targets (the only target where it's a thing).
WEBGPU_FLAGS=""
if [[ "${D3_WEBGPU:-1}" == "1" ]]; then
  WEBGPU_FLAGS="-DD3_WEBGPU_BACKEND=1"
fi

emcmake cmake \
  -S "$BUILD_DIR/neo" \
  -B "$BUILD_DIR/build" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCORE=ON \
  -DBASE=ON \
  -DD3XP=OFF \
  -DDEDICATED=OFF \
  -DTOOLS=OFF \
  -DIMGUI=OFF \
  -DSDL2=OFF \
  -DSDL3=ON \
  -DHARDLINK_GAME=ON \
  -DONATIVE=OFF \
  -DD3_EMSCRIPTEN_EMBED="$EMBED_DIR" \
  -DCMAKE_EXE_LINKER_FLAGS="-Wl,--whole-archive ${GL4ES_PATH}/lib/libGL.a -Wl,--no-whole-archive --use-port=emdawnwebgpu" \
  -DCMAKE_C_FLAGS="-I${GL4ES_PATH}/include -I${VENDOR_EFX} --use-port=emdawnwebgpu" \
  -DCMAKE_CXX_FLAGS="-I${GL4ES_PATH}/include -I${VENDOR_EFX} --use-port=emdawnwebgpu ${WEBGPU_FLAGS}"
# NOTE: GL4ES must be whole-archived: dhewm3 resolves GL at runtime via
# gl4es_GetProcAddress, so without --whole-archive the linker dead-strips
# GL4ES's init/proc symbols and every legacy GL call resolves to null.

cmake --build "$BUILD_DIR/build" --parallel "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

install -d "$PUBLIC_WASM"
# Emscripten emits files named after the CMake target (dhewm3).
for artifact in dhewm3.js dhewm3.wasm dhewm3.data; do
  src="$(find "$BUILD_DIR/build" -name "$artifact" -print -quit)"
  if [[ -z "$src" ]]; then
    echo "Expected build artifact not found: $artifact" >&2
    exit 1
  fi
  install -m 0644 "$src" "$PUBLIC_WASM/$artifact"
done

echo "Installed WebAssembly engine artifacts into $PUBLIC_WASM"
