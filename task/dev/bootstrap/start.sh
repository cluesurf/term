#!/usr/bin/env sh
# Set up a Term development environment on macOS or Linux.
#
#   sh task/dev/bootstrap/start.sh check
#   sh task/dev/bootstrap/start.sh install            what it would run
#   sh task/dev/bootstrap/start.sh install --commit   run it
#
# The setup itself is a Term program (base.tree beside this file), so this only puts in place what that program
# needs to run: Node, pnpm, the workspace's packages and the Term CLI. Node is unpacked from nodejs.org into
# ~/.local/share/term-dev, never installed system-wide, and only when --commit is given. Then it hands every argument
# to base.tree.
set -eu

NODE_VERSION="24.11.0"
PNPM_VERSION="12.8.1"
STORE="$HOME/.local/share/term-dev"

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"

COMMIT=no
for word in "$@"; do
  if [ "$word" = "--commit" ]; then
    COMMIT=yes
  fi
done

case "$(uname -s)" in
  Darwin) SYSTEM=darwin ;;
  Linux) SYSTEM=linux ;;
  *) echo "start.sh is for macOS and Linux; on Windows run start.ps1" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64 | aarch64) ARCH=arm64 ;;
  *) ARCH=x64 ;;
esac

NODE_NAME="node-v$NODE_VERSION-$SYSTEM-$ARCH"
NODE_HOME="$STORE/$NODE_NAME"

# a Node of 22 or later on PATH, or the one this script unpacked
if [ -x "$NODE_HOME/bin/node" ]; then
  PATH="$NODE_HOME/bin:$PATH"
fi

# the major version of the Node on PATH, empty when there is none
node_major() {
  if command -v node >/dev/null 2>&1; then
    node --version | sed 's/^v\([0-9]*\).*/\1/'
  fi
}

MAJOR="$(node_major)"

if [ -z "$MAJOR" ] || [ "$MAJOR" -lt 22 ]; then
  if [ "$COMMIT" != yes ]; then
    echo "Node 22 or later is missing. With --commit this unpacks Node $NODE_VERSION into $NODE_HOME."
    exit 0
  fi

  if [ "$SYSTEM" = darwin ]; then
    ARCHIVE="$NODE_NAME.tar.gz"
  else
    ARCHIVE="$NODE_NAME.tar.xz"
  fi

  mkdir -p "$STORE"
  curl --fail --location --silent --show-error \
    --output "$STORE/$ARCHIVE" \
    "https://nodejs.org/dist/v$NODE_VERSION/$ARCHIVE"
  tar -xf "$STORE/$ARCHIVE" -C "$STORE"
  rm "$STORE/$ARCHIVE"
  PATH="$NODE_HOME/bin:$PATH"
fi

# pnpm, at the version package.json names
if ! command -v pnpm >/dev/null 2>&1; then
  if [ "$COMMIT" != yes ]; then
    echo "pnpm is missing. With --commit this switches it on through corepack."
    exit 0
  fi

  corepack enable --install-directory "$(dirname "$(command -v node)")"
  corepack prepare "pnpm@$PNPM_VERSION" --activate
fi

# the workspace's packages and the Term CLI
if [ ! -d "$ROOT/node_modules" ]; then
  if [ "$COMMIT" != yes ]; then
    echo "The workspace's packages are missing. With --commit this runs pnpm install in $ROOT."
    exit 0
  fi

  pnpm --dir "$ROOT" install
fi

if [ ! -f "$ROOT/host/line.js" ]; then
  if [ "$COMMIT" != yes ]; then
    echo "The Term CLI is not built. With --commit this runs pnpm run make:line in $ROOT."
    exit 0
  fi

  pnpm --dir "$ROOT" run make:line
fi

cd "$ROOT"
TERM_DEV_ROOT="$ROOT"
export TERM_DEV_ROOT PATH
exec node "$ROOT/host/line.js" boot "$HERE/base.tree" -- "$@"
