#!/bin/sh
# term's Debian half, run inside task/distro/debian.dockerfile by task/distro.ts. Two modes:
#
#   build   /in/term-linux-{x64,arm64}.tar.gz (the release payloads) -> /out/term_<VERSION>_{amd64,arm64}.deb
#   index   /repo, an apt repository whose pool/<version>/ folders hold every .deb it lists -> its dists/, with an
#           UNSIGNED Release. The host signs Release (InRelease, Release.gpg): the key never enters a container. The
#           pool is not published: term.surf redirects each pool/<version>/ path to the GitHub release
#           (mesh/site/term.surf/home/site/tool/release-redirect.ts)
#
# The package is the payload as released, unpacked at /usr/lib/term, and /usr/bin/term a link to its sh launcher,
# which follows the link back. Node is RECOMMENDED, not depended on: the launcher runs whatever `node` is on PATH, so
# a Node from nvm, fnm or a tarball, which dpkg cannot see, works, and one too old is named by the launcher itself.
set -eu

mode="$1"

if [ "$mode" = build ]; then
  for pair in x64:amd64 arm64:arm64; do
    from="${pair%%:*}"
    arch="${pair#*:}"
    root="/tmp/deb-$arch"

    rm -rf "$root"
    mkdir -p "$root/DEBIAN" "$root/usr/lib" "$root/usr/bin"
    tar -xzf "/in/term-linux-$from.tar.gz" -C "$root/usr/lib"
    ln -s ../lib/term/bin/term "$root/usr/bin/term"

    size="$(du -sk "$root/usr" | cut -f1)"

    cat > "$root/DEBIAN/control" <<EOF
Package: term
Version: $VERSION
Architecture: $arch
Maintainer: ClueSurf <base@clue.surf>
Installed-Size: $size
Recommends: nodejs (>= $NODE_FLOOR)
Section: devel
Priority: optional
Homepage: https://term.surf
Description: $SUMMARY
 The term command: the compiler, the package manager, the test runner and the
 language server of the Term language, run on Node.js $NODE_FLOOR or newer.
EOF

    dpkg-deb --root-owner-group -Zxz -b "$root" "/out/term_${VERSION}_$arch.deb" >/dev/null
  done

  exit 0
fi

if [ "$mode" = index ]; then
  cd /repo
  rm -rf dists

  for arch in amd64 arm64; do
    dir="dists/stable/main/binary-$arch"

    mkdir -p "$dir"
    # uncompressed only: a few lines a version, and nothing between term.surf's static files and apt can then
    # recompress or decode a .gz on the way and break its hash
    dpkg-scanpackages --arch "$arch" pool > "$dir/Packages" 2>/dev/null
  done

  apt-ftparchive \
    -o APT::FTPArchive::Release::Origin=ClueSurf \
    -o APT::FTPArchive::Release::Label=term \
    -o APT::FTPArchive::Release::Suite=stable \
    -o APT::FTPArchive::Release::Codename=stable \
    -o APT::FTPArchive::Release::Architectures="amd64 arm64" \
    -o APT::FTPArchive::Release::Components=main \
    -o APT::FTPArchive::Release::Description="term, https://term.surf" \
    release dists/stable > /tmp/Release
  mv /tmp/Release dists/stable/Release

  exit 0
fi

echo "debian.sh: the mode is build or index, not '$mode'" >&2
exit 64
