"""Walk the AT-SPI tree and print what is on the desktop. Run as `python3 -I /usr/local/bin/find-linux-walk [app-name]`.

Prints one line per application, frame and push button found, then `walk frames=N buttons=M`. Exits 0 when the
named application (default gnome-text-editor) has at least one frame and at least one push button, else 1.
"""
import sys

import gi

gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

want = sys.argv[1] if len(sys.argv) > 1 else "gnome-text-editor"
FRAMES = (Atspi.Role.FRAME, Atspi.Role.WINDOW, Atspi.Role.DIALOG)


def children(node):
    try:
        return [node.get_child_at_index(i) for i in range(node.get_child_count())]
    except Exception:
        return []


def walk(node, depth, found):
    role = node.get_role()
    name = node.get_name() or ""

    if role in FRAMES:
        found["frames"].append(name)
        print(f"{'  ' * depth}frame {name!r}")

    if role == Atspi.Role.PUSH_BUTTON:
        found["buttons"].append(name)
        print(f"{'  ' * depth}push button {name!r}")

    for child in children(node):
        if child is not None:
            walk(child, depth + 1, found)


Atspi.init()
desktop = Atspi.get_desktop(0)
mine = None

for app in children(desktop):
    if app is None:
        continue

    print(f"application {app.get_name()!r}")

    if want in (app.get_name() or "").lower() or app.get_name() == want:
        mine = app

if mine is None:
    print(f"walk: no application named {want}")
    sys.exit(1)

found = {"frames": [], "buttons": []}
walk(mine, 1, found)
print(f"walk frames={len(found['frames'])} buttons={len(found['buttons'])}")
sys.exit(0 if found["frames"] and found["buttons"] else 1)
