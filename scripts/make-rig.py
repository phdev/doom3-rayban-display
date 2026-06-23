#!/usr/bin/env python3
"""Generate the R-GLTF Spike-B test fixture: a minimal RIGGED glTF/GLB.

This is the fixture generator the workflow recon found MISSING from the repo
(the .glb survived only as a gitignored local file; the generator was lost when
the worktree branched). It is the kill-criterion's ground truth, so it is
committed-as-script and regenerable.

Output: public/wasm/spike-rigged.glb — a self-contained binary glTF (no external
glTF library) with:
  - an 8-vertex box mesh (POSITION/NORMAL/TEXCOORD_0/JOINTS_0/WEIGHTS_0),
  - a 2-joint skeleton (joint0 = root, joint1 = child at y=1) + inverseBindMatrices,
  - one rotation animation "bend" rotating joint1 about +Z, 0deg -> BEND_DEG over 1.0s.

The TOP 4 verts (y=H) are weighted fully to the ANIMATED joint1 and offset from
the rotation axis, so they physically swing when the clip plays — this is what
makes the full-animate kill-criterion (P3) measurable (and what an identity-pose
mutation would drive to ~0, proving the gate falsifiable). The BOTTOM 4 verts
(y=0) are weighted to the static root joint0 and must NOT move.

The byte layout (single buffer, 9 accessors, 656-byte BIN) reproduces the exact
structure the engine's GLTF_ParseAnimClip already accepts (verified against the
prior known-good fixture). emits JOINTS_0 as ubyte vec4 + WEIGHTS_0 as float vec4
summing to 1.0 + an inverseBindMatrices MAT4 accessor — this doubles as the
CONTRACT a content-forge rig must satisfy (checked by --validate).

Usage:
  python3 scripts/make-rig.py                 # write public/wasm/spike-rigged.glb
  python3 scripts/make-rig.py --out PATH      # custom output path
  python3 scripts/make-rig.py --validate      # write, then re-read + assert the contract
  python3 scripts/make-rig.py --validate-only PATH   # only validate an existing GLB
"""
import argparse
import json
import math
import os
import struct
import sys

# --- rig parameters (a clear, measurable bend) ---
HX, HZ = 0.3, 0.3          # box half-extents in x/z
HEIGHT = 2.0               # box height (y in 0..HEIGHT, glTF Y-up)
JOINT1_Y = 1.0             # child joint pivot height
BEND_DEG = 60.0            # rotation of joint1 about +Z at the clip extreme
CLIP_SECONDS = 1.0         # 1.0s -> the engine resamples to ~25 frames @24fps
ENGINE_SCALE = 24.0        # Spike-A applies scale 24 to positions; report D3-space too
PROBE_VERT = 5             # the top corner used by the P3 kill-criterion probe

GLB_MAGIC = 0x46546C67
JSON_TYPE = 0x4E4F534A
BIN_TYPE = 0x004E4942
F32, U8, U16 = 5126, 5121, 5123
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963


def box_geometry():
    """8 corners: 0..3 bottom (y=0), 4..7 top (y=HEIGHT). CCW-ish winding."""
    pos = [
        (-HX, 0.0, -HZ), (HX, 0.0, -HZ), (HX, 0.0, HZ), (-HX, 0.0, HZ),         # bottom
        (-HX, HEIGHT, -HZ), (HX, HEIGHT, -HZ), (HX, HEIGHT, HZ), (-HX, HEIGHT, HZ),  # top
    ]
    # simple radial normals (the engine re-derives tangents/normals from deformed
    # positions anyway via R_DeriveTangents, so these are cosmetic).
    nrm = []
    for (x, y, z) in pos:
        m = math.sqrt(x * x + z * z) or 1.0
        nrm.append((x / m, 0.0, z / m))
    uv = [(0, 0), (1, 0), (1, 1), (0, 1), (0, 0), (1, 0), (1, 1), (0, 1)]
    # 12 triangles covering all 6 faces (winding non-critical for the spike).
    idx = [
        0, 2, 1, 0, 3, 2,        # bottom
        4, 5, 6, 4, 6, 7,        # top
        0, 1, 5, 0, 5, 4,        # -z face
        2, 3, 7, 2, 7, 6,        # +z face
        1, 2, 6, 1, 6, 5,        # +x face
        3, 0, 4, 3, 4, 7,        # -x face
    ]
    # bottom verts -> static root joint0; top verts -> animated joint1.
    joints = [(0, 0, 0, 0)] * 4 + [(1, 0, 0, 0)] * 4
    weights = [(1.0, 0.0, 0.0, 0.0)] * 8
    return pos, nrm, uv, idx, joints, weights


def quat_axis_z(deg):
    """Quaternion (x,y,z,w) for a rotation of `deg` about +Z (glTF order)."""
    h = math.radians(deg) * 0.5
    return (0.0, 0.0, math.sin(h), math.cos(h))


def rotate_z(v, deg):
    c, s = math.cos(math.radians(deg)), math.sin(math.radians(deg))
    x, y, z = v
    return (x * c - y * s, x * s + y * c, z)


def expected_probe_delta():
    """glTF-space world displacement of PROBE_VERT between bind and clip extreme.

    PROBE_VERT is a top corner weighted fully to joint1 (pivot at y=JOINT1_Y).
    At the extreme, joint1 rotates BEND_DEG about +Z. Returns (delta_gltf,
    delta_d3) magnitudes so the harness threshold is derived, not guessed.
    """
    pos, *_ = box_geometry()
    world_bind = pos[PROBE_VERT]
    local = (world_bind[0], world_bind[1] - JOINT1_Y, world_bind[2])  # joint1-local
    rl = rotate_z(local, BEND_DEG)
    world_end = (rl[0], rl[1] + JOINT1_Y, rl[2])
    d = math.sqrt(sum((world_end[i] - world_bind[i]) ** 2 for i in range(3)))
    return d, d * ENGINE_SCALE


def mat4_columns(translation):
    """Column-major mat4 (glTF) for a pure translation."""
    tx, ty, tz = translation
    return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, tx, ty, tz, 1]


def build_glb():
    pos, nrm, uv, idx, joints, weights = box_geometry()
    # inverse bind = inverse of each joint's bind world transform.
    # joint0 bind world = identity -> inverse identity.
    # joint1 bind world = translate(0, JOINT1_Y, 0) -> inverse translate(0, -JOINT1_Y, 0).
    invbind = mat4_columns((0, 0, 0)) + mat4_columns((0, -JOINT1_Y, 0))
    anim_times = [0.0, CLIP_SECONDS]
    anim_quats = [quat_axis_z(0.0), quat_axis_z(BEND_DEG)]

    # pack one buffer; bufferView order: pos,nrm,uv,joints,weights,idx,invbind,in,out
    bin_parts = []

    def add(fmt, flat):
        bin_parts.append(struct.pack("<" + fmt, *flat))

    add("%df" % (8 * 3), [c for v in pos for c in v])
    add("%df" % (8 * 3), [c for v in nrm for c in v])
    add("%df" % (8 * 2), [c for v in uv for c in v])
    add("%dB" % (8 * 4), [c for v in joints for c in v])
    add("%df" % (8 * 4), [c for v in weights for c in v])
    add("%dH" % len(idx), idx)
    add("%df" % 32, invbind)
    add("%df" % 2, anim_times)
    add("%df" % 8, [c for q in anim_quats for c in q])

    offs, cur = [], 0
    for p in bin_parts:
        offs.append(cur)
        cur += len(p)
    bin_data = b"".join(bin_parts)
    assert all(o % 4 == 0 for o in offs), "bufferView offsets must be 4-byte aligned: %r" % offs

    bv = [
        {"buffer": 0, "byteOffset": offs[0], "byteLength": 8 * 12, "target": ARRAY_BUFFER},
        {"buffer": 0, "byteOffset": offs[1], "byteLength": 8 * 12, "target": ARRAY_BUFFER},
        {"buffer": 0, "byteOffset": offs[2], "byteLength": 8 * 8, "target": ARRAY_BUFFER},
        {"buffer": 0, "byteOffset": offs[3], "byteLength": 8 * 4, "target": ARRAY_BUFFER},
        {"buffer": 0, "byteOffset": offs[4], "byteLength": 8 * 16, "target": ARRAY_BUFFER},
        {"buffer": 0, "byteOffset": offs[5], "byteLength": len(idx) * 2, "target": ELEMENT_ARRAY_BUFFER},
        {"buffer": 0, "byteOffset": offs[6], "byteLength": 128},   # invbind (no target)
        {"buffer": 0, "byteOffset": offs[7], "byteLength": 8},     # anim input
        {"buffer": 0, "byteOffset": offs[8], "byteLength": 32},    # anim output
    ]
    pmin = [min(v[i] for v in pos) for i in range(3)]
    pmax = [max(v[i] for v in pos) for i in range(3)]
    accessors = [
        {"bufferView": 0, "componentType": F32, "count": 8, "type": "VEC3", "min": pmin, "max": pmax},
        {"bufferView": 1, "componentType": F32, "count": 8, "type": "VEC3"},
        {"bufferView": 2, "componentType": F32, "count": 8, "type": "VEC2"},
        {"bufferView": 3, "componentType": U8, "count": 8, "type": "VEC4"},
        {"bufferView": 4, "componentType": F32, "count": 8, "type": "VEC4"},
        {"bufferView": 5, "componentType": U16, "count": len(idx), "type": "SCALAR"},
        {"bufferView": 6, "componentType": F32, "count": 2, "type": "MAT4"},
        {"bufferView": 7, "componentType": F32, "count": 2, "type": "SCALAR", "min": [0.0], "max": [CLIP_SECONDS]},
        {"bufferView": 8, "componentType": F32, "count": 2, "type": "VEC4"},
    ]
    gltf = {
        "asset": {"version": "2.0", "generator": "rayban make-rig.py (R-GLTF Spike-B fixture)"},
        "scene": 0,
        "scenes": [{"nodes": [0, 2]}],
        "nodes": [
            {"name": "joint0", "translation": [0, 0, 0], "children": [1]},
            {"name": "joint1", "translation": [0, JOINT1_Y, 0]},
            {"name": "meshnode", "mesh": 0, "skin": 0},
        ],
        "skins": [{"joints": [0, 1], "skeleton": 0, "inverseBindMatrices": 6}],
        "meshes": [{"primitives": [{
            "attributes": {"POSITION": 0, "NORMAL": 1, "TEXCOORD_0": 2, "JOINTS_0": 3, "WEIGHTS_0": 4},
            "indices": 5, "material": 0,
        }]}],
        "materials": [{"name": "rig_default"}],
        "animations": [{
            "name": "bend",
            "channels": [{"sampler": 0, "target": {"node": 1, "path": "rotation"}}],
            "samplers": [{"input": 7, "output": 8, "interpolation": "LINEAR"}],
        }],
        "buffers": [{"byteLength": len(bin_data)}],
        "bufferViews": bv,
        "accessors": accessors,
    }

    json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_pad = (-len(json_bytes)) % 4
    json_bytes += b" " * json_pad
    bin_pad = (-len(bin_data)) % 4
    bin_chunk = bin_data + b"\x00" * bin_pad

    total = 12 + 8 + len(json_bytes) + 8 + len(bin_chunk)
    out = bytearray()
    out += struct.pack("<III", GLB_MAGIC, 2, total)
    out += struct.pack("<II", len(json_bytes), JSON_TYPE) + json_bytes
    out += struct.pack("<II", len(bin_chunk), BIN_TYPE) + bin_chunk
    return bytes(out)


def parse_glb(path):
    with open(path, "rb") as f:
        b = f.read()
    magic, ver, total = struct.unpack_from("<III", b, 0)
    assert magic == GLB_MAGIC, "bad GLB magic"
    assert ver == 2, "expected glTF version 2"
    assert total == len(b), "GLB length header (%d) != file size (%d)" % (total, len(b))
    jlen, jtype = struct.unpack_from("<II", b, 12)
    assert jtype == JSON_TYPE, "first chunk is not JSON"
    gltf = json.loads(b[20:20 + jlen])
    off = 20 + jlen
    blen, btype = struct.unpack_from("<II", b, off)
    assert btype == BIN_TYPE, "second chunk is not BIN"
    bin_data = b[off + 8: off + 8 + blen]
    return gltf, bin_data


def validate(path):
    """Assert the rig contract content-forge rigs must satisfy. Returns True/raises."""
    gltf, bin_data = parse_glb(path)
    prim = gltf["meshes"][0]["primitives"][0]
    attrs = prim["attributes"]
    for a in ("POSITION", "NORMAL", "TEXCOORD_0", "JOINTS_0", "WEIGHTS_0"):
        assert a in attrs, "missing attribute %s" % a
    acc = gltf["accessors"]
    j, w = acc[attrs["JOINTS_0"]], acc[attrs["WEIGHTS_0"]]
    assert j["componentType"] in (U8, U16) and j["type"] == "VEC4", "JOINTS_0 must be (u8|u16) VEC4"
    assert w["componentType"] == F32 and w["type"] == "VEC4", "WEIGHTS_0 must be f32 VEC4"
    assert j["count"] == w["count"], "JOINTS_0/WEIGHTS_0 count mismatch"
    skin = gltf.get("skins", [None])[0]
    assert skin and "inverseBindMatrices" in skin, "skin must carry inverseBindMatrices"
    ibm = acc[skin["inverseBindMatrices"]]
    assert ibm["type"] == "MAT4" and ibm["count"] == len(skin["joints"]), "inverseBindMatrices/joints mismatch"
    assert gltf.get("animations"), "no animation"
    # weight-sum ~ 1.0 per vertex (read the BIN)
    wv = gltf["bufferViews"][w["bufferView"]]
    base = wv.get("byteOffset", 0)
    bad = 0
    for vi in range(w["count"]):
        wsum = sum(struct.unpack_from("<4f", bin_data, base + vi * 16))
        if abs(wsum - 1.0) > 1e-3:
            bad += 1
    assert bad == 0, "%d/%d verts have WEIGHTS_0 not summing to 1.0" % (bad, w["count"])
    print("VALIDATE OK: %s — %d verts, %d joints, JOINTS_0=%s WEIGHTS_0=f32, inverseBindMatrices present, weights sum=1.0, animation '%s'"
          % (path, w["count"], len(skin["joints"]),
             "u8" if j["componentType"] == U8 else "u16",
             gltf["animations"][0].get("name", "?")))
    return True


def main():
    ap = argparse.ArgumentParser(description="Generate the R-GLTF Spike-B rigged fixture")
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    ap.add_argument("--out", default=os.path.join(repo, "public", "wasm", "spike-rigged.glb"))
    ap.add_argument("--validate", action="store_true", help="write, then re-read + assert the contract")
    ap.add_argument("--validate-only", metavar="PATH", help="only validate an existing GLB (no write)")
    args = ap.parse_args()

    if args.validate_only:
        validate(args.validate_only)
        return

    data = build_glb()
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "wb") as f:
        f.write(data)
    d_gltf, d_d3 = expected_probe_delta()
    print("wrote %s (%d bytes)" % (args.out, len(data)))
    print("rig: 8-vert box, 2 joints (joint1 bends %.0fdeg about +Z over %.1fs), top verts -> joint1, bottom -> joint0"
          % (BEND_DEG, CLIP_SECONDS))
    print("KILL-CRITERION THRESHOLD: probe vert #%d expected world delta = %.4f glTF units"
          " (~%.2f D3 units after the engine x%.0f scale)." % (PROBE_VERT, d_gltf, d_d3, ENGINE_SCALE))
    print("  -> gltf-spike.mjs gate threshold 0.1 D3 units is a robust floor (far above the ~0.01-0.03 anim noise).")
    if args.validate:
        validate(args.out)


if __name__ == "__main__":
    main()
