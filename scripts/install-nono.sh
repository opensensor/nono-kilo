#!/usr/bin/env bash
# Install the tested release locally; no root access or shell configuration changes.
set -euo pipefail
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["nono"])' "$repo_dir/versions.json")"
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) target=x86_64-unknown-linux-gnu ;;
  Linux/aarch64) target=aarch64-unknown-linux-gnu ;;
  Darwin/x86_64) target=x86_64-apple-darwin ;;
  Darwin/arm64) target=aarch64-apple-darwin ;;
  *) echo "Unsupported platform" >&2; exit 1 ;;
esac
asset="nono-v${version}-${target}.tar.gz"
download_dir="$(mktemp -d)"
trap 'rm -rf -- "$download_dir"' EXIT
base="https://github.com/nolabs-ai/nono/releases/download/v${version}"
curl --fail --silent --show-error --location --retry 3 "$base/$asset" -o "$download_dir/$asset"
curl --fail --silent --show-error --location --retry 3 "$base/SHA256SUMS.txt" -o "$download_dir/SHA256SUMS.txt"
python3 - "$download_dir" "$asset" <<'PY'
import hashlib, pathlib, sys
directory, asset = pathlib.Path(sys.argv[1]), sys.argv[2]
entries = {}
for line in (directory / "SHA256SUMS.txt").read_text().splitlines():
    digest, name = line.split(maxsplit=1)
    entries[name.lstrip("*")] = digest
actual = hashlib.sha256((directory / asset).read_bytes()).hexdigest()
if entries.get(asset) != actual:
    raise SystemExit("nono release checksum mismatch or missing checksum")
print(f"Verified {asset}")
PY
tar -xzf "$download_dir/$asset" -C "$download_dir" nono
mkdir -p "$repo_dir/.tools/bin"
install -m 755 "$download_dir/nono" "$repo_dir/.tools/bin/nono"
"$repo_dir/.tools/bin/nono" --version
