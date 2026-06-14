#!/usr/bin/env python3
"""
split-bproc-areas.py — split a baked DOOM 3 .bproc render cache into per-area
parts (raw verts) and a boot .bproc, for area streaming (Phase 1).

WHY OFFLINE (not the in-engine dumpAreaSplit): the .bproc stores RAW verts,
captured during the original parse BEFORE FinishSurfaces mutates them (welds +
adds back-side surfaces). The in-engine DumpAreaModels runs post-load and would
serialise the FinishSurfaces-mutated mesh, which the .bproc reader then
double-finishes. Splitting the baked .bproc preserves the raw verts the reader
expects, so an appended _areaN renders identically to the monolithic load.

.bproc binary format (see RenderWorld_load.cpp Write/ParseBinary*):
  int32 magic 'BPRC'   int32 version(=1)
  repeat tag:
    1 MODEL    : string name; int32 nSurf;
                 nSurf * { string mat; int32 nVerts; int32 nIdx;
                           nVerts*32B verts(vec3 xyz, f st0, f st1, vec3 normal);
                           nIdx*int32 indexes }
    2 PORTALS  : int32 nAreas; int32 nPortals;
                 nPortals * { int32 nPts; int32 a1; int32 a2; nPts*vec3 }
    3 NODES    : int32 nNodes; nNodes * { 4*f32 plane; 2*int32 children }
    0 END
  int32 = little-endian; string = int32 len + len raw bytes (no NUL).

Outputs (into --output-dir):
  _areaN.bproc.part   one MODEL block (magic+version+MODEL+END) per render area
  _shared.bproc.part  all non-_areaN models (always boot-loaded)
  enpro.boot.bproc    magic+version + [boot-area + shared MODELs] + PORTALS + NODES + END
                      (omits the streamed areas; --boot-areas keeps a subset resident)
"""

import argparse
import os
import re
import struct
import sys

MAGIC = (ord('B')) | (ord('P') << 8) | (ord('R') << 16) | (ord('C') << 24)
VER = 1
TAG_END, TAG_MODEL, TAG_PORTALS, TAG_NODES = 0, 1, 2, 3
AREA_RE = re.compile(r"^_area(\d+)$")


class Reader:
    def __init__(self, data):
        self.d = data
        self.o = 0

    def i32(self):
        v = struct.unpack_from("<i", self.d, self.o)[0]
        self.o += 4
        return v

    def string(self):
        n = self.i32()
        s = self.d[self.o:self.o + n].decode("latin1")
        self.o += n
        return s

    def skip(self, n):
        self.o += n


def parse_blocks(data):
    """Return (header_bytes, [(kind, name_or_None, start, end)], end_offset).
    Byte ranges are [start, end) and include the leading tag int."""
    r = Reader(data)
    magic, ver = r.i32(), r.i32()
    if magic != MAGIC:
        raise ValueError(f"bad magic 0x{magic & 0xffffffff:08x} (expected 0x{MAGIC:08x})")
    if ver != VER:
        raise ValueError(f"bad version {ver} (expected {VER})")
    header = data[0:r.o]
    blocks = []
    while True:
        start = r.o
        tag = r.i32()
        if tag == TAG_END:
            blocks.append(("END", None, start, r.o))
            break
        elif tag == TAG_MODEL:
            name = r.string()
            nsurf = r.i32()
            for _ in range(nsurf):
                r.string()                 # material
                nverts = r.i32()
                nidx = r.i32()
                r.skip(nverts * 32)        # 8 floats per vert
                r.skip(nidx * 4)
            blocks.append(("MODEL", name, start, r.o))
        elif tag == TAG_PORTALS:
            r.i32()                        # nAreas
            nport = r.i32()
            for _ in range(nport):
                npts = r.i32()
                r.i32(); r.i32()           # a1, a2
                r.skip(npts * 12)
            blocks.append(("PORTALS", None, start, r.o))
        elif tag == TAG_NODES:
            nnodes = r.i32()
            r.skip(nnodes * 24)            # 4f + 2i per node
            blocks.append(("NODES", None, start, r.o))
        else:
            raise ValueError(f"bad tag {tag} at offset {start}")
    return header, blocks, r.o


def wrap(model_bytes_list):
    """magic + version + concatenated model bytes + END."""
    out = bytearray()
    out += struct.pack("<i", MAGIC)
    out += struct.pack("<i", VER)
    for b in model_bytes_list:
        out += b
    out += struct.pack("<i", TAG_END)
    return bytes(out)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True, help="baked .bproc (raw verts)")
    ap.add_argument("--output-dir", required=True)
    ap.add_argument("--name", default="enpro")
    ap.add_argument("--boot-areas", default="",
                    help="comma list of area numbers to KEEP in the boot proc (resident). "
                         "All other _areaN models are streamed (omitted from boot proc).")
    ap.add_argument("--verify", action="store_true",
                    help="re-concatenate all blocks and assert byte-identical to input")
    args = ap.parse_args()

    with open(args.input, "rb") as fh:
        data = fh.read()

    header, blocks, end = parse_blocks(data)
    if end != len(data):
        print(f"warning: parsed {end} of {len(data)} bytes (trailing data?)", file=sys.stderr)

    if args.verify:
        rebuilt = bytearray(header)
        for kind, name, s, e in blocks:
            rebuilt += data[s:e]
        ok = bytes(rebuilt) == data[:end]
        print(f"verify: {'IDENTICAL' if ok else 'MISMATCH'} ({end} bytes, {len(blocks)} blocks)")
        if not ok:
            return 1

    boot_areas = set(int(x) for x in args.boot_areas.split(",") if x.strip() != "")
    os.makedirs(args.output_dir, exist_ok=True)

    area_models = {}      # areaNum -> bytes
    shared_models = []    # bytes
    portals = nodes = None
    for kind, name, s, e in blocks:
        chunk = data[s:e]
        if kind == "MODEL":
            m = AREA_RE.match(name)
            if m:
                area_models[int(m.group(1))] = chunk
            else:
                shared_models.append(chunk)
        elif kind == "PORTALS":
            portals = chunk
        elif kind == "NODES":
            nodes = chunk

    # per-area parts (raw verts)
    nstream = 0
    for area, chunk in sorted(area_models.items()):
        with open(os.path.join(args.output_dir, f"_area{area}.bproc.part"), "wb") as fh:
            fh.write(wrap([chunk]))
        if area not in boot_areas:
            nstream += 1
    with open(os.path.join(args.output_dir, "_shared.bproc.part"), "wb") as fh:
        fh.write(wrap(shared_models))

    # boot proc: header + boot-area models + shared models + portals + nodes + END
    boot = bytearray(header)
    for area, chunk in sorted(area_models.items()):
        if area in boot_areas:
            boot += chunk
    for chunk in shared_models:
        boot += chunk
    if portals is not None:
        boot += portals
    if nodes is not None:
        boot += nodes
    boot += struct.pack("<i", TAG_END)
    boot_path = os.path.join(args.output_dir, f"{args.name}.boot.bproc")
    with open(boot_path, "wb") as fh:
        fh.write(boot)

    print(f"split {len(area_models)} area models + {len(shared_models)} shared models")
    print(f"  boot proc keeps areas {sorted(boot_areas) or '(none)'} resident -> {len(boot)/1e6:.2f} MB "
          f"(orig {len(data)/1e6:.2f} MB); {nstream} areas streamed")
    print(f"  boot: {boot_path}")
    print(f"  parts: {args.output_dir}/_area*.bproc.part + _shared.bproc.part")
    return 0


if __name__ == "__main__":
    sys.exit(main())
