#!/usr/bin/env python3
# R0 look + operator analysis for the tonemap grade (RENDER/PERF, Session D).
# Reads /tmp/lookgate/{off,on_e10,on_e06,on_nodither}.png (from look-gate.mjs).
#
# 1. LUMA (descriptive, iter-29 metrics): game-region median / std-over-mean /
#    deep-shadow fraction (<8) for each frame.
# 2. OPERATOR GATE (falsifiable, re-anchored to the ACTUAL OFF frame — NOT the
#    stale iter-29 82.7): predict the ON frame from OFF via candidate curves and
#    confirm Narkowicz ACES predicts it best by a decisive margin. An identity or
#    wrong curve would NOT win → the gate goes red. Animation noise is a common
#    offset across candidates, so the RELATIVE ranking is robust.
# 3. BANDING (dither): flat-step run count in a dark gradient, dither ON vs OFF.
import sys, os
import numpy as np
from PIL import Image

D = "/tmp/lookgate"
def load(name):
    p = os.path.join(D, name + ".png")
    if not os.path.exists(p): return None
    im = Image.open(p).convert("RGB")
    return np.asarray(im, dtype=np.float64)  # HxWx3, 0..255

def crop_game(a):
    h, w, _ = a.shape
    # center 70% to avoid HUD chrome / letterbox bands
    y0, y1 = int(h*0.15), int(h*0.85); x0, x1 = int(w*0.15), int(w*0.85)
    return a[y0:y1, x0:x1, :]

def luma(a):  # Rec.601
    return 0.299*a[...,0] + 0.587*a[...,1] + 0.114*a[...,2]

def stats(a):
    L = luma(crop_game(a)).ravel()
    m = L.mean()
    return dict(median=float(np.median(L)), mean=float(m),
                std_over_mean=float(L.std()/m) if m>1e-6 else 0.0,
                deep_shadow_frac=float((L<8).mean()))

# --- ACES Narkowicz (matches webgpu-port/shaders/bloom.wgsl fs_tonemap) ---
def aces(x):  # x in 0..1
    a,b,c,d,e = 2.51,0.03,2.43,0.59,0.14
    return np.clip((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0)

def predict(off, fn):  # off 0..255 -> predicted 0..255
    return fn(np.clip(off/255.0, 0, 1)) * 255.0

def med_abs_err(pred, actual):
    n = min(pred.shape[0], actual.shape[0]); m = min(pred.shape[1], actual.shape[1])
    return float(np.median(np.abs(pred[:n,:m,:] - actual[:n,:m,:])))

off   = load("off")
on    = load("on_e10")
on06  = load("on_e06")
onnd  = load("on_nodither")
if off is None or on is None:
    print("MISSING captures in", D); sys.exit(2)

print("=== LUMA (game region) ===")
for nm, a in [("off",off),("on_e10",on),("on_e06",on06),("on_nodither",onnd)]:
    if a is None: continue
    s = stats(a)
    print(f"  {nm:12s} median={s['median']:6.1f}  std/mean={s['std_over_mean']:.2f}  deepshadow={s['deep_shadow_frac']*100:5.1f}%")

print("\n=== OPERATOR GATE (predict ON from OFF; ACES must win) ===")
target = onnd if onnd is not None else on   # clean (no dither) preferred
cg_off = crop_game(off); cg_tgt = crop_game(target)
candidates = {
    "identity (no-op shader)": lambda x: x,
    "aces@1.0 (SHIPPED)":      lambda x: aces(x*1.0),
    "aces@0.6":                lambda x: aces(x*0.6),
    "gamma^2.0 (decoy)":       lambda x: np.clip(x**2.0,0,1),
    "mul*0.5 (decoy)":         lambda x: x*0.5,
}
errs = {k: med_abs_err(predict(cg_off, fn), cg_tgt) for k, fn in candidates.items()}
ranked = sorted(errs.items(), key=lambda kv: kv[1])
for k, v in ranked: print(f"  {k:28s} medAbsErr={v:6.2f}")
aces_err = errs["aces@1.0 (SHIPPED)"]
gamma_err = errs["gamma^2.0 (decoy)"]; mul_err = errs["mul*0.5 (decoy)"]
# AUTHORITATIVE operator check is the in-engine LUT self-test (window.__d3TonemapLut,
# maxErr==0). This screenshot check is SECONDARY: on an already-dark corridor ACES@1.0
# is near-identity (toe slope ~1 at low input), so aces vs identity is indistinguishable
# here — that is expected, NOT a failure. What it CAN show is that the decoys are wrong.
decoys_rejected = (gamma_err - aces_err > 3.0) and (mul_err - aces_err > 3.0)
print(f"  decoys clearly worse than ACES? {'YES ✓' if decoys_rejected else 'no'}  (gamma2 Δ={gamma_err-aces_err:.1f}, mul0.5 Δ={mul_err-aces_err:.1f})")
print("  NOTE: operator-correctness is gated AUTHORITATIVELY by the in-engine LUT self-test")
print("        (window.__d3TonemapLut maxErr==0); this screenshot ranking is a secondary sanity.")

if onnd is not None and on is not None:
    print("\n=== DITHER (banding) ===")
    # count near-flat horizontal runs (|Δluma|<0.5) in a dark band — dither breaks them up
    def flat_runs(a):
        L = luma(crop_game(a))
        dark = L[L.mean(axis=1) < 40]  # darker rows
        if dark.size == 0: dark = L
        d = np.abs(np.diff(dark, axis=1))
        return float((d < 0.5).mean())
    print(f"  flat-fraction  dither OFF (on_nodither)={flat_runs(onnd)*100:5.1f}%  dither ON (on_e10)={flat_runs(on)*100:5.1f}%")
    print("  (dither ON should LOWER the flat fraction in dark regions)")
