#!/usr/bin/env python3
"""Bake binary geometry (.bcm/.bmap/.bproc) into the boot pak, replacing the
ASCII .cm/.map/.proc. See CLAUDE.md "binary geometry baked into the pak".

Usage: bake-geo-pak.py <ascii-boot.pk4> <baked-geo-dir> <out.pk4> [map]
  ascii-boot.pk4  : the ASCII boot pak (from the reducer) — input
  baked-geo-dir   : dir with maps/game/<map>.{bcm,bmap,bproc} (from bake-geo-extract.mjs)
  out.pk4         : output binary boot pak (then run chunk-pk4.py on it)
"""
import sys, os, zipfile
ascii_pak, baked_dir, out_pak = sys.argv[1], sys.argv[2], sys.argv[3]
m = sys.argv[4] if len(sys.argv) > 4 else "game/enpro"
drop = {f"maps/{m}.cm", f"maps/{m}.map", f"maps/{m}.proc"}
add  = {f"maps/{m}.{e}": os.path.join(baked_dir, "maps", m + "." + e) for e in ("bcm","bmap","bproc")}
zin = zipfile.ZipFile(ascii_pak, "r")
zout = zipfile.ZipFile(out_pak, "w", zipfile.ZIP_DEFLATED, compresslevel=9)
for it in zin.infolist():
    if it.filename in drop: continue
    zout.writestr(it, zin.read(it.filename))
for arc, path in add.items():
    with open(path, "rb") as f: zout.writestr(arc, f.read(), zipfile.ZIP_DEFLATED, compresslevel=9)
zin.close(); zout.close()
print(f"baked {out_pak}: {os.path.getsize(ascii_pak)/1048576:.1f} MB -> {os.path.getsize(out_pak)/1048576:.1f} MB")
