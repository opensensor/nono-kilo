#!/usr/bin/env python3
"""Validate the release inventory before signing or publishing it."""

import argparse
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def release_files(tag=None):
    manifest = json.loads((ROOT / "package.json").read_text())
    policy = json.loads((ROOT / "policy.json").read_text())
    versions = json.loads((ROOT / "versions.json").read_text())
    if manifest["name"] != "kilo" or manifest["schema_version"] != 1:
        raise ValueError("expected a schema-v1 kilo pack")
    version = manifest["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?", version):
        raise ValueError("package version must be semver")
    if tag is not None and tag != "v" + version:
        raise ValueError(f"tag {tag!r} does not match manifest v{version}")
    if policy["meta"]["version"] != version:
        raise ValueError("profile and package versions must match")
    if manifest["min_nono_version"] != versions["nono"]:
        raise ValueError("test the minimum supported nono version")
    files = {"package.json"}
    profiles = []
    for artifact in manifest["artifacts"]:
        name = artifact["path"]
        path = PurePosixPath(name)
        if path.is_absolute() or ".." in path.parts or str(path) != name:
            raise ValueError(f"unsafe artifact path: {name}")
        if any(char.isspace() for char in name):
            raise ValueError(f"artifact paths cannot contain whitespace: {name}")
        target = ROOT / name
        if not target.is_file() or target.is_symlink():
            raise ValueError(f"artifact must be an existing regular file: {name}")
        if not target.resolve().is_relative_to(ROOT):
            raise ValueError(f"artifact escapes the repository: {name}")
        if name in files:
            raise ValueError(f"duplicate artifact: {name}")
        files.add(name)
        if artifact["type"] == "profile":
            profiles.append(artifact["install_as"])
    if profiles != ["kilo"]:
        raise ValueError("nono requires the public profile name to match the pack name")
    destinations = set()
    for directive in manifest["wiring"]:
        if directive["type"] != "write_file" or directive["source"] not in files:
            raise ValueError("wiring must copy a declared artifact")
        if directive["dest"] in destinations:
            raise ValueError("duplicate wiring destination")
        destinations.add(directive["dest"])
        known = {"PACK_DIR", "NS", "PLUGIN", "HOME", "XDG_CONFIG_HOME", "NONO_CONFIG", "NONO_PACKAGES", "NOW"}
        unknown = set(re.findall(r"\$([A-Z_][A-Z_0-9]*)", directive["dest"])) - known
        if unknown:
            raise ValueError(f"unsupported nono wiring variables: {sorted(unknown)}")
    launcher = "bin/nono-kilo.sh"
    if launcher not in files or not (ROOT / launcher).stat().st_mode & 0o111:
        raise ValueError("the launcher must be packaged and executable")
    return sorted(files)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--files", action="store_true", help="print the signing inventory")
    parser.add_argument("--tag", help="require the exact matching release tag")
    parser.add_argument("--nono", help="also validate the profile with this nono binary")
    args = parser.parse_args()
    try:
        files = release_files(args.tag)
        if args.nono:
            subprocess.run([args.nono, "profile", "validate", str(ROOT / "policy.json")], check=True)
    except (ValueError, KeyError, OSError, subprocess.CalledProcessError) as error:
        print(f"Validation failed: {error}", file=sys.stderr)
        return 1
    print("\n".join(files) if args.files else f"Validated {len(files)} release files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
