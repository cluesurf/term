#!/bin/sh
# term's Fedora half, run inside task/distro/fedora.dockerfile by task/distro.ts. Two modes:
#
#   build   /in/term-linux-{x64,arm64}.tar.gz (the release payloads) -> /out/term-<VERSION>-1.{x86_64,aarch64}.rpm
#   index   /repo, a dnf repository whose <version>/ folders hold every .rpm it lists -> its repodata/. The host signs
#           repomd.xml (repomd.xml.asc): the key never enters a container. Only repodata/ is published: term.surf
#           redirects each <version>/ path to the GitHub release (mesh/site/term.surf/home/site/tool/release-redirect.ts)
#
# Both architectures build on whichever this container runs on: the spec compiles nothing, so `--target` only names
# the architecture the package is for.
set -eu

mode="$1"

if [ "$mode" = build ]; then
  for pair in x64:x86_64 arm64:aarch64; do
    from="${pair%%:*}"
    arch="${pair#*:}"
    source="/tmp/source-$arch"

    rm -rf "$source" /tmp/rpm
    mkdir -p "$source"
    tar -xzf "/in/term-linux-$from.tar.gz" -C "$source"

    rpmbuild -bb --quiet --target "$arch" \
      --define "_topdir /tmp/rpm" \
      --define "_sourcedir $source" \
      --define "version $VERSION" \
      --define "summary $SUMMARY" \
      --define "node_floor $NODE_FLOOR" \
      /task/term.spec >/dev/null

    cp /tmp/rpm/RPMS/"$arch"/term-"$VERSION"-1."$arch".rpm /out/
  done

  exit 0
fi

if [ "$mode" = index ]; then
  rm -rf /repo/repodata
  createrepo_c --quiet --simple-md-filenames /repo

  exit 0
fi

echo "fedora.sh: the mode is build or index, not '$mode'" >&2
exit 64
