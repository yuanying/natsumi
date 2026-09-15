#!/bin/sh
# Builds the root filesystem of the natsumi-tools image (ADR 0011) into an empty directory:
# each command listed in tools-commands.txt at /bin/<name>, the shared libraries it loads, and the mount points.
# Nothing else is copied, so the image has no package manager, interpreter, network tool or git.
#
#   tools-rootfs.sh <tools-commands.txt> <root>
#
# A listed command that is not installed stops the build.
set -eu

list="$1"
root="$2"

mkdir -p "$root/bin" "$root/memory" "$root/run/natsumi-tools" "$root/tmp"

copy_with_libraries() {
  source="$1"
  target="$2"
  cp "$source" "$root$target"
  # "name => /path (addr)" for libraries, "/path (addr)" for the loader; the vDSO has no path.
  ldd "$source" | awk '$2 == "=>" && $3 ~ /^\// { print $3 } $1 ~ /^\// { print $1 }' | while read -r library; do
    mkdir -p "$root$(dirname "$library")"
    cp -L "$library" "$root$library"
  done
}

grep -v '^#' "$list" | while read -r name; do
  [ -n "$name" ] || continue
  case "$name" in
    sh) source=/bin/dash ;;
    *) source="$(command -v "$name" || true)" ;;
  esac
  [ -n "$source" ] || { echo "tools-rootfs: $name is not installed" >&2; exit 1; }
  copy_with_libraries "$(readlink -f "$source")" "/bin/$name"
done
