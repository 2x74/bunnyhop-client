#!/usr/bin/env python3
"""Compare Linux runner JSONL against saved WASM states, preserving finite bits."""
import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


def nan_bits(word):
    return word & 0x7F800000 == 0x7F800000 and word & 0x007FFFFF != 0


def compare(expected, actual):
    differences = []
    if expected["tick"] != actual["tick"]:
        differences.append("tick")
    if expected["flags"] != actual["flags"]:
        differences.append("flags")
    if len(expected["bits"]) != len(actual["bits"]):
        differences.append("bits.length")
    else:
        for index, (a, e) in enumerate(zip(actual["bits"], expected["bits"])):
            if a != e and not (nan_bits(a) and nan_bits(e)):
                differences.append(f"bits[{index}]")
    return differences


def read_rows(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("fixtures", type=Path)
    parser.add_argument("artifacts", type=Path)
    args = parser.parse_args()
    fixtures = sorted(args.fixtures.glob("*.commands"))
    if not fixtures:
        parser.error("no .commands fixtures found")
    reports = []
    for fixture in fixtures:
        name = fixture.name.removesuffix(".commands")
        expected_path = Path(str(fixture) + ".expected.jsonl")
        actual_path = args.artifacts / (name + ".native.jsonl")
        report = {"map": name, "pass": False, "commandSha256": sha256(fixture)}
        try:
            expected, actual = read_rows(expected_path), read_rows(actual_path)
            report.update(expectedStates=len(expected), nativeStates=len(actual),
                          expectedSha256=sha256(expected_path), nativeSha256=sha256(actual_path))
            mismatch_rows = abs(len(expected) - len(actual))
            samples = []
            for index, (e, a) in enumerate(zip(expected, actual)):
                fields = compare(e, a)
                if fields:
                    mismatch_rows += 1
                    if len(samples) < 8:
                        samples.append({"row": index, "fields": fields, "expected": e, "native": a})
            report.update(mismatchRows=mismatch_rows, mismatches=samples,
                          **{"pass": mismatch_rows == 0})
        except (OSError, ValueError, KeyError, TypeError) as error:
            report["error"] = str(error)
        reports.append(report)
        print(f"{name}: {'PASS' if report['pass'] else 'FAIL'} "
              f"({report.get('nativeStates', 0)} native states, "
              f"{report.get('mismatchRows', 'unknown')} mismatched rows)")
    output = {"generatedAt": datetime.now(timezone.utc).isoformat(),
              "scope": "exact finite IEEE-754 bits, tick and flags; NaN payloads exempt", "reports": reports}
    (args.artifacts / "parity-report.json").write_text(json.dumps(output, indent=2) + "\n")
    return 0 if all(report["pass"] for report in reports) else 1


if __name__ == "__main__":
    raise SystemExit(main())
