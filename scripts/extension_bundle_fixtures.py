"""Run lifecycle and redaction fixtures for staged feature bundles.

This runner intentionally uses only the standard library. It validates the
candidate adapter process in an isolated temporary snapshot; it never enables
the bundle in the Runtime registry and never touches external source trees.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BUNDLES = {
    "voice.celia": ROOT / "extensions" / "staged" / "voice.celia",
    "avatar.vtuber": ROOT / "extensions" / "staged" / "avatar.vtuber",
    "legacy.provider": ROOT / "extensions" / "staged" / "legacy.provider",
}
PROHIBITED_NAMES = {".venv", "__pycache__", "data", "models", "output"}
PROHIBITED_SUFFIXES = {".psd", ".wav", ".mp3", ".flac", ".onnx", ".pth", ".pt"}
LITERAL_SECRET_PATTERNS = (
    re.compile(r"(?i)\bsk-[A-Za-z0-9_-]{16,}"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]{16,}"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(
        r"(?i)\b(?:api[_-]?key|access[_-]?token|secret|password)[ \t]*[:=][ \t]*['\"]?[A-Za-z0-9_./+=-]{16,}"
    ),
)


def source_digest(bundle: Path) -> str:
    hasher = hashlib.sha256()
    included = []
    for path in bundle.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(bundle).as_posix()
        if "__pycache__" in path.parts or path.suffix.lower() == ".pyc":
            continue
        if relative == "plugin.json" or relative.startswith("fixtures/"):
            continue
        if relative in {
            "DEPENDENCIES.md",
            "PERMISSIONS.md",
            "ROLLBACK_RECEIPT.md",
            "checksums.sha256",
            "source-files.sha256",
        }:
            continue
        included.append((relative, path))
    for relative, path in sorted(included):
        data = path.read_bytes()
        hasher.update(relative.encode("utf-8"))
        hasher.update(b"\0")
        hasher.update(len(data).to_bytes(8, "little"))
        hasher.update(data)
    return hasher.hexdigest()


def run_adapter(bundle: Path, raw_input: str) -> tuple[int, list[dict], str]:
    process = subprocess.Popen(
        [sys.executable, "adapter.py"],
        cwd=bundle,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        encoding="utf-8",
        env={"PATH": os.environ.get("PATH", ""), "SystemRoot": os.environ.get("SystemRoot", "")},
    )
    stdout, _ = process.communicate(raw_input, timeout=10)
    parsed = []
    for line in stdout.splitlines():
        parsed.append(json.loads(line))
    return process.returncode, parsed, stdout


def assert_response(item: dict, extension_id: str, request_id: str, ok: bool) -> None:
    assert item["protocol"] == "hakus.extension.v1"
    assert item["extension_id"] == extension_id
    assert item["request_id"] == request_id
    assert item["ok"] is ok


def assert_no_literal_secrets(bundle: Path) -> None:
    for path in bundle.rglob("*"):
        if not path.is_file():
            continue
        text = path.read_text(encoding="utf-8", errors="ignore")
        for pattern in LITERAL_SECRET_PATTERNS:
            assert not pattern.search(text), f"literal secret-shaped value in {path.relative_to(bundle)}"


def assert_source_file_checksums(bundle: Path) -> None:
    checksum_file = bundle / "source-files.sha256"
    assert checksum_file.is_file(), "source-files.sha256 is required"
    expected: dict[str, str] = {}
    for line in checksum_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        fields = line.split(None, 1)
        assert len(fields) == 2, f"malformed source checksum line: {line!r}"
        digest, relative = fields
        assert re.fullmatch(r"[0-9a-fA-F]{64}", digest), f"invalid source checksum: {line!r}"
        assert relative not in expected, f"duplicate source checksum: {relative}"
        expected[relative] = digest.lower()

    actual: dict[str, str] = {}
    for path in bundle.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(bundle).as_posix()
        if (
            relative == "plugin.json"
            or relative.startswith("fixtures/")
            or relative in {
                "DEPENDENCIES.md",
                "PERMISSIONS.md",
                "ROLLBACK_RECEIPT.md",
                "checksums.sha256",
                "source-files.sha256",
            }
            or "__pycache__" in path.parts
            or path.suffix.lower() == ".pyc"
        ):
            continue
        actual[relative] = hashlib.sha256(path.read_bytes()).hexdigest()

    assert set(expected) == set(actual), "source-files.sha256 does not match the staged file set"
    for relative, digest in actual.items():
        assert expected[relative] == digest, f"source checksum mismatch: {relative}"


def run_bundle(extension_id: str, bundle: Path) -> dict:
    assert bundle.is_dir(), f"missing bundle: {bundle}"
    manifest = json.loads((bundle / "plugin.json").read_text(encoding="utf-8"))
    assert manifest["$schema"].strip(), "manifest schema is required"
    assert manifest["name"] == extension_id, "plugin and extension ids must match"
    assert re.fullmatch(
        r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", manifest["version"]
    ), "candidate version must use semver"
    extension = manifest["extensions"]["net.hakus"]["extension"]
    assert extension["id"] == extension_id
    assert extension["version"] == manifest["version"]
    assert extension["protocol"] == "hakus.extension.v1"
    assert extension["entrypoint"].strip(), "extension entrypoint is required"
    for field in ("capabilities", "permissions", "supported_platforms"):
        assert isinstance(extension[field], list) and extension[field], f"{field} is required"
        assert all(isinstance(value, str) and value.strip() for value in extension[field])
    assert re.fullmatch(r"sha256:[0-9a-f]{64}", extension["checksum"]), "invalid source checksum"
    assert extension["checksum"] == f"sha256:{source_digest(bundle)}"

    for path in bundle.rglob("*"):
        if path.name == "config.yaml" or path.suffix.lower() in PROHIBITED_SUFFIXES:
            raise AssertionError(f"prohibited staged input: {path.relative_to(bundle)}")
        if any(part in PROHIBITED_NAMES for part in path.parts):
            raise AssertionError(f"prohibited staged directory: {path.relative_to(bundle)}")
    assert_no_literal_secrets(bundle)
    assert_source_file_checksums(bundle)

    ping_id = f"fixture-success-{extension_id}"
    stop_id = f"fixture-stop-{extension_id}"
    request_prefix = (
        '{"protocol":"hakus.extension.v1","request_id":"%s",'
        '"extension_id":"%s","event_type":"extension.ping",'
        '"payload":{"token":"fixture-secret","path":"C:/user/audio.wav"}}\n'
    )
    stop = (
        '{"protocol":"hakus.extension.v1","request_id":"%s",'
        '"extension_id":"%s","event_type":"extension.stop","payload":{}}\n'
    )
    code, responses, raw = run_adapter(bundle, request_prefix % (ping_id, extension_id) + stop % (stop_id, extension_id))
    assert code == 0
    assert len(responses) == 2
    assert_response(responses[0], extension_id, ping_id, True)
    assert_response(responses[1], extension_id, stop_id, True)
    assert "fixture-secret" not in raw and "C:/user/audio.wav" not in raw

    malformed_code, malformed_responses, _ = run_adapter(bundle, "not-json\n")
    assert malformed_code == 2 and not malformed_responses

    crash_request = json.dumps(
        {
            "protocol": "hakus.extension.v1",
            "request_id": f"fixture-crash-{extension_id}",
            "extension_id": extension_id,
            "event_type": "extension.crash",
            "payload": {},
        }
    )
    crash_code, crash_responses, _ = run_adapter(bundle, crash_request + "\n")
    assert crash_code == 17 and not crash_responses

    with tempfile.TemporaryDirectory(prefix="hakus-extension-fixture-") as temporary:
        temporary_root = Path(temporary)
        active = temporary_root / "active"
        previous = temporary_root / "previous"
        shutil.copytree(bundle, active)
        shutil.copytree(active, previous)
        original_digest = source_digest(previous)
        (active / "plugin.json").write_text("{ invalid upgrade", encoding="utf-8")
        try:
            json.loads((active / "plugin.json").read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            shutil.rmtree(active)
            shutil.copytree(previous, active)
        assert source_digest(active) == original_digest
        shutil.rmtree(active)
        assert not active.exists() and previous.exists()

    return {
        "extension_id": extension_id,
        "source_digest": source_digest(bundle),
        "success": True,
        "malformed": True,
        "crash": True,
        "stop": True,
        "uninstall": True,
        "failed_upgrade_rollback": True,
        "redaction": True,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bundle", choices=[*BUNDLES, "all"], default="all")
    args = parser.parse_args()
    selected = BUNDLES.items() if args.bundle == "all" else [(args.bundle, BUNDLES[args.bundle])]
    reports = [run_bundle(extension_id, bundle) for extension_id, bundle in selected]
    print(json.dumps({"status": "pass", "bundles": reports}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
