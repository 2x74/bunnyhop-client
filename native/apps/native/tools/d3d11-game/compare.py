"""Compare full game images with local RGB SSIM, code-value error and RGB heatmaps."""

import argparse
import json
from pathlib import Path
import numpy as np
from PIL import Image


def images(directory):
    result = {}
    for path in sorted(directory.rglob("*")):
        if "comparison" in path.relative_to(directory).parts:
            continue
        if path.suffix.lower() in (".ppm", ".png", ".webp"):
            name = path.relative_to(directory).with_suffix(".png")
            if name not in result or path.suffix == ".png":
                result[name] = path
    return result


def ssim(before, after):
    # Eight-pixel windows retain thin shadows and silhouettes; pad with edge pixels so nothing is ignored.
    height, width, _ = before.shape
    padding = ((0, (-height) % 8), (0, (-width) % 8), (0, 0))
    blocks = []
    for value in (before, after):
        padded = np.pad(value / 255.0, padding, mode="edge")
        blocks.append(padded.reshape((height + 7) // 8, 8, (width + 7) // 8, 8, 3))
    left, right = blocks
    mean_left, mean_right = (value.mean(axis=(1, 3)) for value in blocks)
    variance_left, variance_right = (value.var(axis=(1, 3)) for value in blocks)
    covariance = (left * right).mean(axis=(1, 3)) - mean_left * mean_right
    luminance = (2 * mean_left * mean_right + 0.01**2) / (mean_left**2 + mean_right**2 + 0.01**2)
    structure = (2 * covariance + 0.03**2) / (variance_left + variance_right + 0.03**2)
    return float((luminance * structure).mean())


def compare(reference, candidate):
    expected, actual = images(reference), images(candidate)
    if not expected or expected.keys() != actual.keys():
        raise ValueError(
            f"Image inventory differs: missing={expected.keys() - actual.keys()}, "
            f"extra={actual.keys() - expected.keys()}"
        )
    report = []
    evidence = candidate / "comparison"
    evidence.mkdir(exist_ok=True)
    for name, path in expected.items():
        left, right = (Image.open(item).convert("RGB") for item in (path, actual[name]))
        if left.size != right.size:
            raise ValueError(f"{name}: image dimensions differ")
        before, after = (np.asarray(item, dtype=np.float64) for item in (left, right))
        difference = np.abs(before - after)
        score, error = ssim(before, after), float(difference.mean())
        passed = score >= 0.98 and error <= 3
        destination = evidence / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        Image.fromarray(np.clip(difference * 4, 0, 255).astype("uint8")).save(destination)
        right.save(actual[name].with_suffix(".png"))
        report.append(
            dict(
                image=str(name),
                ssim=score,
                meanAbsoluteError=error,
                maximum=float(difference.max()),
                fractionAbove16=float((difference > 16).mean()),
                passed=passed,
            )
        )
    result = dict(
        metric="RGB SSIM over 8x8 windows, no registration/rescaling/ignored pixels; RGB MAE",
        ssimMinimum=0.98,
        meanAbsoluteErrorMaximum=3,
        heatmap="absolute RGB difference amplified 4x",
        results=report,
        passed=all(item["passed"] for item in report),
    )
    (candidate / "comparison.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    if not result["passed"]:
        raise ValueError("Whole-game cross-rasterizer comparison failed")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("reference", type=Path)
    parser.add_argument("candidate", type=Path)
    args = parser.parse_args()
    compare(args.reference, args.candidate)
