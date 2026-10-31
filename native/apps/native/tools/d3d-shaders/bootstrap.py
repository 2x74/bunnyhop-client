"""Build the same shader translators on each host, without system package versions."""
import json
import os
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent
NATIVE = HERE.parents[3]
TARGET = NATIVE / "target/d3d-shaders"
PIN = json.loads((HERE / "toolchain.json").read_text(encoding="utf-8"))


def run(arguments, **kwargs):
    subprocess.run([str(value) for value in arguments], check=True, **kwargs)


def tools():
    result = {}
    for name in ("glslang", "spirv-cross"):
        source = TARGET / "toolchain" / name
        build = source / "build"
        pin = PIN[name]
        if not (source / ".git").exists():
            run(["git", "init", source])
            run(["git", "-C", source, "remote", "add", "origin", pin["repository"]])
        revision = ""
        if build.exists():
            revision = subprocess.check_output(
                ["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
        if revision != pin["revision"]:
            run(["git", "-C", source, "fetch", "--depth", "1", "origin", pin["revision"]])
            run(["git", "-C", source, "checkout", "--detach", "FETCH_HEAD"])
        filename = "glslang" if name == "glslang" else name
        executable = build / ("StandAlone" if name == "glslang" else "") / filename
        if os.name == "nt":
            executable = executable.with_suffix(".exe")
        if revision != pin["revision"] or not executable.exists():
            options = ["-DBUILD_TESTING=OFF", "-DCMAKE_BUILD_TYPE=Release", "-DCMAKE_POLICY_VERSION_MINIMUM=3.5"]
            if name == "glslang":
                options += ["-DENABLE_OPT=OFF", "-DENABLE_HLSL=OFF", "-DENABLE_GLSLANG_BINARIES=ON"]
            else:
                options += ["-DSPIRV_CROSS_ENABLE_TESTS=OFF", "-DSPIRV_CROSS_ENABLE_C_API=OFF",
                            "-DSPIRV_CROSS_ENABLE_MSL=ON", "-DSPIRV_CROSS_ENABLE_CPP=ON"]
            run(["cmake", "-S", source, "-B", build, "-G", "Ninja", *options])
            target = "glslang-standalone" if name == "glslang" else filename
            run(["cmake", "--build", build, "--parallel", "4", "--target", target])
        result[name] = executable
    return result


if __name__ == "__main__":
    print(tools())
