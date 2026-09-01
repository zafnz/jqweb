#!/bin/sh
# Installs the latest jqweb release into ~/.local/bin.
#
#   curl -fsSL https://raw.githubusercontent.com/zafnz/jqweb/main/install.sh | sh
#
# PREFIX=/usr/local  install elsewhere (binary goes in $PREFIX/bin)
# VERSION=v0.1.0     install a specific release instead of the latest
set -eu

repo=zafnz/jqweb
prefix="${PREFIX:-$HOME/.local}"
bindir="$prefix/bin"
version="${VERSION:-}"

die() {
	echo "install.sh: $*" >&2
	exit 1
}

command -v curl >/dev/null 2>&1 || die "curl is required"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
linux | darwin) ;;
*) die "unsupported OS: $os (macOS and Linux only; Windows builds are on the releases page)" ;;
esac

arch=$(uname -m)
case "$arch" in
x86_64 | amd64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) die "unsupported architecture: $arch" ;;
esac

# The latest release redirects to /releases/tag/<tag>, which avoids the
# GitHub API and its unauthenticated rate limit.
if [ -z "$version" ]; then
	latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest") ||
		die "could not reach github.com"
	version=${latest##*/tag/}
	[ "$version" != "$latest" ] || die "could not determine the latest version"
fi

number=${version#v}
url="https://github.com/$repo/releases/download/$version/jqweb_${number}_${os}_${arch}.tar.gz"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

curl -fsSL -o "$tmp/jqweb.tar.gz" "$url" || die "could not download $url"
tar xzf "$tmp/jqweb.tar.gz" -C "$tmp" jqweb || die "unexpected archive contents"

mkdir -p "$bindir"
install -m 0755 "$tmp/jqweb" "$bindir/jqweb"

echo "jqweb $number installed to $bindir/jqweb"

case ":$PATH:" in
*":$bindir:"*) ;;
*) echo "install.sh: $bindir is not on your PATH" >&2 ;;
esac
