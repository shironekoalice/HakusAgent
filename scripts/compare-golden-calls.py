"""Compare two captured model requests from scripts/model_stub.py byte-for-byte.

Used by the Phase-1 golden-replay gate: after a Runtime restart, the model input
reconstructed from durable state must serialize to exactly the same bytes.

Usage:
    python scripts/compare-golden-calls.py CAPTURE.jsonl LEFT_INDEX RIGHT_INDEX
"""

import json
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def load(path: str) -> list[dict]:
    out = []
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                out.append(json.loads(line))
    return out


def canonical(value) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__)
        return 2
    path, left_i, right_i = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
    calls = load(path)
    by_index = {c["call_index"]: c for c in calls}
    missing = [i for i in (left_i, right_i) if i not in by_index]
    if missing:
        print(f"FAIL: capture has no call(s) {missing}; available={sorted(by_index)}")
        return 1

    left, right = by_index[left_i], by_index[right_i]
    lb, rb = left["body"], right["body"]
    lm, rm = lb.get("messages") or [], rb.get("messages") or []

    print(f"call #{left_i}: {len(lm)} messages, model={lb.get('model')}, sha256={left['sha256']}")
    print(f"call #{right_i}: {len(rm)} messages, model={rb.get('model')}, sha256={right['sha256']}")
    print()

    failures = 0

    if len(lm) != len(rm):
        print(f"FAIL: message counts differ ({len(lm)} vs {len(rm)})")
        failures += 1
    else:
        print(f"PASS: message counts match ({len(lm)})")

    for i, (a, b) in enumerate(zip(lm, rm)):
        if canonical(a) == canonical(b):
            print(f"PASS: message[{i}] role={a.get('role')} byte-identical ({len(canonical(a))} chars)")
        else:
            failures += 1
            print(f"FAIL: message[{i}] differs (roles {a.get('role')} vs {b.get('role')})")
            ca, cb = canonical(a), canonical(b)
            for n, (x, y) in enumerate(zip(ca, cb)):
                if x != y:
                    lo = max(0, n - 90)
                    print(f"      first diff at char {n}")
                    print(f"        left : ...{ca[lo:n + 90]}...")
                    print(f"        right: ...{cb[lo:n + 90]}...")
                    break
            else:
                print(f"      one is a prefix of the other (len {len(ca)} vs {len(cb)})")

    same_message_stack = canonical(lm) == canonical(rm)
    print()
    print(f"message stack identical: {same_message_stack}")
    print(f"full body sha256 equal: {left['sha256'] == right['sha256']}")

    if failures == 0:
        print("\nGOLDEN REPLAY PASS: model input is byte-identical across the rebuild")
        return 0
    print(f"\nGOLDEN REPLAY FAIL: {failures} difference(s)")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
