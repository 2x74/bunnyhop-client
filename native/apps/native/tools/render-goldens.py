#!/usr/bin/env python3
"""Capture hidden-window fixtures and compare their PPM pixels without a tolerance."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys


NATIVE = Path(__file__).resolve().parents[3]
REPO = NATIVE.parent


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def pixels(path):
    with path.open("rb") as stream:
        if stream.readline().strip() != b"P6":
            raise ValueError(f"Not a binary RGB PPM: {path}")
        dimensions = stream.readline().split()
        width, height = map(int, dimensions)
        if stream.readline().strip() != b"255":
            raise ValueError(f"Not an 8-bit PPM: {path}")
        data = stream.read()
    if len(data) != width * height * 3:
        raise ValueError(f"Truncated PPM: {path}")
    return (width, height), data


def compare(reference, candidate):
    expected = sorted(path.relative_to(reference) for path in reference.rglob("*.ppm"))
    actual = sorted(path.relative_to(candidate) for path in candidate.rglob("*.ppm"))
    if not expected or expected != actual:
        raise ValueError(f"Fixture set differs: missing={set(expected) - set(actual)}, "
                         f"extra={set(actual) - set(expected)}")
    failures = []
    for name in expected:
        size_a, a = pixels(reference / name)
        size_b, b = pixels(candidate / name)
        if size_a != size_b:
            failures.append(f"{name}: dimensions {size_a} != {size_b}")
        elif a != b:
            changed = sum(a[i:i + 3] != b[i:i + 3] for i in range(0, len(a), 3))
            maximum = max(abs(x - y) for x, y in zip(a, b))
            failures.append(f"{name}: {changed} changed pixels, max channel delta {maximum}")
    if failures:
        raise ValueError("\n".join(failures))
    print(f"PASS: {len(expected)} images, exact RGB equality", flush=True)


def capture(args):
    suite = json.loads(args.suite.read_text())
    revision = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip()
    if args.revision:
        requested = subprocess.check_output(
            ["git", "rev-parse", args.revision], cwd=REPO, text=True).strip()
        if revision != requested:
            raise ValueError(f"Build the requested commit first: HEAD={revision}, requested={requested}")
    args.out.mkdir(parents=True, exist_ok=False)
    inputs = {str(Path(path).resolve()): sha256(Path(path)) for path in suite["inputs"]}
    binaries = {}
    for case in suite["cases"]:
        command = [part.replace("{out}", str(args.out.resolve()))
                   .replace("{native}", str(NATIVE)) for part in case["command"]]
        binaries[command[0]] = sha256(Path(command[0]))
        with (args.out / (case["name"] + ".log")).open("w") as log:
            subprocess.run(command, cwd=NATIVE, env={**os.environ, "SDL_MAC_BACKGROUND_APP": "1"},
                           stdout=log, stderr=subprocess.STDOUT, check=True)
        print(case["name"], flush=True)
    images = {str(path.relative_to(args.out)): sha256(path) for path in sorted(args.out.rglob("*.ppm"))}
    if not images:
        raise ValueError("No PPM fixtures were captured")
    manifest = {"schema": 1, "revision": revision, "platform": platform.platform(), "suite": suite,
                "inputs": inputs, "binaries": binaries, "images": images,
                "diff": subprocess.check_output(["git", "diff", "HEAD", "--", "native/apps/native"],
                                                cwd=REPO, text=True)}
    (args.out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Captured {len(images)} images from {revision}", flush=True)


def make_suite(args):
    world, water = str(args.world_map.resolve()), str(args.water_map.resolve())
    assets = NATIVE / "target/native-assets"
    smoke = "{native}/apps/native/build/bunnyhop-native-"
    cases = []
    for look in ("classic", "source", "enhanced", "cinematic"):
        for msaa in (False, True):
            name = look + ("-msaa" if msaa else "-single")
            graphics = {"graphicsPreset": look, "graphicsDynamicShadows": look in ("enhanced", "cinematic"),
                        "graphicsSkyMode": "procedural"}
            command = [smoke + "render-smoke", "--map", world, "--out", "{out}/" + name + ".ppm",
                       "--graphics", json.dumps(graphics), "--seconds", "2", "--frames", "3"]
            if look != "classic":
                command += ["--source-look"]
            if msaa:
                command += ["--msaa"]
            cases.append({"name": name, "command": command})
    for msaa in (False, True):
        name = "water" + ("-msaa" if msaa else "-single")
        command = [smoke + "render-smoke", "--map", water, "--out", "{out}/" + name + ".ppm",
                   "--eye", *map(str, args.water_eye), "--pitch", str(args.water_pitch),
                   "--yaw", str(args.water_yaw), "--world-only", "--source-look", "--require-water"]
        if msaa:
            command += ["--msaa"]
        cases.append({"name": name, "command": command})
    for name, command in (
        ("effects", [smoke + "effects-render-smoke", world, str(Path(world).parent), "{out}/effects"]),
        ("display-hud", [smoke + "display-modes-smoke", world, str(Path(world).parent),
                         str(assets), "{out}/display-hud"]),
        ("video", [smoke + "video-frames-smoke", "{out}/video"]),
    ):
        cases.append({"name": name, "command": command})
    suite = {"inputs": [world, water, *map(str, sorted(path for path in assets.iterdir() if path.is_file()))],
             "cases": cases}
    args.out.write_text(json.dumps(suite, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    take = commands.add_parser("capture")
    take.add_argument("--suite", type=Path, required=True)
    take.add_argument("--out", type=Path, required=True)
    take.add_argument("--revision", help="Require HEAD to equal this commit; build it before capturing")
    diff = commands.add_parser("compare")
    diff.add_argument("reference", type=Path)
    diff.add_argument("candidate", type=Path)
    suite = commands.add_parser("suite")
    suite.add_argument("--world-map", type=Path, required=True)
    suite.add_argument("--water-map", type=Path, required=True)
    suite.add_argument("--water-eye", type=float, nargs=3, required=True)
    suite.add_argument("--water-pitch", type=float, default=45)
    suite.add_argument("--water-yaw", type=float, default=0)
    suite.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.mode == "capture":
            capture(args)
        elif args.mode == "compare":
            compare(args.reference, args.candidate)
        else:
            make_suite(args)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
