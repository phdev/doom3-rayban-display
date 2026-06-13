#!/usr/bin/env python3
"""Build a reduced, single-map DOOM 3 PK4 for the Ray-Ban Display web app.

DOOM 3 asset dependencies are connected through declaration files (materials,
sound shaders, entity defs). Deleting by folder or filename alone breaks maps,
so this tool runs a heuristic dependency pass:

  1. Keep the target map files (maps/<map>.*).
  2. Keep all declaration text (.mtr, .def, .script, .sndshd, .gui, ...).
  3. Resolve the materials / sounds / models the map references to concrete
     image and audio files, and keep only those binaries.
  4. Optionally downsample retained WAV audio.

It is intentionally conservative: it errs toward keeping a working map over the
smallest possible size. Use --keep-list to force-include extra globs, and
inspect the printed report. You must own DOOM 3 to use this on your own data.
"""
import argparse
import fnmatch
import io
import json
import re
import sys
import wave
import zipfile
from pathlib import Path

# Declaration / text files that are always retained (they are small and the
# dependency graph runs through them).
TEXT_KEEP_EXTS = {
    ".mtr", ".def", ".script", ".sndshd", ".gui", ".guicfg",
    ".pda", ".cfg", ".txt", ".lang", ".decl", ".af", ".mtr2",
    # Iter 52: .skin decls remap model surfaces to variant materials
    # (e.g. zombies remap male_npc jumpsuit -> djumpsuit "dead" flesh).
    # Without them the engine builds a DEFAULTED skin and the model
    # renders black — and the variant materials' images need the skin
    # index below to enter the closure at all.
    ".skin",
}

# Iter 52: cubeMap/cameraCubeMap stages reference a BASE name
# ("cameraCubeMap env/desert") that the engine expands to six side
# files by convention. Both the camera-space and cube-space suffix
# sets exist in the data. Without this expansion no env/ cubemap ever
# shipped (black skyboxes, missing reflections).
CUBE_SIDE_SUFFIXES = (
    "_forward", "_back", "_left", "_right", "_up", "_down",
    "_px", "_nx", "_py", "_ny", "_pz", "_nz",
)

# Binary asset extensions we prune unless referenced.
IMAGE_EXTS = {".tga", ".jpg", ".jpeg", ".png", ".dds", ".pcx", ".bmp"}
MODEL_EXTS = {".md5mesh", ".md5anim", ".md5camera", ".lwo", ".ase", ".ma", ".flt", ".prt"}
SOUND_EXTS = {".wav", ".ogg"}
VIDEO_EXTS = {".roq"}

TOKEN_RE = re.compile(r"[A-Za-z0-9_\-/\\.]+")


def norm(name):
    return name.replace("\\", "/").strip("/").lower()


def strip_ext(path):
    dot = path.rfind(".")
    slash = path.rfind("/")
    if dot > slash:
        return path[:dot]
    return path


def resolve_inputs(input_arg):
    """Accept a single PK4, or a directory of PK4s (DOOM 3 ships pak000..pak008
    plus game00..game03). Returns a sorted list of PK4 paths in load order."""
    p = Path(input_arg)
    if p.is_dir():
        paths = sorted(q for q in p.glob("*.pk4") if q.is_file())
        if not paths:
            raise SystemExit(f"error: no *.pk4 in {p}")
        return paths
    if not p.is_file():
        raise SystemExit(f"error: input not found: {p}")
    return [p]


def load_archives(paths):
    """Build {normalized_name: (zip_path, original_name)} across all paks, with
    later paks overriding earlier ones (id Tech 4 load order)."""
    entries = {}
    for path in paths:
        if not zipfile.is_zipfile(path):
            raise SystemExit(f"error: not a valid PK4 (ZIP): {path}")
        with zipfile.ZipFile(path) as archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                entries[norm(info.filename)] = (path, info.filename)
    return entries


class ArchivePool:
    """Lazily-opened, cached ZipFile handles keyed by path."""
    def __init__(self):
        self._open = {}

    def read(self, path, original):
        zf = self._open.get(path)
        if zf is None:
            zf = self._open[path] = zipfile.ZipFile(path)
        return zf.read(original)

    def text(self, path, original):
        try:
            return self.read(path, original).decode("latin-1", "ignore")
        except KeyError:
            return ""

    def close(self):
        for zf in self._open.values():
            zf.close()


def tokens(text):
    return {t.lower() for t in TOKEN_RE.findall(text) if "/" in t or "." in t}


ASSET_PREFIXES = ("textures/", "models/", "guis/", "env/", "fx/", "lights/",
                  "sound/", "video/", "dds/", "generated/")


def iter_decl_blocks(text):
    """Yield (last_header_token, body) for each top-level `header { body }` block.
    Works for materials (`name { }`) and defs (`entityDef name { }`) — the decl
    key is the last whitespace token before the opening brace."""
    depth = 0
    i = 0
    n = len(text)
    header_start = 0
    body_start = 0
    name = None
    while i < n:
        c = text[i]
        if c == "{":
            if depth == 0:
                header = text[header_start:i].split("//")[-1] if False else text[header_start:i]
                toks = header.split()
                name = toks[-1].lower() if toks else None
                body_start = i + 1
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                if name:
                    yield name, text[body_start:i]
                header_start = i + 1
                name = None
        i += 1


def asset_tokens(text):
    return {t.lower() for t in TOKEN_RE.findall(text)
            if t.lower().startswith(ASSET_PREFIXES)}


def map_prefix(map_name):
    base = norm(map_name)
    if base.startswith("maps/"):
        base = base[len("maps/"):]
    if base.endswith(".map"):
        base = base[:-4]
    return f"maps/{base}"


def downsample_wav(data, rate, width):
    try:
        with wave.open(io.BytesIO(data), "rb") as src:
            params = src.getparams()
            frames = src.readframes(params.nframes)
    except (wave.Error, EOFError):
        return data

    try:
        import audioop
    except ImportError:
        return data

    # Convert to mono at the requested width/rate.
    if params.sampwidth != width:
        frames = audioop.lin2lin(frames, params.sampwidth, width)
    if params.nchannels == 2:
        frames = audioop.tomono(frames, width, 0.5, 0.5)
    if params.framerate != rate:
        frames, _ = audioop.ratecv(frames, width, 1, params.framerate, rate, None)

    out = io.BytesIO()
    with wave.open(out, "wb") as dst:
        dst.setnchannels(1)
        dst.setsampwidth(width)
        dst.setframerate(rate)
        dst.writeframes(frames)
    result = out.getvalue()
    return result if len(result) < len(data) else data


_IMG_RESIZE_EXTS = {".tga", ".jpg", ".jpeg", ".png", ".bmp"}


def downsize_image(data, name, max_dim):
    """Downscale an image so its longest side is <= max_dim, re-encoding in the
    same format. DOOM 3 textures are mostly power-of-two, so scaling by an
    integer factor keeps them power-of-two. .dds (compressed) and .pcx are left
    alone. Returns the original bytes on any failure or if already small."""
    ext = name[name.rfind("."):].lower() if "." in name else ""
    if ext not in _IMG_RESIZE_EXTS:
        return data
    try:
        from PIL import Image
    except ImportError:
        return data
    try:
        im = Image.open(io.BytesIO(data))
        im.load()
    except Exception:
        return data
    w, h = im.size
    if max(w, h) <= max_dim:
        return data
    scale = max_dim / float(max(w, h))
    new = (max(1, int(round(w * scale))), max(1, int(round(h * scale))))
    try:
        im = im.resize(new, Image.LANCZOS)
        out = io.BytesIO()
        if ext in (".jpg", ".jpeg"):
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            im.save(out, format="JPEG", quality=85)
        elif ext == ".tga":
            # DOOM 3's TGA loader wants bottom-left origin; PIL defaults to
            # top-left and sets the descriptor bit, but be explicit/uncompressed.
            im.save(out, format="TGA", compression=None)
        elif ext == ".png":
            im.save(out, format="PNG", optimize=True)
        else:
            im.save(out, format="BMP")
        result = out.getvalue()
        return result if len(result) < len(data) else data
    except Exception:
        return data


def main(argv=None):
    parser = argparse.ArgumentParser(description="Reduce DOOM 3 PK4(s) to one map")
    parser.add_argument("--input", required=True,
                        help="input PK4 file, or a base/ directory of *.pk4")
    parser.add_argument("--output", required=True, help="output reduced PK4")
    parser.add_argument("--map", default="game/mars_city1", help="map to keep")
    parser.add_argument("--keep-list", help="JSON file with extra keep globs")
    parser.add_argument("--no-audio", action="store_true",
                        help="drop all sound/* assets (smallest output; sound is off in the wearable build)")
    parser.add_argument("--keep-video", action="store_true",
                        help="keep referenced .roq cinematics (GUI monitor screens). Off by default; "
                             "the engine needs r_skipROQ 0 for them to play.")
    parser.add_argument("--audio-rate", type=int, default=0, help="downsample WAV to this rate (0=skip)")
    parser.add_argument("--audio-width", type=int, default=1, help="WAV sample width in bytes")
    parser.add_argument("--max-texture", type=int, default=0,
                        help="downsize TGA/JPG/PNG images so the longest side is at most this "
                             "many pixels (power-of-two recommended, e.g. 256; 0=keep full size). "
                             "Shrinks the pak, its in-memory copy, and decode memory for low-end "
                             "targets like a phone or the wearable display.")
    parser.add_argument("--jpeg-textures", action="store_true",
                        help="re-encode COLOR textures (diffuse/specular/sky, no alpha) as JPEG, "
                             "dropping the .tga. idTech4's R_LoadImage falls back from a missing "
                             ".tga to the same-named .jpg, so material refs need no rewrite. Normal/"
                             "height maps, alpha textures, and HUD/font art stay lossless TGA.")
    parser.add_argument("--jpeg-quality", type=int, default=85,
                        help="JPEG quality for --jpeg-textures (default 85).")
    parser.add_argument("--defer-textures", action="store_true",
                        help="split output: the boot .pk4 gets everything EXCEPT bulk "
                             "world/model textures, which go into a concat <output>.stream "
                             "blob + <output>.stream.json manifest for progressive streaming. "
                             "HUD/font/light(falloff) images stay in the boot pak (their "
                             "absence is worse than gray). The web shell streams the blob in "
                             "after boot and reloads the defaulted images (iter 55).")
    args = parser.parse_args(argv)

    input_paths = resolve_inputs(args.input)
    output_path = Path(args.output)
    entries = load_archives(input_paths)
    prefix = map_prefix(args.map)

    extra_globs = []
    if args.keep_list:
        cfg = json.loads(Path(args.keep_list).read_text())
        extra_globs = cfg.get("keep", [])

    pool = ArchivePool()
    try:
        keep = set()

        # 1. Map files + always-kept declaration text.
        # Map-independent essentials the dependency walk can't reach via map
        # tokens (they're referenced by the engine / the menu / the HUD, not the
        # map):
        #   glprogs/      - ARB vertex/fragment programs the lit 3D path needs
        #                   (GL4ES translates them to GLSL); without them every
        #                   interaction shader compiles from empty source
        #                   ("Missing main()") and the world renders black.
        #   fonts/        - every bit of on-screen text (menu, HUD, subtitles).
        #   guis/assets/  - GUI image assets: the main menu (mars planet, button
        #                   art) and the in-game HUD. Without these the .gui files
        #                   load but have no textures, so the menu renders black.
        #   ui/assets/    - the GUI device context (idDeviceContext::Init) loads
        #                   the cursor + scrollbar images from here; every GUI,
        #                   including the main menu, needs them to render.
        #   lights/       - light projection cookies + falloff ramps. Light
        #                   materials reference these through image programs
        #                   (makeintensity(lights/squarelight1a) etc.) that the
        #                   def-graph walk doesn't resolve; a missing falloff
        #                   defaults to a black image, which multiplies every
        #                   interaction of that light to zero — point lights
        #                   silently turn OFF. ~3MB for the whole dir.
        ALWAYS_KEEP_PREFIXES = ("glprogs/", "fonts/", "guis/assets/", "ui/assets/", "lights/")
        decl_text = []
        for name, (zpath, original) in entries.items():
            ext = name[name.rfind("."):] if "." in name else ""
            if name.startswith(prefix + ".") or name.startswith(prefix + "/"):
                keep.add(name)
            elif name.startswith(ALWAYS_KEEP_PREFIXES):
                keep.add(name)
            elif ext in TEXT_KEEP_EXTS:
                keep.add(name)
                decl_text.append(name)

        # 2. Index material -> images and entityDef -> body across all decls, so
        #    map references can be resolved to concrete assets (bounded to what
        #    the map and its entities actually use, not the whole game).
        materials = {}   # material name -> set(stripped image paths)
        defs = {}        # entityDef/model name -> concatenated body text
        sndshaders = {}  # sound shader name -> set(sample paths)
        skindecls = {}   # skin decl name -> set(material name tokens)
        for name in decl_text:
            zpath, original = entries[name]
            ext = name[name.rfind("."):] if "." in name else ""
            if ext not in (".mtr", ".def", ".sndshd", ".skin"):
                continue
            text = pool.text(zpath, original)
            for declname, body in iter_decl_blocks(text):
                if ext == ".skin":
                    # Iter 52: skin decls list `from to` material pairs; defs
                    # reference the decl by name (sometimes with a stray
                    # ".skin" suffix — index both spellings). The remap
                    # TARGET materials are otherwise unreachable through the
                    # def graph (zombie djumpsuit/dsoldier class).
                    toks = set(asset_tokens(body))
                    skindecls.setdefault(declname, set()).update(toks)
                    _bare = strip_ext(declname)
                    if _bare != declname:
                        skindecls.setdefault(_bare, set()).update(toks)
                    else:
                        skindecls.setdefault(declname + ".skin", set()).update(toks)
                    continue
                if ext == ".sndshd":
                    # Sound shaders list their sample files (sound/*.wav|ogg)
                    # in the body. Entities reference the SHADER NAME (a bare
                    # token, no slash), so without this index the closure can
                    # never reach a single sample file — which is why audio
                    # silently shipped empty even without --no-audio.
                    sndshaders.setdefault(declname, set()).update(
                        t for t in asset_tokens(body) if t.startswith("sound/"))
                    continue
                if ext == ".mtr":
                    # Iter 50: some id materials are AUTHORED with an image
                    # extension in the name ("textures/.../x_fin.tga") while
                    # maps reference them bare — index both spellings.
                    _bare = strip_ext(declname)
                    if _bare != declname:
                        materials.setdefault(_bare, set()).update(
                            strip_ext(t) for t in asset_tokens(body))
                    materials.setdefault(declname, set()).update(
                        strip_ext(t) for t in asset_tokens(body))
                else:
                    # DOOM 3 routinely gives the entityDef and its model def the
                    # SAME name (e.g. `entityDef marscity_cinematic_sarge` and
                    # `model marscity_cinematic_sarge`). Overwriting would shadow
                    # one with the other — typically dropping the model def's
                    # `mesh` (the body md5mesh carrying the joints the head
                    # attaches to). Concatenate so the closure sees both.
                    defs[declname] = defs.get(declname, "") + "\n" + body

        # 2b. Index particle (.prt) decls. The VISIBLE part of many effects —
        # the imp fireball, rocket/projectile smoke trails, explosions — is a
        # PARTICLE SYSTEM, not a model+material: a projectile def carries
        # `"model" "impfireball2.prt"` / `"smoke_fly" "imp_trail2.prt"` /
        # `"model_detonate" "imp_explosion.prt"`. Two reducer gaps made the
        # whole class ship as NOTHING (iter 53):
        #   (1) .prt is in MODEL_EXTS (a prunable binary), and step 2 only
        #       PARSES .mtr/.def/.sndshd/.skin — so particle stage textures
        #       (textures/particles/*) never entered the closure; AND
        #   (2) the decl is referenced by NAME ("impfireball2.prt") but lives
        #       in a differently-named FILE (particles/patrick2.prt), so the
        #       binary-keep path's name match never fired and ZERO .prt shipped.
        # Index every particle decl -> its stage assets, and -> the .prt FILE
        # that must ship so the engine can load the decl at all.
        particles = {}      # particle decl name -> set(stripped asset paths)
        prt_file_of = {}    # particle decl name -> .prt entry to keep
        for pname, (pzpath, poriginal) in entries.items():
            if not pname.endswith(".prt"):
                continue
            for declname, body in iter_decl_blocks(pool.text(pzpath, poriginal)):
                particles.setdefault(declname, set()).update(
                    strip_ext(t) for t in asset_tokens(body))
                prt_file_of.setdefault(declname, pname)

        # 3. Seed referenced tokens from the map files, then expand one level
        #    through the entityDefs the map instantiates, and resolve material
        #    names to their images.
        used = set()
        seed_names = set()
        for name in [n for n in keep if n.startswith(prefix)]:
            zpath, original = entries[name]
            text = pool.text(zpath, original)
            used |= tokens(text)
            for t in TOKEN_RE.findall(text):
                seed_names.add(t.lower())
        # Every single-player map spawns the player and gives it the default
        # inventory, but none of that is referenced by a map token — so the
        # closure below would never reach the player body model or the
        # weapon/PDA/flashlight models, and the empty-defaulted player then
        # fatally fails its head-joint lookup at spawn. Seed the player def (it
        # references its def_weaponN in turn) plus the always-present items.
        ESSENTIAL_DEFS = {
            "player_doommarine", "player_base",
            "weapon_fists", "weapon_pistol", "weapon_flashlight", "weapon_pda",
        }
        seed_names |= ESSENTIAL_DEFS
        used |= ESSENTIAL_DEFS
        # Transitive closure through the entityDef/model def graph: a map entity
        # names an AI/character def, which names a model def, which lists the
        # md5mesh + every md5anim. A single pass stops at the first hop and drops
        # character meshes/animations (the empty-defaulted model then fatally
        # fails a joint lookup at spawn), so walk the def graph to a fixpoint.
        worklist = list(seed_names)
        expanded = set()
        while worklist:
            nm = worklist.pop()
            if nm in expanded:
                continue
            expanded.add(nm)
            body = defs.get(nm)
            if body is None:
                continue
            used |= tokens(body)
            for t in TOKEN_RE.findall(body):
                tl = t.lower()
                seed_names.add(tl)
                if tl in defs and tl not in expanded:
                    worklist.append(tl)

        referenced = set(used)
        for nm in seed_names | used:
            if nm in materials:
                referenced |= materials[nm]
            if nm in sndshaders:
                referenced |= sndshaders[nm]
            # Iter 52: a referenced skin decl pulls in its remap-target
            # materials and THEIR images (zombie skins remap npc materials
            # to d-variant flesh materials whose images nothing else names).
            if nm in skindecls:
                for t in skindecls[nm]:
                    referenced.add(t)
                    if t in materials:
                        referenced |= materials[t]
            # Iter 53: a referenced particle decl (nm may carry the ".prt"
            # suffix from the projectile's "model"/"smoke_fly" keys) pulls in
            # (a) the .prt FILE so the engine can load the decl, and (b) every
            # stage's texture/material image — resolving material names through
            # the materials index (e.g. textures/particles/barrelpoof_sort ->
            # barrelpoof.tga). Without these the imp fireball is invisible.
            for pkey in (nm, strip_ext(nm)):
                if pkey in particles:
                    if pkey in prt_file_of:
                        keep.add(prt_file_of[pkey])
                    for t in particles[pkey]:
                        referenced.add(t)
                        if t in materials:
                            referenced |= materials[t]

        ref_stripped = {strip_ext(t) for t in referenced}
        # Iter 52: expand cubemap bases to their six side files (both the
        # camera-space and cube-space suffix conventions).
        for r in list(ref_stripped):
            for s in CUBE_SIDE_SUFFIXES:
                ref_stripped.add(r + s)

        # 4. Keep binary assets referenced (by path or basename without ext),
        #    plus extra user globs. md5mesh skins are resolved one more level.
        for name, (zpath, original) in entries.items():
            if name in keep:
                continue
            ext = name[name.rfind("."):] if "." in name else ""
            if args.no_audio and ext in SOUND_EXTS:
                continue
            if ext in VIDEO_EXTS and not args.keep_video:
                continue
            if ext in IMAGE_EXTS or ext in MODEL_EXTS or ext in SOUND_EXTS or ext in VIDEO_EXTS:
                if name in referenced or strip_ext(name) in ref_stripped:
                    keep.add(name)
                    continue
            if any(fnmatch.fnmatch(name, norm(g)) for g in extra_globs):
                if args.no_audio and ext in SOUND_EXTS:
                    continue
                keep.add(name)

        # 5. Resolve materials referenced inside kept MODELS, then keep their
        #    images. This is the difference between a lit level and a black one:
        #    mapobjects (walls, doors, lights, props) are .lwo (binary) and .ase,
        #    NOT .md5mesh — the admin map alone places ~190 .lwo + ~30 .ase. DOOM 3
        #    stores each surface's material name as an ASCII string inside the model
        #    (the .lwo SURF chunk / the .ase MATERIAL list), so a latin-1 scan finds
        #    them. A scan limited to .md5mesh (animated characters only) dropped
        #    every mapobject material — 481 missing images on admin, including the
        #    elevator walls (textures/base_door/delelev1) and the ceiling lights
        #    (textures/base_light/gottubelight). A surface whose diffuse (_d) is
        #    missing renders pure black regardless of gamma/brightness/lightScale,
        #    which is why the elevator looked unlit.
        #
        #    Each material name resolves to images two ways:
        #      - explicit: a `.mtr` block of that name lists the image stages
        #        (already indexed in `materials`), or
        #      - implicit: no `.mtr` exists and the engine derives the images from
        #        the name by convention — <name>_d diffuse, _local bump, _s specular,
        #        _add glow. delelev1/gottubelight are implicit, so derive the
        #        variants directly.
        extra_imgs = set()
        IMPLICIT_SUFFIXES = ("", "_d", "_local", "_s", "_add", "_h", "_bmp")
        model_exts_l = {e.lower() for e in MODEL_EXTS}
        for name in [n for n in keep
                     if n[n.rfind("."):].lower() in model_exts_l]:
            zpath, original = entries[name]
            for t in asset_tokens(pool.text(zpath, original)):
                base = strip_ext(t)
                if base in materials:
                    extra_imgs |= materials[base]
                if base.startswith(("textures/", "models/")):
                    for suf in IMPLICIT_SUFFIXES:
                        extra_imgs.add(base + suf)
        extra_stripped = {strip_ext(t) for t in extra_imgs}
        # Iter 52: cubemap side expansion for model-referenced materials too
        # (glass/visor reflections use cubeMap stages).
        for r in list(extra_stripped):
            for s in CUBE_SIDE_SUFFIXES:
                extra_stripped.add(r + s)
        for name, (zpath, original) in entries.items():
            if name in keep:
                continue
            ext = name[name.rfind("."):] if "." in name else ""
            if args.no_audio and ext in SOUND_EXTS:
                continue
            if ext in IMAGE_EXTS and strip_ext(name) in extra_stripped:
                keep.add(name)

        # 3c. DDS-only fallback conversion. The 1.3.1 patch paks removed many
        # hi-res TGAs and ship them ONLY precompressed under dds/<path>.dds;
        # the engine falls back to that tree at load time
        # (image_usePrecompressedTextures), but the browser build can't use
        # DXT (no S3TC on WebKit) and the keep-test above never matched the
        # dds/ prefix — those surfaces rendered _default gray (enpro's upper
        # shaft, reactor pipes, prop details). Decode the referenced DDS-only
        # images to TGA at their canonical paths.
        all_ref_stripped = ref_stripped | extra_stripped
        kept_stripped = {strip_ext(n) for n in keep}
        dds_convert = {}
        for name in entries:
            if not (name.startswith("dds/") and name.endswith(".dds")):
                continue
            canon = strip_ext(name)[4:]
            if canon in all_ref_stripped and canon not in kept_stripped:
                dds_convert[canon + ".tga"] = name
        if dds_convert:
            print(f"  converting {len(dds_convert)} DDS-only textures to TGA", file=sys.stderr)

        def convert_dds(data, out_name, max_dim):
            import io
            from PIL import Image
            img = Image.open(io.BytesIO(data))
            img = img.convert("RGBA")
            if max_dim:
                w, h = img.size
                longest = max(w, h)
                if longest > max_dim:
                    f = (longest + max_dim - 1) // max_dim
                    img = img.resize((max(1, w // f), max(1, h // f)), Image.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="TGA")
            return buf.getvalue()

        jpeg_stats = [0, 0]  # [count recoded, bytes saved]

        def maybe_jpeg(data, name):
            """Re-encode a COLOR texture as JPEG when --jpeg-textures is set.
            Returns (out_name, out_data). Leaves the input untouched (same name)
            for anything that must stay lossless: normal/height/bump maps (JPEG
            ringing corrupts surface normals), images with a USED alpha channel
            (JPEG has none; dhewm3 reads no PNG), and HUD/font art (crispness).
            idTech4's R_LoadImage tries <name>.tga then falls back to <name>.jpg,
            so dropping the .tga and writing .jpg needs no material rewrite."""
            if not args.jpeg_textures or not name.endswith(".tga"):
                return name, data
            b = name.lower()
            if b.startswith(("guis/", "fonts/")):
                return name, data
            # normal/height/bump maps — lossless only
            stem = strip_ext(b)
            if stem.endswith(("_local", "_h", "_bump", "_n", "_nm", "_normal", "_bmp")) \
               or "local" in b:
                return name, data
            try:
                from PIL import Image
                im = Image.open(io.BytesIO(data)); im.load()
            except Exception:
                return name, data
            # used alpha? keep lossless
            if im.mode in ("RGBA", "LA", "PA") or (im.mode == "P" and "transparency" in im.info):
                a = im.convert("RGBA").getchannel("A").getextrema()
                if a[0] < 255:
                    return name, data
            # secondary normal-map guard: bluish, high-B images are normals even
            # if mis-named (DXT5nm-style); skip JPEG to be safe.
            rgb = im.convert("RGB")
            ex = rgb.getextrema()
            try:
                from PIL import ImageStat
                mean = ImageStat.Stat(rgb).mean
                if mean[2] > 170 and mean[2] > mean[0] + 25 and mean[2] > mean[1] + 25:
                    return name, data
            except Exception:
                pass
            buf = io.BytesIO()
            rgb.save(buf, format="JPEG", quality=args.jpeg_quality, optimize=True)
            jb = buf.getvalue()
            if len(jb) >= len(data):
                return name, data
            jpeg_stats[0] += 1
            jpeg_stats[1] += len(data) - len(jb)
            return name[:-4] + ".jpg", jb

        IMAGE_EXTS_L = (".tga", ".jpg", ".jpeg", ".png")

        def is_deferred(name):
            """Bulk world/model textures safe to render gray for a beat while
            streaming. EXCLUDE lights/ (a missing falloff = BLACK, not gray —
            worse), guis/ + fonts/ + ui/ (HUD must be crisp immediately)."""
            if not args.defer_textures or not name.lower().endswith(IMAGE_EXTS_L):
                return False
            b = name.lower()
            if b.startswith(("lights/", "guis/", "fonts/", "ui/")):
                return False
            return b.startswith(("textures/", "models/", "env/"))

        # 4. Write the boot archive; deferred textures go to a parallel .stream
        #    blob (raw concatenated bytes) + a JSON file manifest.
        output_path.parent.mkdir(parents=True, exist_ok=True)
        kept_bytes = 0
        by_dir = {}
        stream_path = output_path.with_suffix(output_path.suffix + ".stream")
        stream_files = []     # [{path, off, len}] — offsets into the UNCOMPRESSED blob
        stream_off = [0]
        stream_buf = bytearray() if args.defer_textures else None

        def emit(name, data):
            # name/data are final (post downsize/jpeg). Route to boot pak or stream.
            if stream_buf is not None and is_deferred(name):
                stream_buf.extend(data)
                stream_files.append({"path": name.lower(), "off": stream_off[0], "len": len(data)})
                stream_off[0] += len(data)
            else:
                out.writestr(name, data)
                nonlocal_kept[0] += len(data)
                top = name.split("/", 1)[0] if "/" in name else "(root)"
                by_dir[top] = by_dir.get(top, 0) + len(data)

        nonlocal_kept = [0]
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as out:
            for name in sorted(keep):
                zpath, original = entries[name]
                data = pool.read(zpath, original)
                if args.audio_rate and name.endswith(".wav"):
                    data = downsample_wav(data, args.audio_rate, args.audio_width)
                elif args.max_texture:
                    data = downsize_image(data, name, args.max_texture)
                name, data = maybe_jpeg(data, name)
                emit(name, data)
            for out_name, src_name in sorted(dds_convert.items()):
                zpath, original = entries[src_name]
                try:
                    data = convert_dds(pool.read(zpath, original), out_name, args.max_texture)
                except Exception as e:
                    print(f"  dds convert FAILED for {src_name}: {e}", file=sys.stderr)
                    continue
                out_name, data = maybe_jpeg(data, out_name)
                emit(out_name, data)
        kept_bytes = nonlocal_kept[0]
        if stream_buf is not None:
            import gzip
            gz = gzip.compress(bytes(stream_buf), compresslevel=6)
            with open(stream_path, "wb") as sf:
                sf.write(gz)
            manifest = {"totalSize": stream_off[0], "compressedSize": len(gz),
                        "gzip": True, "count": len(stream_files), "files": stream_files}
            with open(str(stream_path) + ".json", "w") as mf:
                json.dump(manifest, mf)
            print(f"  DEFERRED {len(stream_files)} textures -> {stream_off[0]/1e6:.1f} MB raw, "
                  f"{len(gz)/1e6:.1f} MB gzip stream (boot pak excludes them)", file=sys.stderr)
        if args.jpeg_textures:
            print(f"  JPEG: recoded {jpeg_stats[0]} color textures, saved "
                  f"{jpeg_stats[1]/1e6:.1f} MB (uncompressed)", file=sys.stderr)
        for top, size in sorted(by_dir.items(), key=lambda kv: -kv[1]):
            print(f"  {top:<14} {size/1e6:8.1f} MB (uncompressed)", file=sys.stderr)
    finally:
        pool.close()

    original_size = sum(p.stat().st_size for p in input_paths)
    reduced_size = output_path.stat().st_size
    print(
        f"Reduced {len(input_paths)} PK4(s): {len(entries)} files ({original_size/1e6:.1f} MB) "
        f"-> {len(keep)} files ({reduced_size/1e6:.1f} MB) for map {args.map}",
        file=sys.stderr,
    )
    if not any(n.startswith(prefix) for n in keep):
        print(f"warning: no map files matched {prefix}.* — check the --map name", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
