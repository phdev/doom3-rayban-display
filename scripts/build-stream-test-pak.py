#!/usr/bin/env python3
"""
build-stream-test-pak.py — build a test pak that exercises area streaming
(Phase 1) by swapping the monolithic enpro.bproc for a boot .bproc that omits
the streamed areas, and bundling the per-area render parts as loose entries.

The engine (com_streamAreas 1) then loads only the boot region's _areaN models;
`appendArea N` / D3_AppendArea(N) pulls areadump/_areaN.bproc.part for the rest.
Collision (.bcm), entities (.bmap) are UNCHANGED — only render geometry defers —
so the player can still walk everywhere; deferred areas just render empty until
appended. This isolates the render append path.

Usage:
  python3 scripts/build-stream-test-pak.py \
      --pak /tmp/paktmp/pak-display.pk4 \
      --split /tmp/bproc-split \
      --out /tmp/paktmp/pak-display-stream.pk4
"""
import argparse
import glob
import os
import re
import sys
import zipfile

AREA_RE = re.compile(r"_area(\d+)\.bproc\.part$")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pak", required=True, help="reassembled monolithic pak")
    ap.add_argument("--split", required=True, help="dir with enpro.boot.bproc + _area*.bproc.part")
    ap.add_argument("--out", required=True)
    ap.add_argument("--bproc-entry", default="maps/game/enpro.bproc")
    ap.add_argument("--no-parts", action="store_true",
                    help="do NOT bundle the per-area parts (Phase 4: they ship in a separate stream blob)")
    args = ap.parse_args()

    boot = os.path.join(args.split, "enpro.boot.bproc")
    if not os.path.isfile(boot):
        print(f"error: {boot} not found (run split-bproc-areas.py first)", file=sys.stderr)
        return 2

    parts = sorted(glob.glob(os.path.join(args.split, "_area*.bproc.part")),
                   key=lambda p: int(AREA_RE.search(p).group(1)))
    shared = os.path.join(args.split, "_shared.bproc.part")

    src = zipfile.ZipFile(args.pak, "r")
    with zipfile.ZipFile(args.out, "w", zipfile.ZIP_DEFLATED) as out:
        # copy everything except the monolithic bproc
        for info in src.infolist():
            if info.filename == args.bproc_entry:
                continue
            out.writestr(info, src.read(info.filename))
        # boot proc in place of the monolith
        with open(boot, "rb") as fh:
            out.writestr(args.bproc_entry, fh.read())
        # per-area render parts as loose pak entries the engine can OpenFileRead
        # (Phase 1 test). Phase 4 omits these — they stream in via a blob instead.
        n = 0
        if not args.no_parts:
            for p in parts:
                area = int(AREA_RE.search(p).group(1))
                with open(p, "rb") as fh:
                    out.writestr(f"areadump/_area{area}.bproc.part", fh.read())
                n += 1
            if os.path.isfile(shared):
                with open(shared, "rb") as fh:
                    out.writestr("areadump/_shared.bproc.part", fh.read())
    src.close()

    osize = os.path.getsize(args.pak)
    nsize = os.path.getsize(args.out)
    print(f"wrote {args.out}: {nsize/1e6:.2f} MB (orig {osize/1e6:.2f} MB), "
          f"boot proc + {n} area parts bundled under areadump/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
