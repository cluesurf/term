#!/bin/bash
# find-linux-session <x11|wayland> <command> [args]: a desktop session around one command. Inside the image
# Dockerfile.find-linux, which is its entrypoint. The exit status is the command's.
#
# Everything runs under `dbus-run-session`, so the session bus dies with the command. The accessibility bus is
# launched at once (the toolkits ask the session bus for it) and the toolkits told to answer on it.
if [ "${FIND_LINUX_INNER:-}" != 1 ]; then
  session="${1:-}"

  case "$session" in
    x11 | wayland) ;;
    *)
      echo "usage: find-linux-session <x11|wayland> <command> [args]" >&2
      exit 64
      ;;
  esac

  if [ "$#" -lt 2 ]; then
    echo "find-linux-session: no command given" >&2
    exit 64
  fi

  export FIND_LINUX_INNER=1
  exec dbus-run-session -- "$0" "$@"
fi

session="$1"
shift

export XDG_RUNTIME_DIR=/tmp/xdg-runtime
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
export NO_AT_BRIDGE=0
export GNOME_ACCESSIBILITY=1
export QT_LINUX_ACCESSIBILITY_ALWAYS_ON=1
export QT_ACCESSIBILITY=1
export GSETTINGS_BACKEND=memory

pids=()

stop() {
  for pid in "${pids[@]}"; do
    kill "$pid" 2>/dev/null
  done
}

trap stop EXIT

/usr/libexec/at-spi-bus-launcher --launch-immediately >/tmp/atspi-bus.log 2>&1 &
pids+=("$!")

# the toolkits find the accessibility bus through the session bus: wait until it is there
for _ in $(seq 1 50); do
  if dbus-send --session --print-reply --dest=org.a11y.Bus /org/a11y/bus org.a11y.Bus.GetAddress >/dev/null 2>&1; then
    break
  fi

  sleep 0.1
done

if [ "$session" = x11 ]; then
  export DISPLAY=:99
  export GDK_BACKEND=x11
  export QT_QPA_PLATFORM=xcb
  Xvfb :99 -screen 0 1280x800x24 >/tmp/xvfb.log 2>&1 &
  pids+=("$!")

  for _ in $(seq 1 50); do
    if xdpyinfo >/dev/null 2>&1; then
      break
    fi

    sleep 0.1
  done

  openbox >/tmp/openbox.log 2>&1 &
  pids+=("$!")

  for _ in $(seq 1 50); do
    if wmctrl -m >/dev/null 2>&1; then
      break
    fi

    sleep 0.1
  done
else
  export WLR_BACKENDS=headless
  export WLR_RENDERER=pixman
  export WLR_LIBINPUT_NO_DEVICES=1
  export GDK_BACKEND=wayland
  export QT_QPA_PLATFORM=wayland
  export XDG_SESSION_TYPE=wayland
  : >/tmp/sway-config
  sway -c /tmp/sway-config >/tmp/sway.log 2>&1 &
  pids+=("$!")

  for _ in $(seq 1 100); do
    if [ -S "$XDG_RUNTIME_DIR/wayland-1" ]; then
      break
    fi

    sleep 0.1
  done

  export WAYLAND_DISPLAY=wayland-1
  # sway names its control socket after its pid
  export SWAYSOCK="$(ls "$XDG_RUNTIME_DIR"/sway-ipc.*.sock 2>/dev/null | head -n 1)"
fi

echo "find-linux-session: $session ready ($(date +%T))" >&2
"$@"
status=$?
echo "find-linux-session: command exited $status" >&2
exit "$status"
