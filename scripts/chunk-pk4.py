#!/usr/bin/env python3
"""Split the bundled PK4 into raw chunks + a manifest for the chunked loader.

The web runtime prefers `<pak>.manifest.json` + `<pak>.NNN` chunks over the
single file: small chunks give cheap per-chunk retries and (with the
runtime's per-chunk cache) cross-reload resume on flaky cellular links.

Usage: python3 scripts/chunk-pk4.py [pak_path] [chunk_mb]
"""
import json, os, sys

pak = sys.argv[1] if len(sys.argv) > 1 else "public/wasm/base/pak-display.pk4"
chunk_mb = float(sys.argv[2]) if len(sys.argv) > 2 else 4.0
chunk_bytes = int(chunk_mb * 1024 * 1024)

size = os.path.getsize(pak)
base = os.path.basename(pak)
out_dir = os.path.dirname(pak)
chunks = []

with open(pak, "rb") as f:
    idx = 0
    while True:
        data = f.read(chunk_bytes)
        if not data:
            break
        name = f"{base}.{idx:03d}"
        with open(os.path.join(out_dir, name), "wb") as o:
            o.write(data)
        chunks.append({"path": name, "size": len(data)})
        idx += 1

manifest = {"totalSize": size, "chunks": chunks}
with open(os.path.join(out_dir, base + ".manifest.json"), "w") as m:
    json.dump(manifest, m)

print(f"{len(chunks)} chunks of <= {chunk_mb} MB for {base} ({size} bytes)")
