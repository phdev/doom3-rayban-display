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


def load_archive(path):
    if not zipfile.is_zipfile(path):
        raise SystemExit(f"error: not a valid PK4 (ZIP): {path}")
    entries = {}
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            entries[norm(info.filename)] = info.filename
    return entries


def read_text(archive, original):
    try:
        return archive.read(original).decode("latin-1", "ignore")
    except KeyError:
        return ""


def tokens(text):
    return {t.lower() for t in TOKEN_RE.findall(text) if "/" in t or "." in t}


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


def main(argv=None):
    parser = argparse.ArgumentParser(description="Reduce a DOOM 3 PK4 to one map")
    parser.add_argument("--input", required=True, help="input PK4 (owned data)")
    parser.add_argument("--output", required=True, help="output reduced PK4")
    parser.add_argument("--map", default="game/mars_city1", help="map to keep")
    parser.add_argument("--keep-list", help="JSON file with extra keep globs")
    parser.add_argument("--audio-rate", type=int, default=0, help="downsample WAV to this rate (0=skip)")
    parser.add_argument("--audio-width", type=int, default=1, help="WAV sample width in bytes")
    args = parser.parse_args(argv)

    input_path = Path(args.input)
    output_path = Path(args.output)
    if not input_path.is_file():
        raise SystemExit(f"error: input not found: {input_path}")

    entries = load_archive(input_path)
    prefix = map_prefix(args.map)

    extra_globs = []
    if args.keep_list:
        cfg = json.loads(Path(args.keep_list).read_text())
        extra_globs = cfg.get("keep", [])

    with zipfile.ZipFile(input_path) as archive:
        keep = set()

        # 1. Map files + always-kept declaration text.
        decl_text = []
        for name, original in entries.items():
            ext = name[name.rfind("."):] if "." in name else ""
            if name.startswith(prefix + ".") or name.startswith(prefix + "/"):
                keep.add(name)
            elif ext in TEXT_KEEP_EXTS:
                keep.add(name)
                decl_text.append(name)

        # 2. Collect every asset-looking token referenced by the map + decls.
        referenced = set()
        scan_sources = [n for n in keep if n.startswith(prefix)] + decl_text
        for name in scan_sources:
            referenced |= tokens(read_text(archive, entries[name]))

        ref_stripped = {strip_ext(t) for t in referenced}

        # 3. Keep binary assets that are referenced (by full path or basename
        #    without extension), plus extra user globs.
        for name, original in entries.items():
            if name in keep:
                continue
            ext = name[name.rfind("."):] if "." in name else ""
            if ext in IMAGE_EXTS or ext in MODEL_EXTS or ext in SOUND_EXTS:
                if name in referenced or strip_ext(name) in ref_stripped:
                    keep.add(name)
                    continue
            if any(fnmatch.fnmatch(name, norm(g)) for g in extra_globs):
                keep.add(name)

        # 4. Write the reduced archive (downsampling audio on the way out).
        output_path.parent.mkdir(parents=True, exist_ok=True)
        kept_bytes = 0
        with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as out:
            for name in sorted(keep):
                data = archive.read(entries[name])
                if args.audio_rate and name.endswith(".wav"):
                    data = downsample_wav(data, args.audio_rate, args.audio_width)
                out.writestr(name, data)
                kept_bytes += len(data)

    original_size = input_path.stat().st_size
    reduced_size = output_path.stat().st_size
    print(
        f"Reduced {input_path.name}: {len(entries)} files ({original_size/1e6:.1f} MB) "
        f"-> {len(keep)} files ({reduced_size/1e6:.1f} MB) for map {args.map}",
        file=sys.stderr,
    )
    if not any(n.startswith(prefix) for n in keep):
        print(f"warning: no map files matched {prefix}.* — check the --map name", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
