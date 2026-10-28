#!/usr/bin/env bash
# CI-only: test Kilo's official standalone distribution at its normal install path.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == "true" ]] || { echo "This installer is only for disposable GitHub runners" >&2; exit 1; }
repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
version="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["kilo"])' "$repo_dir/versions.json")"
case "$(uname -s)/$(uname -m)" in
  Linux/x86_64) asset=kilo-linux-x64.tar.gz ;;
  Linux/aarch64) asset=kilo-linux-arm64.tar.gz ;;
  Darwin/x86_64) asset=kilo-darwin-x64.zip ;;
  Darwin/arm64) asset=kilo-darwin-arm64.zip ;;
  *) echo "Unsupported platform" >&2; exit 1 ;;
esac
download_dir="$(mktemp -d)"
trap 'rm -rf -- "$download_dir"' EXIT
base="https://github.com/Kilo-Org/kilocode/releases/download/v${version}"
curl --fail --silent --show-error --location --retry 3 "$base/$asset" -o "$download_dir/$asset"
curl --fail --silent --show-error --location --retry 3 "$base/kilo-cli-SHA256SUMS" -o "$download_dir/SHA256SUMS"
python3 - "$download_dir" "$asset" <<'PY'
import hashlib, pathlib, sys
directory, asset = pathlib.Path(sys.argv[1]), sys.argv[2]
entries = {}
for line in (directory / "SHA256SUMS").read_text().splitlines():
    digest, name = line.split(maxsplit=1)
    entries[name.lstrip("*")] = digest
if entries.get(asset) != hashlib.sha256((directory / asset).read_bytes()).hexdigest():
    raise SystemExit("Kilo release checksum mismatch or missing checksum")
print(f"Verified {asset}")
PY
mkdir -p "$HOME/.kilo/bin"
case "$asset" in
  *.zip) unzip -q "$download_dir/$asset" -d "$HOME/.kilo/bin" ;;
  *.tar.gz) tar -xzf "$download_dir/$asset" -C "$HOME/.kilo/bin" ;;
esac
chmod +x "$HOME/.kilo/bin/kilo"
echo "$HOME/.kilo/bin" >> "$GITHUB_PATH"
"$HOME/.kilo/bin/kilo" --version
