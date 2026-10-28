#!/usr/bin/env bash
# Prepare only Kilo's directories, then enter the signed nono profile.
# Paths must exist before nono resolves its filesystem grants.
set -euo pipefail
umask 077

if [[ "${1:-}" != "--prepare-only" ]]; then
  command -v nono >/dev/null || { echo "Install nono 0.80.0 or newer first" >&2; exit 127; }
  command -v kilo >/dev/null || { echo "Install the Kilo CLI first" >&2; exit 127; }
elif [[ "$#" != 1 ]]; then
  echo "--prepare-only takes no additional arguments" >&2
  exit 2
fi

config_base="${XDG_CONFIG_HOME:-$HOME/.config}"
data_base="${XDG_DATA_HOME:-$HOME/.local/share}"
state_base="${XDG_STATE_HOME:-$HOME/.local/state}"
cache_base="${XDG_CACHE_HOME:-$HOME/.cache}"

for base in "$config_base" "$data_base" "$state_base" "$cache_base"; do
  case "$base" in
    /*) ;;
    *) echo "OpenSensor Kilo requires absolute XDG directory paths" >&2; exit 1 ;;
  esac
done

mkdir -p -- \
  "$config_base/kilo" \
  "$data_base/kilo" \
  "$state_base/opensensor-kilo" \
  "$cache_base/kilo/tmp"

if [[ "${1:-}" == "--prepare-only" ]]; then
  exit 0
fi

exec nono run --profile opensensor/kilo --allow-cwd -- kilo "$@"
