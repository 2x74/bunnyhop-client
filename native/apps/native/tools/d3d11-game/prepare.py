from pathlib import Path
import hashlib, json, shutil
import argparse

parser = argparse.ArgumentParser(description="Freeze the golden suite inputs and full-game camera cases.")
parser.add_argument("suite", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
base = args.suite.resolve().parent
root = args.output
(root / "target").mkdir(parents=True, exist_ok=True)
source = json.loads(args.suite.read_text())
shutil.copytree(Path(source["assets"]), root / "target/native-assets", dirs_exist_ok=True)
shutil.copytree(base / "inputs", root / "inputs", dirs_exist_ok=True)
suite = json.loads(args.suite.read_text())
cases = []
for case in suite["cases"]:
    command = case["command"]
    binary = command[0].split("bunnyhop-native-")[1]
    args = [
        arg.replace(str(base / "inputs"), "{fixtures}/inputs").replace(
            source["assets"], "{fixtures}/target/native-assets"
        )
        for arg in command[1:]
    ]
    cases.append(dict(name=case["name"], binary=binary, args=args))
for name, binary, args in [
    (
        "reflection",
        "reflection-render-smoke",
        ["{fixtures}/inputs/bhop_lol_aero.bsp", "{fixtures}/target/native-assets", "{out}/reflection"],
    ),
    ("previews", "loadout-preview-smoke", ["{fixtures}/target/native-assets", "{out}/previews"]),
    (
        "avatars",
        "avatar-smoke",
        ["{fixtures}/target/native-assets", "{fixtures}/avatar-jobs.json", "{out}/avatars"],
    ),
    (
        "client",
        "client",
        [
            "--map",
            "{fixtures}/inputs/bhop_eazy.bsp",
            "--hidden",
            "--no-menu",
            "--frames",
            "4",
            "--screenshot",
            "{out}/client.ppm",
        ],
    ),
]:
    cases.append(dict(name=name, binary=binary, args=args))
jobs = []
for i, frame in enumerate(["face", "close", "bust", "full"]):
    jobs.append(
        dict(
            name=frame,
            request=dict(
                type="avatarRender",
                id=i + 1,
                output="preview",
                size=256,
                spec=dict(
                    outfit="outfit-mint",
                    loadout="2;knife-carrot;fin-garden;glove-knit",
                    pose="swing",
                    knife="knife-carrot",
                    gun="usp",
                    hand="knife",
                    moment=0.75,
                    tilt=0.2,
                    ears=-0.4,
                    turn=-18,
                    frame=frame,
                    zoom=1.1,
                ),
                backdrop=dict(kind="studio", top="#22222a", bottom="#0e0e12", glow="#7ee0b0"),
            ),
        )
    )
(root / "avatar-jobs.json").write_text(json.dumps(jobs, indent=2) + "\n")
inputs = {
    str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
    for p in sorted(root.rglob("*"))
    if p.is_file()
}
(root / "suite.json").write_text(json.dumps(dict(inputs=inputs, cases=cases), indent=2) + "\n")
