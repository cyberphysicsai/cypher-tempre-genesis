#!/bin/sh
# Generated setup contains reviewed source, not a remote shell script.
set -eu
umask 077
system=$(uname -s)
machine=$(uname -m)
case "$system" in Darwin) platform=darwin ;; Linux) platform=linux ;; *) echo 'ChainChat requires macOS or Linux.' >&2; exit 1 ;; esac
case "$machine" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo 'Supported architectures: ARM64 and x64.' >&2; exit 1 ;; esac
if [ "$platform" != '@PLATFORM@' ]; then echo 'Use the installer for this operating system.' >&2; exit 1; fi
if [ "$platform" = darwin ]; then
  os_version=$(sw_vers -productVersion)
  os_major=$(printf '%s' "$os_version" | cut -d. -f1)
  os_minor=$(printf '%s' "$os_version" | cut -d. -f2)
  if [ "$os_major" -lt 13 ] || { [ "$os_major" -eq 13 ] && [ "$os_minor" -lt 5 ]; }; then
    echo 'This reviewed Node runtime requires macOS 13.5 or newer.' >&2; exit 1
  fi
fi
case "$platform-$arch" in
@RUNTIME_CASES@
*) echo 'No reviewed runtime is available for this platform.' >&2; exit 1 ;;
esac
if [ "$platform" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  echo 'This installer supports glibc Linux. Alpine/musl needs a separate supported runtime.' >&2; exit 1
fi
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/chainchat-setup.XXXXXXXX")
case "$temp_dir" in /*/chainchat-setup.*) ;; *) echo 'Could not create a private setup directory.' >&2; exit 1 ;; esac
chmod 700 "$temp_dir"
cleanup() {
  case "$temp_dir" in /*/chainchat-setup.*) if [ -d "$temp_dir" ] && [ ! -L "$temp_dir" ]; then rm -rf -- "$temp_dir"; fi ;; esac
}
trap cleanup 0
trap 'exit 130' 1 2 15
cache_dir=${CT_INSTALL_CACHE:-}
previous=''
for argument do
  if [ "$previous" = --cache-dir ]; then cache_dir=$argument; fi
  previous=$argument
done
if [ -z "$cache_dir" ]; then
  if [ "$platform" = darwin ]; then cache_dir="$HOME/Library/Caches/CypherTempre/downloads";
  else cache_dir="${XDG_CACHE_HOME:-$HOME/.cache}/CypherTempre/downloads"; fi
fi
mkdir -p "$cache_dir"
hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}';
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}';
  else echo 'A SHA-256 utility is required.' >&2; exit 1; fi
}
python_archive="$cache_dir/$python_name"
if [ ! -f "$python_archive" ] || [ "$(hash_file "$python_archive")" != "$python_sha" ]; then
  echo 'Downloading the reviewed portable Python runtime…'
  if command -v curl >/dev/null 2>&1; then
    curl --disable --fail --location --proto '=https' --tlsv1.2 --output "$temp_dir/python.tar.gz" "$python_url"
  elif command -v wget >/dev/null 2>&1; then
    wget --https-only --output-document="$temp_dir/python.tar.gz" "$python_url"
  else echo 'Install curl or wget before running setup.' >&2; exit 1; fi
  if [ "$(hash_file "$temp_dir/python.tar.gz")" != "$python_sha" ]; then echo 'Python integrity check failed.' >&2; exit 1; fi
  mv "$temp_dir/python.tar.gz" "$python_archive"
fi
# This exact hash-pinned upstream archive was reviewed when the installer built.
tar -xzf "$python_archive" -C "$temp_dir"
if [ ! -x "$temp_dir/python/bin/python3" ]; then echo 'The reviewed Python runtime is unavailable.' >&2; exit 1; fi
awk 'found { print } /^__CHAINCHAT_PAYLOAD__$/ { found=1 }' "$0" > "$temp_dir/bundle.base64"
if [ "$platform" = darwin ]; then base64 -D < "$temp_dir/bundle.base64" > "$temp_dir/bundle.tar.gz";
else base64 -d < "$temp_dir/bundle.base64" > "$temp_dir/bundle.tar.gz"; fi
if [ "$(hash_file "$temp_dir/bundle.tar.gz")" != '@BUNDLE_SHA256@' ]; then echo 'Bundled application integrity check failed.' >&2; exit 1; fi
mkdir "$temp_dir/bundle"
tar -xzf "$temp_dir/bundle.tar.gz" -C "$temp_dir/bundle"
"$temp_dir/python/bin/python3" -I "$temp_dir/bundle/posix_install.py" --bundle "$temp_dir/bundle" --bootstrap-python "$temp_dir/python" --cache-dir "$cache_dir" "$@"
result=$?
# The Python installer safely reclaims only its own marked bootstrap directory.
exit "$result"
__CHAINCHAT_PAYLOAD__
