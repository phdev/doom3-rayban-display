#!/usr/bin/env python3
"""Apply the enpro GUI closure to an ALREADY-BUILT pak, in place of re-running
the full reducer.

reduce-d3-map-pk4.py grew a reference-driven GUI closure (step 5c) that keeps
only the guis/ a map actually references and drops other-level panel art
(~2.3MB compressed on enpro). That runs on a from-source bake. This tool applies
the SAME closure to a committed/derived pak — the deployed boot paks carry
binary geometry baked in (.bcm/.bmap/.bproc, see CLAUDE.md "binary geometry
baked into the pak"), so re-reducing from source would mean re-running the
fragile headless geo-bake. Since the closure is a pure SUBTRACTION that never
touches geometry/textures/audio, applying it directly to the built pak yields
the identical result while preserving every non-GUI entry byte-for-byte
(content + compression), and is fully verifiable.

Usage: apply-gui-closure.py <in.pk4> <out.pk4> [--verify] [--map game/enpro]
  --verify : assert no kept enpro/HUD/weapon GUI references a dropped asset.

Keep logic mirrors reduce-d3-map-pk4.py step 5c exactly (engine-hardcoded GUIs
+ this map's entity gui keys + loadout weapons, fixpoint-walked for nested .gui
+ guis/assets images, with material-name background resolution). fonts/,
ui/assets/, lights/ are left untouched (the reducer keeps them wholesale; the
HUD uses the "alternate" fonts, so they are NOT droppable).
"""
import re, sys, zipfile

TOKEN_RE = re.compile(r"[A-Za-z0-9_\-/\\.]+")
GUI_RE = re.compile(r"guis/[A-Za-z0-9_./-]+")

# idSession / idPlayer / idMultiplayer load these by literal name — not
# reachable through the map/def token graph.
ENGINE_GUIS = {
    "guis/mainmenu.gui", "guis/pda.gui", "guis/intro.gui", "guis/msg.gui",
    "guis/takenotes.gui", "guis/takenotes2.gui", "guis/gameover.gui",
    "guis/endlevel.gui", "guis/restart.gui", "guis/map/loading.gui",
    "guis/hud.gui", "guis/cursor.gui", "guis/scoreboard.gui", "guis/mphud.gui",
    "guis/mpmain.gui", "guis/mpmsgmode.gui", "guis/netmenu.gui", "guis/chat.gui",
    "guis/spectate.gui", "guis/ctfscoreboard.gui", "guis/demo_mainmenu.gui",
}


def strip_ext(t):
    return re.sub(r"\.[a-z0-9]+$", "", t)


def decl_blocks(text):
    """Yield (name, body) for `<name> { ... }` material/decl blocks."""
    i, n = 0, len(text)
    while True:
        b = text.find("{", i)
        if b < 0:
            break
        head = text[i:b].strip()
        name = head.split()[-1].lower() if head else ""
        depth, j = 1, b + 1
        while j < n and depth:
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
            j += 1
        yield name, text[b + 1:j - 1]
        i = j


def compute_keep(zf, mapname="game/enpro"):
    """Return the set of guis/ entries to KEEP (scripts + assets)."""
    names = zf.namelist()
    lower = {n.lower() for n in names}
    gui_files = {n for n in lower if n.startswith("guis/") and n.endswith(".gui")}

    def text(n):  # read an entry as text (works on binary maps too)
        try:
            return zf.read(_orig(zf, n)).decode("latin-1").lower()
        except KeyError:
            return ""

    # material-name -> guis/assets image stems (for name-ref backgrounds)
    materials = {}
    for n in lower:
        if n.startswith("materials/") and n.endswith(".mtr"):
            for declname, body in decl_blocks(text(n)):
                imgs = {strip_ext(t) for t in TOKEN_RE.findall(body)
                        if t.startswith("guis/assets/")}
                if imgs:
                    materials.setdefault(declname, set()).update(imgs)

    # seed = engine GUIs + every guis/*.gui token in this pak's map + def files
    seed = {g for g in ENGINE_GUIS if g in gui_files}
    for n in lower:
        if (n.startswith("maps/") or
                (n.startswith("def/") and n.endswith(".def"))):
            for t in GUI_RE.findall(text(n)):
                if t.endswith(".gui") and t in gui_files:
                    seed.add(t)

    # fixpoint-walk .gui -> nested .gui, collecting guis/assets tokens
    keep_scripts, asset_toks, work = set(), set(), list(seed)
    while work:
        g = work.pop()
        if g in keep_scripts or g not in gui_files:
            continue
        keep_scripts.add(g)
        gtext = text(g)
        for m in GUI_RE.findall(gtext):
            if m.endswith(".gui"):
                if m in gui_files and m not in keep_scripts:
                    work.append(m)
            else:
                asset_toks.add(m)
        for t in TOKEN_RE.findall(gtext):
            if t in materials:
                asset_toks |= materials[t]

    asset_stems = {strip_ext(t) for t in asset_toks}
    keep_assets = set()
    for n in lower:
        if not n.startswith("guis/assets/"):
            continue
        if n.startswith("guis/assets/common/") or "cursor" in n \
           or "scrollbar" in n or n.startswith("guis/assets/splash") \
           or n == "guis/assets/white.tga":
            keep_assets.add(n)
        elif strip_ext(n) in asset_stems or n in asset_toks:
            keep_assets.add(n)
    return keep_scripts | keep_assets


_ORIG_CACHE = {}


def _orig(zf, lower_name):
    """Map a lowercased name back to the pak's actual entry name."""
    key = id(zf)
    if key not in _ORIG_CACHE:
        _ORIG_CACHE[key] = {n.lower(): n for n in zf.namelist()}
    return _ORIG_CACHE[key][lower_name]


def main(argv):
    if len(argv) < 2:
        print(__doc__)
        return 2
    in_pak, out_pak = argv[0], argv[1]
    verify = "--verify" in argv
    mapname = "game/enpro"
    if "--map" in argv:
        mapname = argv[argv.index("--map") + 1]

    zin = zipfile.ZipFile(in_pak, "r")
    keep_gui = compute_keep(zin, mapname)

    dropped, kept_other, kept_gui = [], 0, 0
    zout = zipfile.ZipFile(out_pak, "w")
    for it in zin.infolist():
        nl = it.filename.lower()
        is_gui = nl.endswith(".gui") or nl.startswith("guis/assets/")
        if is_gui and nl not in keep_gui:
            dropped.append(it)
            continue
        # preserve the original compression type for every retained entry
        data = zin.read(it.filename)
        zi = zipfile.ZipInfo(it.filename, date_time=it.date_time)
        zi.compress_type = it.compress_type
        zi.external_attr = it.external_attr
        zi.internal_attr = it.internal_attr
        zout.writestr(zi, data)
        if is_gui:
            kept_gui += 1
        else:
            kept_other += 1
    zout.close()
    zin.close()

    import os
    drop_bytes = sum(it.compress_size for it in dropped)
    print(f"  kept {kept_gui} guis/ + {kept_other} other; "
          f"dropped {len(dropped)} other-level guis/ files "
          f"({drop_bytes/1048576:.2f} MB compressed)")
    print(f"  {in_pak}: {os.path.getsize(in_pak)/1048576:.2f} MB -> "
          f"{out_pak}: {os.path.getsize(out_pak)/1048576:.2f} MB")

    if verify:
        rc = _verify(in_pak, out_pak, mapname)
        if rc:
            return rc
    return 0


def _verify(in_pak, out_pak, mapname):
    """Assert: (a) every non-GUI entry is content-identical (CRC) between in and
    out, and (b) no kept GUI references an asset that was dropped."""
    zin, zout = zipfile.ZipFile(in_pak), zipfile.ZipFile(out_pak)
    in_info = {i.filename: i for i in zin.infolist()}
    out_info = {i.filename: i for i in zout.infolist()}
    # (a) non-gui content identity
    bad = []
    for name, i in in_info.items():
        nl = name.lower()
        if nl.endswith(".gui") or nl.startswith("guis/assets/"):
            continue
        o = out_info.get(name)
        if o is None or o.CRC != i.CRC or o.file_size != i.file_size:
            bad.append(name)
    if bad:
        print(f"  VERIFY FAIL: {len(bad)} non-GUI entries changed/missing "
              f"(e.g. {bad[:3]})", file=sys.stderr)
        return 1
    # (b) no kept GUI references a dropped asset that EXISTED in the input
    present_after = {n.lower() for n in zout.namelist()}
    in_lower = {n.lower() for n in zin.namelist()}
    IMG = (".tga", ".jpg", ".jpeg", ".dds", ".png")
    holes = []
    for name in zout.namelist():
        if not name.lower().endswith(".gui"):
            continue
        txt = zout.read(name).decode("latin-1")
        for r in re.findall(r"guis/assets/[A-Za-z0-9_./-]+", txt):
            rl = r.lower()
            stem = strip_ext(rl)
            if rl in present_after or any((stem + e) in present_after for e in IMG):
                continue
            # only a hole if it actually existed in the input pak
            if rl in in_lower or any((stem + e) in in_lower for e in IMG):
                holes.append((name, r))
    if holes:
        print(f"  VERIFY FAIL: {len(holes)} kept GUIs reference a dropped asset "
              f"(e.g. {holes[:3]})", file=sys.stderr)
        return 1
    print(f"  VERIFY OK: all non-GUI content identical (CRC); "
          f"no kept GUI references a dropped asset")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
