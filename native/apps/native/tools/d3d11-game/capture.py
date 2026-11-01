"""Run the frozen whole-game suite with a requested renderer, without fallback."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

NATIVE = Path(__file__).resolve().parents[4]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def capture(fixtures, output, renderer):
    fixtures = fixtures.resolve()
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    suite = json.loads((fixtures / "suite.json").read_text())
    for name, digest in suite["inputs"].items():
        if sha256(fixtures / name) != digest:
            raise ValueError(f"Frozen input changed: {name}")
    environment = {**os.environ, "SDL_MAC_BACKGROUND_APP": "1", "BUNNYHOP_TEST_RENDERER": renderer}
    records = []
    suffix = ".exe" if sys.platform == "win32" else ""
    for case in suite["cases"]:
        executable = NATIVE / "apps/native/build" / ("bunnyhop-native-" + case["binary"] + suffix)
        command = [str(executable)] + [
            arg.replace("{fixtures}", str(fixtures)).replace("{out}", str(output)) for arg in case["args"]
        ]
        if case["binary"] == "client":
            command[0] = str(NATIVE / "apps/native/build" / ("bunnyhop-native" + suffix))
            command += ["--renderer", renderer, "--render-fixture", str(output / "client-fixture")]
            if renderer == "d3d11":
                command += ["--d3d11-warp"]
        log = output / (case["name"] + ".log")
        with log.open("w") as stream:
            try:
                result = subprocess.run(
                    command,
                    cwd=fixtures,
                    env=environment,
                    stdout=stream,
                    stderr=subprocess.STDOUT,
                    timeout=300,
                )
                exit_code = result.returncode
            except subprocess.TimeoutExpired:
                stream.write("\nRender fixture exceeded five minutes\n")
                exit_code = None
        records.append(
            dict(name=case["name"], command=command, binarySha256=sha256(Path(command[0])), exitCode=exit_code)
        )
        print(case["name"], "passed" if exit_code == 0 else f"failed ({exit_code})", flush=True)
    (output / "capture.json").write_text(
        json.dumps(dict(renderer=renderer, cases=records, inputs=suite["inputs"]), indent=2) + "\n"
    )
    failed = [record["name"] for record in records if record["exitCode"] != 0]
    if failed:
        raise RuntimeError("Render fixtures failed: " + ", ".join(failed))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixtures", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--renderer", choices=["opengl", "d3d11"], required=True)
    args = parser.parse_args()
    capture(args.fixtures, args.output, args.renderer)
