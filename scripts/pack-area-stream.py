#!/usr/bin/env python3
"""
pack-area-stream.py — assemble the per-area streaming blob + manifest for the
DOOM 3 (dhewm3) area-streaming feature (Phase 0 of the area-streaming spec).

The engine's `dumpAreaSplit` console command writes a per-area split of the
loaded map under /save/areadump:

    _areaN.bproc.part   render geometry for render-area N   (one MODEL block)
    _shared.bproc.part  shared / inline brush models (always boot-loaded)
    _areaN.entities     leaf entities whose origin is in area N (binary idDicts)
    _boot.entities      worldspawn / player / cross-area trigger+bind chains
    render.json         per-area surf/vert/index counts
    collision.json      per-area poly/brush counts + cross-area straddlers + void
    entities.json       per-area entity counts + boot count + streamable %
    targets.json        target*/bind* edges with from/to areas
    adjacency.json      (optional) per-area portal-neighbour list

This script pulls that directory out of a dev run and emits, in the SAME shape
the texture streamer already consumes (`{files:[{path,off,len}], compressedSize}`
+ a gzip blob whose offsets index the *uncompressed* concatenation):

    <out>/<name>.areas.stream        gzip(concat(parts))
    <out>/<name>.areas.stream.json   manifest (+ per-file area/kind, bootFiles,
                                     bootAreas, adjacency)
    <out>/<name>.areas.graph.json    merged metrics + GO/NO-GO summary

It is read-only with respect to the engine; nothing here runs the game.
"""

import argparse
import glob
import gzip
import json
import os
import re
import sys

AREA_RE = re.compile(r"_area(\d+)\.(bproc\.part|bcm\.part|entities)$")
_KIND = {"bproc.part": "render", "bcm.part": "collision", "entities": "entities"}


def load_json(path):
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "r") as fh:
            return json.load(fh)
    except (ValueError, OSError) as exc:
        print(f"  warning: could not parse {os.path.basename(path)}: {exc}", file=sys.stderr)
        return None


def classify(filename):
    """Return (kind, area) for a dump file, or (None, None) to skip."""
    base = os.path.basename(filename)
    m = AREA_RE.search(base)
    if m:
        return _KIND[m.group(2)], int(m.group(1))
    if base == "_shared.bproc.part":
        return "render", -1
    if base == "_boot.entities":
        return "entities", -1
    return None, None


def collect_parts(indir):
    """Ordered list of (path_in_blob, abspath, kind, area). Stable order:
    shared/boot first, then by area then kind, so the blob layout is
    deterministic across bakes."""
    parts = []
    for abspath in glob.glob(os.path.join(indir, "*")):
        kind, area = classify(abspath)
        if kind is None:
            continue
        rel = "areadump/" + os.path.basename(abspath)
        parts.append((rel, abspath, kind, area))

    def sort_key(p):
        _, _, kind, area = p
        boot = 0 if area < 0 else 1            # shared/boot first
        return (boot, area, 0 if kind == "render" else 1)

    parts.sort(key=sort_key)
    return parts


def main():
    ap = argparse.ArgumentParser(description="Assemble the area-streaming blob + manifest.")
    ap.add_argument("--input", required=True, help="directory holding the dumped areadump/* files")
    ap.add_argument("--output-dir", default="public/wasm/base-stream", help="where to write the blob + manifest")
    ap.add_argument("--name", default="enpro", help="map name prefix for the output files")
    ap.add_argument("--gzip-level", type=int, default=9)
    args = ap.parse_args()

    indir = args.input
    if not os.path.isdir(indir):
        print(f"error: input dir not found: {indir}", file=sys.stderr)
        return 2

    parts = collect_parts(indir)
    if not parts:
        print(f"error: no _area*/_shared/_boot dump files found in {indir}", file=sys.stderr)
        return 2

    # concatenate (offsets index the uncompressed concatenation)
    blob = bytearray()
    files = []
    boot_files = []
    for rel, abspath, kind, area in parts:
        with open(abspath, "rb") as fh:
            data = fh.read()
        off = len(blob)
        blob += data
        entry = {"path": rel, "off": off, "len": len(data), "kind": kind, "area": area}
        files.append(entry)
        if area < 0:
            boot_files.append(rel)

    gz = gzip.compress(bytes(blob), compresslevel=args.gzip_level)

    # merge the metric fragments
    render = load_json(os.path.join(indir, "render.json"))
    collision = load_json(os.path.join(indir, "collision.json"))
    entities = load_json(os.path.join(indir, "entities.json"))
    targets = load_json(os.path.join(indir, "targets.json"))
    adjacency = load_json(os.path.join(indir, "adjacency.json"))

    os.makedirs(args.output_dir, exist_ok=True)
    blob_path = os.path.join(args.output_dir, f"{args.name}.areas.stream")
    with open(blob_path, "wb") as fh:
        fh.write(gz)

    manifest = {
        "files": files,
        "compressedSize": len(gz),
        "uncompressedSize": len(blob),
        "bootFiles": boot_files,
        "bootAreas": [],   # Phase 4: portal-hop boot region; engine/JS compute it
        "adjacency": (adjacency or {}).get("adjacency") if adjacency else None,
    }
    manifest_path = blob_path + ".json"
    with open(manifest_path, "w") as fh:
        json.dump(manifest, fh)

    graph = {
        "name": args.name,
        "render": render,
        "collision": collision,
        "entities": entities,
        "targets": targets,
        "adjacency": adjacency,
    }
    graph_path = os.path.join(args.output_dir, f"{args.name}.areas.graph.json")
    with open(graph_path, "w") as fh:
        json.dump(graph, fh, indent=2)

    # ---- go/no-go report -------------------------------------------------
    n_render = sum(1 for f in files if f["kind"] == "render" and f["area"] >= 0)
    n_ent = sum(1 for f in files if f["kind"] == "entities" and f["area"] >= 0)
    print(f"Packed {len(files)} files ({n_render} area render, {n_ent} area entity, "
          f"+ shared/boot) → {len(blob)/1e6:.2f} MB raw / {len(gz)/1e6:.2f} MB gzip")
    print(f"  blob:     {blob_path}")
    print(f"  manifest: {manifest_path}")
    print(f"  graph:    {graph_path}")
    print("\n=== AREA-STREAMING GO / NO-GO ===")
    verdict_ok = True
    if collision:
        tp = collision.get("totalPolys", 0) or 0
        cp = collision.get("crossAreaPolys", 0) or 0
        vp = collision.get("voidPolys", 0) or 0
        ratio = (100.0 * cp / tp) if tp else 0.0
        print(f"  collision: {tp} polys, {cp} cross-area ({ratio:.1f}%), {vp} void")
        if ratio > 20.0:
            print("    NO-GO RISK: >20% cross-area polys — split plane straddles too much; "
                  "they fall into the always-boot _shared bucket (correct but heavy).")
            verdict_ok = False
    if entities:
        tot = entities.get("numEntities", 0) or 0
        boot = entities.get("bootEntities", 0) or 0
        pct = entities.get("streamablePct", 0.0) or 0.0
        print(f"  entities:  {tot} total, {boot} forced-boot, {pct:.1f}% streamable")
        if pct < 25.0:
            print("    NOTE: low streamable % — most entities are in cross-area trigger/bind "
                  "chains (forced boot). Streaming still helps render geometry.")
    if targets:
        print(f"  edges:     {targets.get('crossTargetEdges', 0)} cross-target, "
              f"{targets.get('crossBindEdges', 0)} cross-bind (these force endpoints to boot)")
    if render and render.get("shared"):
        sh = render["shared"]
        print(f"  render:    {n_render} per-area models + {sh.get('models', 0)} shared models")
    print(f"\n  VERDICT: {'GO — split is clean enough to stream render geometry' if verdict_ok else 'REVIEW — see NO-GO RISK above'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
