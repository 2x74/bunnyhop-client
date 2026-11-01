"""Compare GL and WARP with a bounded cross-rasterizer RGB error, without alignment or ignored pixels."""
import argparse
import json
from pathlib import Path
from PIL import Image


def compare(reference, candidate):
    for path in candidate.glob("*.ppm"):
        Image.open(path).save(path.with_suffix(".png"))
    results = []
    expected = sorted(path.name for path in reference.glob('*.png'))
    actual = sorted(path.name for path in candidate.glob('*.png'))
    if not expected or expected != actual:
        raise ValueError(f'Image inventory differs: {expected} vs {actual}')
    for name in expected:
        before = Image.open(reference / name).convert('RGB')
        after = Image.open(candidate / name).convert('RGB')
        if before.size != after.size:
            raise ValueError(f'{name}: dimensions differ')
        deltas = sorted(abs(a - b) for a, b in zip(before.tobytes(), after.tobytes()))
        mean = sum(deltas) / len(deltas)
        bad_fraction = sum(value > 16 for value in deltas) / len(deltas)
        passed = mean <= 2 and bad_fraction <= .005
        results.append(dict(image=name, meanAbsoluteError=mean, fractionAbove16=bad_fraction,
                            maximum=deltas[-1], passed=passed))
    report = dict(metric='RGB code values, no registration', meanLimit=2, fractionAbove16Limit=.005,
                  results=results, passed=all(result['passed'] for result in results))
    (candidate / 'comparison.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    if not report['passed']:
        raise ValueError('WARP images exceeded the cross-driver tolerance')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('reference', type=Path)
    parser.add_argument('candidate', type=Path)
    args = parser.parse_args()
    compare(args.reference, args.candidate)
