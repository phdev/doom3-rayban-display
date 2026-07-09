#!/usr/bin/env bash
# gates/inspect_render/run_gate.sh — the `inspect_render_stable` canonical gate (R3-ENGINE-RENDER).
#
# OFFLINE (localhost vite preview + installed Chrome, NO network) but HEADED: needs a logged-in Mac
# GUI session. Headless Chrome composites the WebGPU canvas black and demotes to GL, so this gate
# CANNOT run on a headless/SSH-only box (gate_env=gui_required in gates.offline.json).
#
# CLAUSES (the contract):
#   0  preflight: paks + built engine wasm + dist/ + Chrome + fixture present (else RED missing-fixture)
#   1  COLD RUN A: fresh Chrome -> render-frame.mjs on the committed fixture -> H1 + frame.png + json
#   2  vacuity guard (bootstrap-safe): nonblack >= 1% AND >= 64 distinct colours (ABSOLUTE floor,
#      every run); from run 2 on ALSO >= 50% of the accepted first-baseline's measured values
#   3  COLD RUN B: a FULLY FRESH process -> H2. H1==H2 REQUIRED (the per-run determinism SELF-PROOF)
#   4  baseline: key = {hwModel,macosBuild,chromeVersion,engineWasmSha,pakSha,fixtureSha,tick,WxH,
#      cvarSetHash}. clean: missing->WRITE + baseline_created (Spine-eyeball note); match->GREEN
#      baseline_matched; stable-but-different->RED regression. Also asserts scene_source stamped in
#      --json + sidecar + FILENAME (owner amendment 1).
#
# RF_GATE_MUTATE=<MUT-A|MUT-B|MUT-C1|MUT-C2|MUT-D|MUT-E>: gate-internal fault injection (never the
# frozen CLI seam). MUTATE-MODE LAW: baseline WRITES ARE DISABLED and comparison pins to the COMMITTED
# baseline, so a mutation can only route to a NAMED RED, never baseline_created/GREEN.
#
# The gate HASHES the raw padding-stripped, alpha-forced pixels (rawHash from render-frame --json);
# the PNG is an artifact only. The clean run prints "VERDICT: GREEN <baseline_created|baseline_matched>";
# every mutation prints "VERDICT: RED <class>" and exits nonzero.

set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GATE="$ROOT/gates/inspect_render"
FIX="$GATE/fixtures/wall-stuck-t14.scene.json"
BASELINES="$GATE/baselines"
PORT="${RF_GATE_PORT:-4190}"
URL="http://localhost:$PORT/"
MUT="${RF_GATE_MUTATE:-}"
WORK="$(mktemp -d)"
PREVIEW_PID=""
cleanup() { local rc=$?; [ -n "$PREVIEW_PID" ] && kill "$PREVIEW_PID" 2>/dev/null; rm -rf "$WORK"; exit $rc; }
trap cleanup EXIT

red()   { echo "VERDICT: RED $1"; [ -n "${2:-}" ] && echo "$2"; exit 1; }
green() { echo "VERDICT: GREEN $1"; [ -n "${2:-}" ] && echo "$2"; exit 0; }

# jget FILE JSPATH  -> prints the field (empty string if absent)
jget() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const v=eval("d"+process.argv[2]);process.stdout.write(v==null?"":String(v))' "$1" "$2"; }

# ---- CLAUSE 0: preflight (RED missing-fixture, item NAMED) ----
[ -f "$ROOT/public/wasm/dhewm3.wasm" ]   || red missing-fixture "engine wasm public/wasm/dhewm3.wasm absent (STAGING build)"
[ -d "$ROOT/public/wasm/base-stream" ]   || red missing-fixture "pak public/wasm/base-stream absent (STAGING pak copy)"
[ -d "$ROOT/dist" ]                       || red missing-fixture "web app dist/ absent (STAGING npm run build)"
[ -d "/Applications/Google Chrome.app" ]  || red missing-fixture "Google Chrome not installed (headed WebGPU needs installed Chrome)"
[ -f "$FIX" ]                             || red missing-fixture "committed fixture $FIX absent"
command -v node >/dev/null                || red missing-fixture "node not on PATH"
command -v curl >/dev/null                || red missing-fixture "curl not on PATH"
echo "[gate] CLAUSE 0 preflight OK  (mut='${MUT:-none}')"

# ---- serve the worktree build (offline) ----
( cd "$ROOT" && exec npx vite preview --port "$PORT" --strictPort ) >"$WORK/preview.log" 2>&1 &
PREVIEW_PID=$!
for i in $(seq 1 40); do curl -sf -o /dev/null "$URL" && break; sleep 0.5; done
curl -sf -o /dev/null "$URL" || red missing-fixture "vite preview did not come up on $PORT (see $WORK/preview.log)"

# run_driver DRIVER_MUT OUT JSON  -> sets DRV_RC
run_driver() {
  RF_GATE_MUTATE="$1" RF_GATE_STAGGER_MS="${RF_GATE_STAGGER_MS:-0}" \
    node "$ROOT/scripts/render-frame.mjs" --scene "$FIX" --out "$2" --url "$URL" --json >"$3" 2>"$3.err"
  DRV_RC=$?
}

# assert_scene_source JSON  -> RED scene-source-missing if the stamp is not consistent in all 3 places
assert_scene_source() {
  local j="$1" ss out fnss
  ss="$(jget "$j" '.scene_source')"
  out="$(jget "$j" '.out')"
  [ "$ss" = "map-pose:game/enpro" ] || red scene-source-missing "scene_source in --json is '$ss' (expected map-pose:game/enpro)"
  [ -f "$out.json" ] || red scene-source-missing "PNG sidecar $out.json missing"
  [ "$(jget "$out.json" '.scene_source')" = "map-pose:game/enpro" ] || red scene-source-missing "scene_source missing/wrong in PNG sidecar"
  case "$(basename "$out")" in *map-pose.enpro*) fnss=ok;; *) red scene-source-missing "output filename lacks the scene_source token: $out";; esac
}

# compute the baseline key string + its keyfile path from a driver json
key_str() { node -e '
  const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  const k=[d.device,d.macosBuild,d.chromeVersion,d.engineWasmSha,d.pakSha,d.fixtureSha,String(d.tick),d.w+"x"+d.h,d.cvarSetHash];
  process.stdout.write(k.join("|"));' "$1"; }
key_id() { node -e 'const c=require("crypto");process.stdout.write(c.createHash("sha256").update(process.argv[1]).digest("hex").slice(0,20))' "$1"; }

# ==================================================================================================
# MUTATION FLOWS (each asserts a NAMED RED; baseline writes are DISABLED here by construction)
# ==================================================================================================
if [ -n "$MUT" ]; then
  case "$MUT" in
    MUT-C1) # wrong-backend: ?backend=gl -> __d3FrameCapture never publishes -> driver exit 2
      run_driver wrong-backend "$WORK/c1.png" "$WORK/c1.json"
      [ "$DRV_RC" = "2" ] && red wrong-backend "driver exit 2 (WebGPU backend not active under ?backend=gl) — as expected"
      red gate-error "MUT-C1 expected driver exit 2, got $DRV_RC (see $WORK/c1.json.err)";;
    MUT-C2) # vacuous: driver injects a blank frame -> CLAUSE-2 floor trips
      run_driver vacuous "$WORK/c2.png" "$WORK/c2.json"
      [ "$DRV_RC" = "0" ] || red gate-error "MUT-C2 driver failed rc=$DRV_RC (see $WORK/c2.json.err)"
      nb="$(jget "$WORK/c2.json" '.nonblackFrac')"; dc="$(jget "$WORK/c2.json" '.distinctColors')"
      node -e 'process.exit((Number(process.argv[1])>=0.01 && Number(process.argv[2])>=64)?0:1)' "$nb" "$dc" \
        && red gate-error "MUT-C2 frame not vacuous (nonblack=$nb colors=$dc) — floor did not trip" \
        || red vacuous "blank frame caught by CLAUSE-2 floor (nonblack=$nb colors=$dc < 1%/64) — as expected";;
    MUT-D) # tuple-spoof: chromeVersion spoofed -> no matching baseline; mutate mode = writes DISABLED
      run_driver tuple-spoof "$WORK/d.png" "$WORK/d.json"
      [ "$DRV_RC" = "0" ] || red gate-error "MUT-D driver failed rc=$DRV_RC"
      kf="$BASELINES/dev-$(key_id "$(key_str "$WORK/d.json")").json"
      [ -f "$kf" ] && red gate-error "MUT-D spoofed key unexpectedly matched a baseline ($kf)" \
                   || red baseline-missing "spoofed chromeVersion -> no baseline for tuple; writes DISABLED in mutate mode — as expected";;
    MUT-E) # scene-source-strip: sidecar loses the stamp -> consistency check fails
      run_driver scene-source-strip "$WORK/e.png" "$WORK/e.json"
      [ "$DRV_RC" = "0" ] || red gate-error "MUT-E driver failed rc=$DRV_RC"
      assert_scene_source "$WORK/e.json"   # this RED-scene-source-missings by construction
      red gate-error "MUT-E stripped stamp was not caught";;
    MUT-B) # pose-perturb: deterministic (H1==H2) but != committed baseline -> RED regression
      run_driver pose-perturb "$WORK/b1.png" "$WORK/b1.json"; [ "$DRV_RC" = "0" ] || red gate-error "MUT-B run1 rc=$DRV_RC"
      run_driver pose-perturb "$WORK/b2.png" "$WORK/b2.json"; [ "$DRV_RC" = "0" ] || red gate-error "MUT-B run2 rc=$DRV_RC"
      h1="$(jget "$WORK/b1.json" '.rawHash')"; h2="$(jget "$WORK/b2.json" '.rawHash')"
      [ "$h1" = "$h2" ] || red gate-error "MUT-B not deterministic ($h1 != $h2) — cannot test regression path"
      kf="$BASELINES/dev-$(key_id "$(key_str "$WORK/b1.json")").json"
      [ -f "$kf" ] || red gate-error "MUT-B needs a committed clean baseline to compare against ($kf absent) — run the clean gate first"
      base="$(jget "$kf" '.rawHash')"
      [ "$h1" = "$base" ] && red gate-error "MUT-B perturbed hash equals baseline — perturbation had no effect" \
                          || red regression "perturbed pose stable ($h1) but != committed baseline ($base); writes DISABLED — as expected";;
    MUT-A) # unfreeze-stagger: two UNFROZEN captures at different game-time -> H1 != H2
      run_driver unfreeze-stagger "$WORK/a1.png" "$WORK/a1.json"; [ "$DRV_RC" = "0" ] || red gate-error "MUT-A run1 rc=$DRV_RC (see err)"
      RF_GATE_STAGGER_MS=600 run_driver unfreeze-stagger "$WORK/a2.png" "$WORK/a2.json"; [ "$DRV_RC" = "0" ] || red gate-error "MUT-A run2 rc=$DRV_RC"
      h1="$(jget "$WORK/a1.json" '.rawHash')"; h2="$(jget "$WORK/a2.json" '.rawHash')"
      if [ "$h1" != "$h2" ]; then red nondeterministic "unfrozen staggered captures differ ($h1 != $h2) — CLAUSE-3 self-proof would catch a real leak — as expected"; fi
      echo "[gate] MUT-A unfreeze-stagger did not force a diff; trying pre-authorized fallback noboot-barrier"
      run_driver noboot-barrier "$WORK/a3.png" "$WORK/a3.json"; [ "$DRV_RC" = "0" ] || red gate-error "MUT-A fallback run1 rc=$DRV_RC"
      sleep 1
      run_driver noboot-barrier "$WORK/a4.png" "$WORK/a4.json"; [ "$DRV_RC" = "0" ] || red gate-error "MUT-A fallback run2 rc=$DRV_RC"
      h3="$(jget "$WORK/a3.json" '.rawHash')"; h4="$(jget "$WORK/a4.json" '.rawHash')"
      [ "$h3" != "$h4" ] && red nondeterministic "noboot-barrier fallback captures differ ($h3 != $h4) — as expected" \
                         || red gate-error "MUT-A could not force H1!=H2 (unfreeze $h1/$h2, fallback $h3/$h4) — report per STOP (v)";;
    *) red gate-error "unknown RF_GATE_MUTATE '$MUT'";;
  esac
fi

# ==================================================================================================
# CLEAN FLOW (no mutation)
# ==================================================================================================
# CLAUSE 1: COLD RUN A
run_driver "" "$WORK/a.png" "$WORK/runA.json"
[ "$DRV_RC" = "2" ] && red wrong-backend "run A: WebGPU backend not active (see $WORK/runA.json.err)"
[ "$DRV_RC" = "3" ] && red missing-fixture "run A: $(cat "$WORK/runA.json.err" | tail -1)"
[ "$DRV_RC" = "0" ] || red gate-error "run A failed rc=$DRV_RC ($(tail -1 "$WORK/runA.json.err"))"
H1="$(jget "$WORK/runA.json" '.rawHash')"; WxH="$(jget "$WORK/runA.json" '.w')x$(jget "$WORK/runA.json" '.h')"
echo "[gate] CLAUSE 1 run A: H1=$H1  ${WxH}"
assert_scene_source "$WORK/runA.json"   # owner amendment 1

# CLAUSE 2: vacuity guard
NB="$(jget "$WORK/runA.json" '.nonblackFrac')"; DC="$(jget "$WORK/runA.json" '.distinctColors')"
node -e 'process.exit((Number(process.argv[1])>=0.01 && Number(process.argv[2])>=64)?0:1)' "$NB" "$DC" \
  || red vacuous "frame fails ABSOLUTE floor (nonblack=$NB < 1% OR colors=$DC < 64) — a black canvas hashes identical trivially"
KID="$(key_id "$(key_str "$WORK/runA.json")")"; KF="$BASELINES/dev-$KID.json"
if [ -f "$KF" ]; then
  BNB="$(jget "$KF" '.nonblackFrac')"; BDC="$(jget "$KF" '.distinctColors')"
  node -e 'process.exit((Number(process.argv[1])>=0.5*Number(process.argv[3]) && Number(process.argv[2])>=0.5*Number(process.argv[4]))?0:1)' "$NB" "$DC" "$BNB" "$BDC" \
    || red vacuous "frame below CALIBRATED floor (nonblack $NB vs baseline $BNB; colors $DC vs $BDC; <50%)"
fi
echo "[gate] CLAUSE 2 vacuity OK  (nonblack=$NB colors=$DC)"

# CLAUSE 3: COLD RUN B (fully fresh process) — H1==H2 REQUIRED (per-run determinism self-proof)
run_driver "" "$WORK/b.png" "$WORK/runB.json"
[ "$DRV_RC" = "0" ] || red gate-error "run B failed rc=$DRV_RC ($(tail -1 "$WORK/runB.json.err"))"
H2="$(jget "$WORK/runB.json" '.rawHash')"
echo "[gate] CLAUSE 3 run B: H2=$H2"
if [ "$H1" != "$H2" ]; then
  cp "$WORK/a.png" "$GATE/nondeterministic-A.png" 2>/dev/null || true
  cp "$WORK/b.png" "$GATE/nondeterministic-B.png" 2>/dev/null || true
  red nondeterministic "H1=$H1 != H2=$H2 — cross-invocation NOT byte-stable; A/B PNGs dumped to $GATE/nondeterministic-{A,B}.png"
fi

# CLAUSE 4: baseline
if [ -n "$MUT" ]; then red gate-error "reached clean CLAUSE 4 in mutate mode — should not happen"; fi
if [ ! -f "$KF" ]; then
  node -e '
    const fs=require("fs"); const j=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const rec={ device:j.device, macosBuild:j.macosBuild, chromeVersion:j.chromeVersion, engineWasmSha:j.engineWasmSha,
      pakSha:j.pakSha, fixtureSha:j.fixtureSha, tick:j.tick, w:j.w, h:j.h, cvarSetHash:j.cvarSetHash,
      rawHash:j.rawHash, nonblackFrac:j.nonblackFrac, distinctColors:j.distinctColors, scene_source:j.scene_source,
      created:"baseline_created", spine_eyeball:"PENDING — first-baseline frame artifact must be Spine-EYEBALLED and recorded in the baseline_created receipt" };
    fs.writeFileSync(process.argv[2], JSON.stringify(rec,null,2)+"\n");' "$WORK/runA.json" "$KF"
  cp "$WORK/a.png" "$GATE/baseline-preview.png" 2>/dev/null || true
  green baseline_created "wrote $KF (rawHash=$H1); first-baseline PNG at $GATE/baseline-preview.png — Spine MUST eyeball it + record in the receipt"
fi
BASE="$(jget "$KF" '.rawHash')"
[ "$H1" = "$BASE" ] && green baseline_matched "rawHash $H1 == baseline ($KF); H1==H2 self-proof held" \
                   || red regression "stable rawHash $H1 != baseline $BASE ($KF) — env/no-op drift (a wasm change legitimately rotates the key instead)"
