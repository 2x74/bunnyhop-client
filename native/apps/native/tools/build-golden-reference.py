#!/usr/bin/env python3
"""Build historical smoke sources with the configured native toolchain, inside an ignored evidence directory."""

import argparse
import hashlib
import io
import json
from pathlib import Path
import shlex
import subprocess
import tarfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--target", action="append", choices=("render-smoke", "effects-render-smoke",
                        "display-modes-smoke", "video-frames-smoke", "render-benchmark",
                        "avatar-smoke", "menu-backdrop-smoke"))
    args = parser.parse_args()
    native = Path(__file__).resolve().parents[3]
    repo = native.parent
    build = native / "apps/native/build"
    output = args.out.resolve()
    output.mkdir(parents=True, exist_ok=False)
    source = output / "source"
    source.mkdir()
    revision = subprocess.check_output(["git", "rev-parse", args.commit], cwd=repo, text=True).strip()
    archive = subprocess.check_output(["git", "archive", revision, "native/apps/native"], cwd=repo)
    with tarfile.open(fileobj=io.BytesIO(archive)) as files:
        files.extractall(source, filter="data")
    records = []
    for suffix in args.target or ("render-smoke", "effects-render-smoke", "display-modes-smoke", "video-frames-smoke"):
        target = "bunnyhop-native-" + suffix
        commands = subprocess.check_output(["ninja", "-t", "commands", target], cwd=build, text=True)
        objects = {}
        for line in commands.splitlines():
            command = shlex.split(line)
            if "-c" not in command or not command[0].endswith(("c++", "clang++", "g++")):
                continue
            source_file = Path(command[command.index("-c") + 1])
            if source_file.parent != native / "apps/native/src":
                continue
            original_object = command[command.index("-o") + 1]
            destination = output / "objects" / target / source_file.with_suffix(".o").name
            destination.parent.mkdir(parents=True, exist_ok=True)
            objects[original_object] = str(destination)
            command = [part.replace(str(native / "apps/native"), str(source / "native/apps/native"))
                       for part in command]
            for flag in ("-o", "-MF", "-MT"):
                if flag in command:
                    command[command.index(flag) + 1] = str(destination) + (".d" if flag == "-MF" else "")
            subprocess.run(command, cwd=build, check=True)
        link = next(shlex.split(line) for line in commands.splitlines()
                    if line.startswith(": &&") and f"-o {target} " in line)
        link = link[2:-2]
        executable = output / target
        link = [objects.get(part, part) for part in link]
        link[link.index("-o") + 1] = str(executable)
        subprocess.run(link, cwd=build, check=True)
        records.append({"executable": str(executable),
                        "sha256": hashlib.sha256(executable.read_bytes()).hexdigest()})
        print(target, flush=True)
    bridge = native / "target/release/libbunnyhop_native_bridge.a"
    (output / "build.json").write_text(json.dumps({"revision": revision, "binaries": records,
        "archiveSha256": hashlib.sha256(archive).hexdigest(),
        "bridgeSha256": hashlib.sha256(bridge.read_bytes()).hexdigest()}, indent=2) + "\n")


if __name__ == "__main__":
    main()
