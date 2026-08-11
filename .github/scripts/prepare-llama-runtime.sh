#!/usr/bin/env bash
set -euo pipefail

release="b10344"
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64)
    asset="llama-b10344-bin-macos-arm64.tar.gz"
    expected_sha256="24bf4348ddc6d1d9b465105ed8ae371e326c576623ac612fbff73532181c8f13"
    ;;
  Darwin-x86_64)
    asset="llama-b10344-bin-macos-x64.tar.gz"
    expected_sha256="4df4fe900423ec147552724ad4ebbbbd03c8991dcd8f32c1ea20446c5d942c13"
    ;;
  Linux-x86_64)
    asset="llama-b10344-bin-ubuntu-x64.tar.gz"
    expected_sha256="01b90b0764821d0e53b985730eea3837e29a976ee00e783e18837937b93fc3f1"
    ;;
  *)
    echo "Unsupported llama.cpp runtime platform: $(uname -s)-$(uname -m)" >&2
    exit 1
    ;;
esac

script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
runtime_directory="$(cd "$script_directory/../.." && pwd)/apps/desktop/src-tauri/resources/llama-runtime"
temporary_directory="$(mktemp -d)"
archive_path="$temporary_directory/$asset"
extract_directory="$temporary_directory/extracted"
trap 'rm -rf -- "$temporary_directory"' EXIT

mkdir -p "$extract_directory" "$runtime_directory"
curl --fail --location --retry 3 --output "$archive_path" \
  "https://github.com/ggml-org/llama.cpp/releases/download/$release/$asset"
actual_sha256="$(shasum -a 256 "$archive_path" | awk '{print $1}')"
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  echo "llama.cpp runtime checksum mismatch: expected $expected_sha256, got $actual_sha256" >&2
  exit 1
fi
tar -xzf "$archive_path" -C "$extract_directory"
server_path="$(find "$extract_directory" -type f -name llama-server -print -quit)"
if [[ -z "$server_path" ]]; then
  echo "llama-server was not found in $asset" >&2
  exit 1
fi
find "$runtime_directory" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
cp -R "$(dirname "$server_path")"/. "$runtime_directory"/
chmod +x "$runtime_directory/llama-server"
