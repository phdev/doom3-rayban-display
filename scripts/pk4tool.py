#!/usr/bin/env python3
"""Inspect, validate, and merge DOOM 3 PK4 archives.

PK4 files are standard ZIP archives. This tool mirrors the role of the GLQuake
II Display paktool, adapted to the ZIP-based PK4 container used by id Tech 4.
"""
import argparse
import io
import sys
import zipfile
from pathlib import Path


class Pk4Error(Exception):
    pass


def normalize_name(name):
    normalized = name.replace("\\", "/").strip("/")
    parts = []

    for part in normalized.split("/"):
        if not part or part == ".":
            continue
        if part == "..":
            if not parts:
                raise Pk4Error(f"Unsafe PK4 path: {name}")
            parts.pop()
            continue
        parts.append(part)

    return "/".join(parts).lower()


def read_pk4(path):
    path = Path(path)
    if not path.is_file():
        raise Pk4Error(f"PK4 not found: {path}")

    if not zipfile.is_zipfile(path):
        raise Pk4Error(f"Not a valid PK4 (ZIP) archive: {path}")

    files = {}
    with zipfile.ZipFile(path) as archive:
        bad = archive.testzip()
        if bad is not None:
            raise Pk4Error(f"Corrupt entry in PK4: {bad}")
        for info in archive.infolist():
            if info.is_dir():
                continue
            files[normalize_name(info.filename)] = info.file_size

    return files


def validate(path):
    files = read_pk4(path)
    if not files:
        raise Pk4Error("PK4 contains no files")
    return files


def list_files(path):
    files = read_pk4(path)
    for name in sorted(files):
        print(f"{files[name]:>10}  {name}")
    print(f"# {len(files)} files", file=sys.stderr)


def merge(data_dir, output):
    data_dir = Path(data_dir)
    if not data_dir.is_dir():
        raise Pk4Error(f"Data dir not found: {data_dir}")

    sources = sorted(p for p in data_dir.glob("*.pk4") if p.is_file())
    if not sources:
        raise Pk4Error(f"No *.pk4 files found in {data_dir}")

    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)

    # Later PK4s override earlier ones in id Tech 4 load order; emulate that by
    # writing in order and letting the last writer of a name win.
    seen = {}
    for source in sources:
        with zipfile.ZipFile(source) as archive:
            for info in archive.infolist():
                if info.is_dir():
                    continue
                seen[normalize_name(info.filename)] = (source, info.filename)

    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as out:
        for norm, (source, original) in sorted(seen.items()):
            with zipfile.ZipFile(source) as archive:
                out.writestr(norm, archive.read(original))

    print(f"Merged {len(sources)} PK4s -> {output} ({len(seen)} files)", file=sys.stderr)


def self_test():
    # Build a tiny in-memory PK4 and validate it round-trips.
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("maps/game/mars_city1.map", "// test map\n")
        archive.writestr("materials/test.mtr", "test { }\n")

    tmp = Path("__pk4tool_selftest.pk4")
    tmp.write_bytes(buffer.getvalue())
    try:
        files = validate(tmp)
        assert normalize_name("maps/game/mars_city1.map") in files, "map entry missing"
        assert normalize_name("materials/test.mtr") in files, "material entry missing"
        # path traversal guard
        try:
            normalize_name("../../etc/passwd")
        except Pk4Error:
            pass
        else:
            raise AssertionError("path traversal not rejected")
    finally:
        tmp.unlink(missing_ok=True)

    print("pk4tool self-test passed")


def main(argv=None):
    parser = argparse.ArgumentParser(description="DOOM 3 PK4 utilities")
    parser.add_argument("--self-test", action="store_true", help="run internal self-test")
    parser.add_argument("--validate", metavar="PK4", help="validate a PK4 archive")
    parser.add_argument("--list", metavar="PK4", help="list files in a PK4 archive")
    parser.add_argument("--merge", metavar="DIR", help="merge all *.pk4 in DIR")
    parser.add_argument("--output", metavar="PK4", help="output path for --merge")
    args = parser.parse_args(argv)

    try:
        if args.self_test:
            self_test()
            return 0
        if args.validate:
            validate(args.validate)
            print(f"{args.validate} is a valid PK4")
            return 0
        if args.list:
            list_files(args.list)
            return 0
        if args.merge:
            if not args.output:
                parser.error("--merge requires --output")
            merge(args.merge, args.output)
            return 0
    except Pk4Error as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
