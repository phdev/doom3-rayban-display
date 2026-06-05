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
}

# Binary asset extensions we prune unless referenced.
IMAGE_EXTS = {".tga", ".jpg", ".jpeg", ".png", ".dds", ".pcx", ".bmp"}
MODEL_EXTS = {".md5mesh", ".md5anim", ".md5camera", ".lwo", ".ase", ".ma", ".flt", ".prt"}
SOUND_EXTS = {".wav", ".ogg"}

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
    parser.add_argument("--audio-rate", type=int, default=0, help="downsample WAV to this rate (0=skip)")
    parser.add_argument("--audio-width", type=int, default=1, help="WAV sample width in bytes")
    parser.add_argument("--max-texture", type=int, default=0,
                        help="downsize TGA/JPG/PNG images so the longest side is at most this "
                             "many pixels (power-of-two recommended, e.g. 256; 0=keep full size). "
                             "Shrinks the pak, its in-memory copy, and decode memory for low-end "
                             "targets like a phone or the wearable display.")
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
        ALWAYS_KEEP_PREFIXES = ("glprogs/", "fonts/", "guis/assets/", "ui/assets/")
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
        for name in decl_text:
            zpath, original = entries[name]
            ext = name[name.rfind("."):] if "." in name else ""
            if ext not in (".mtr", ".def"):
                continue
            text = pool.text(zpath, original)
            for declname, body in iter_decl_blocks(text):
                if ext == ".mtr":
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

        ref_stripped = {strip_ext(t) for t in referenced}

        # 4. Keep binary assets referenced (by path or basename without ext),
        #    plus extra user globs. md5mesh skins are resolved one more level.
        for name, (zpath, original) in entries.items():
            if name in keep:
                continue
            ext = name[name.rfind("."):] if "." in name else ""
            if args.no_audio and ext in SOUND_EXTS:
                continue
            if ext in IMAGE_EXTS or ext in MODEL_EXTS or ext in SOUND_EXTS:
                if name in referenced or strip_ext(name) in ref_stripped:
                    keep.add(name)
                    continue
            if any(fnmatch.fnmatch(name, norm(g)) for g in extra_globs):
                if args.no_audio and ext in SOUND_EXTS:
                    continue
                keep.add(name)

        # 5. Resolve materials referenced inside kept md5mesh models.
        extra_imgs = set()
        for name in [n for n in keep if n.endswith(".md5mesh")]:
            zpath, original = entries[name]
            for t in TOKEN_RE.findall(pool.text(zpath, original)):
                if t.lower() in materials:
                    extra_imgs |= materials[t.lower()]
        extra_stripped = {strip_ext(t) for t in extra_imgs}
        for name, (zpath, original) in entries.items():
            if name in keep:
                continue
            ext = name[name.rfind("."):] if "." in name else ""
            if ext in IMAGE_EXTS and strip_ext(name) in extra_stripped:
                keep.add(name)

        # 4. Write the reduced archive (downsampling audio on the way out).
        output_path.parent.mkdir(parents=True, exist_ok=True)
        kept_bytes = 0
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as out:
            for name in sorted(keep):
                zpath, original = entries[name]
                data = pool.read(zpath, original)
                if args.audio_rate and name.endswith(".wav"):
                    data = downsample_wav(data, args.audio_rate, args.audio_width)
                elif args.max_texture:
                    data = downsize_image(data, name, args.max_texture)
                out.writestr(name, data)
                kept_bytes += len(data)
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
