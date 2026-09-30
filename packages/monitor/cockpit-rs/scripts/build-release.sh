#!/bin/sh
set -eu

# usage: build-release.sh <target-triple> <out-dir> [--zig]
# usage: build-release.sh --sums <out-dir>
if [ "$#" -eq 2 ] && [ "$1" = "--sums" ]; then
  cd "$2"
  case $(uname -s) in
    Darwin) checksum="shasum -a 256" ;;
    *) checksum=sha256sum ;;
  esac
  LC_ALL=C
  export LC_ALL
  for asset in cockpit-*; do
    [ -f "$asset" ] || { echo "No cockpit assets found" >&2; exit 1; }
    hash=$($checksum "$asset")
    printf '%s  %s\n' "${hash%% *}" "$asset"
  done > SHA256SUMS
  exit 0
fi

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ] || { [ "$#" -eq 3 ] && [ "$3" != "--zig" ]; }; then
  echo "usage: build-release.sh <target-triple> <out-dir> [--zig] | --sums <out-dir>" >&2
  exit 2
fi
target=$1
mkdir -p "$2"
out_dir=$(cd -P "$2" && pwd)
crate_dir=$(cd -P "$(dirname "$0")/.." && pwd)
cd "$crate_dir"
if [ "${3:-}" = "--zig" ]; then
  cargo zigbuild --release --locked --target "$target" --manifest-path "$crate_dir/Cargo.toml"
else
  cargo build --release --locked --target "$target" --manifest-path "$crate_dir/Cargo.toml"
fi
cp "${CARGO_TARGET_DIR:-$crate_dir/target}/$target/release/cockpit" "$out_dir/cockpit-$target"
