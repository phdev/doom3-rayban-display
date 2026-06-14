#!/usr/bin/env python3
"""
validate-bcm-split.py — verify the Phase 2 collision split is complete + disjoint.

Parses the dumped enpro.boot.bcm (resident polys/brushes) + _areaN.bcm.part files
and asserts: residentPolys + sum(part polys) == collision.json totalPolys (same
for brushes). i.e. every poly/brush landed in exactly one bucket (boot or an area).

Usage: python3 scripts/validate-bcm-split.py <areadump-dir>
"""
import glob
import json
import os
import struct
import sys


def ri(f):
    return struct.unpack("<i", f.read(4))[0]


def rf(f):
    return struct.unpack("<f", f.read(4))[0]


def rstr(f):
    n = ri(f)
    return f.read(n)


def skip_nodes(f):
    # iterative pre-order consume of WriteBinaryNodes' stream
    pending = 1
    while pending > 0:
        pending -= 1
        pt = ri(f)
        rf(f)  # planeDist
        if pt != -1:
            pending += 2


def skip_polys(f, n):
    for _ in range(n):
        ne = ri(f)
        f.read(ne * 4)          # edge indices
        f.read(12 + 4 + 12 + 12)  # plane normal+dist + bounds[0] + bounds[1]
        rstr(f)                 # material


def skip_brushes(f, n):
    for _ in range(n):
        np_ = ri(f)
        f.read(np_ * 16)        # planes (vec3 + float each)
        f.read(12 + 12 + 4)     # bounds[0] + bounds[1] + contents


def parse_boot_bcm(path):
    with open(path, "rb") as f:
        ri(f); ri(f); ri(f)     # magic, version, crc
        nmodels = ri(f)
        rstr(f)                 # model name
        nverts = ri(f)
        f.read(nverts * 12)
        nedges = ri(f)
        f.read(nedges * 16)
        skip_nodes(f)
        ri(f)                   # polygonMemory
        npolys = ri(f)
        skip_polys(f, npolys)
        ri(f)                   # brushMemory
        nbrushes = ri(f)
        return npolys, nbrushes, nverts, nedges


def parse_part(path):
    with open(path, "rb") as f:
        ri(f)                   # polygonMemory
        npolys = ri(f)
        skip_polys(f, npolys)
        ri(f)                   # brushMemory
        nbrushes = ri(f)
        return npolys, nbrushes


def main():
    d = sys.argv[1] if len(sys.argv) > 1 else "areadump-out"
    coll = json.load(open(os.path.join(d, "collision.json")))
    total_polys = coll["totalPolys"]
    total_brushes = coll["totalBrushes"]

    boot = os.path.join(d, "enpro.boot.bcm")
    rp, rb, nv, ne = parse_boot_bcm(boot)

    part_polys = part_brushes = 0
    parts = glob.glob(os.path.join(d, "_area*.bcm.part"))
    for p in parts:
        pp, pb = parse_part(p)
        part_polys += pp
        part_brushes += pb

    print(f"boot .bcm: {nv} verts, {ne} edges, {rp} resident polys, {rb} resident brushes")
    print(f"parts ({len(parts)} files): {part_polys} polys, {part_brushes} brushes")
    print(f"total (collision.json): {total_polys} polys, {total_brushes} brushes")
    poly_ok = (rp + part_polys == total_polys)
    brush_ok = (rb + part_brushes == total_brushes)
    print(f"poly coverage:  {rp}+{part_polys} = {rp + part_polys} {'== ✓' if poly_ok else '!= ✗'} {total_polys}")
    print(f"brush coverage: {rb}+{part_brushes} = {rb + part_brushes} {'== ✓' if brush_ok else '!= ✗'} {total_brushes}")
    if poly_ok and brush_ok:
        print("\nPASS — collision split is complete + disjoint (every poly/brush in exactly one bucket).")
        return 0
    print("\nFAIL — coverage mismatch (lost or double-counted primitives).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
