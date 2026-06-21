# Testing the Seed VS Code extension

This extension has two halves, and you test them separately and together.

- **Highlighting** — the TextMate grammar in `text/tree.json`. Pure VS Code, no server.
- **Language server** — `deck/flow/code/main.ts`, bundled to `host/server.js`, launched by `code/extension.ts` over stdio. This is where diagnostics, hover, completion, etc. live.

## 0. Build

```bash
cd deck/flow/editor/vscode
pnpm install --ignore-workspace
pnpm build            # -> host/extension.js + host/server.js
```

`--ignore-workspace` is required (this folder sits under the seed monorepo's `pnpm-workspace.yaml`).

## 1. Run the Extension Development Host

Open `deck/flow/editor/vscode` in VS Code and press **F5** (the `Run Seed Extension` launch config builds first, then opens a second window). In that window:

1. Create or open a file ending in `.tree`.
2. Confirm the language mode (bottom-right) says **Seed** / `tree`.

## 2. Test highlighting

Paste a small program and confirm tokens are colored:

```
task double
  take value, like number
  like number
  send back
    call add
      read value
      read value
```

Keywords (`task`, `take`, `like`, `send back`, `call`, `read`), the type name, and the number should each be colored. `#` lines render as comments. A `text <...>` literal renders as a string.

## 3. Test the language server

The server attaches to every open `.tree` file. Test each feature:

| Feature | How to test | Expected |
| --- | --- | --- |
| **Diagnostics** | Write a type error, e.g. pass a `text` where a `number` is wanted | Red squiggle with the message, live on keystroke |
| **Hover** | Hover a variable, a call, or a parameter | A popover with the inferred type (and, over a definition, its signature + `#` doc) |
| **Completion** | Type a partial name; type `/` after a record value; start a `load @cluesurf/...` path | Scope symbols, then keywords; members after `/`; module paths in a `load` |
| **Go to definition** | F12 on a call / type reference | Jumps to the `task` / `form` / `mask` |
| **Find references** | Shift+F12 on a definition | Lists every use |
| **Rename** | F2 on a symbol | Renames every occurrence |
| **Document symbols** | Cmd/Ctrl+Shift+O | Outline of every `task` / `form` / `mask` |
| **Signature help** | Inside a call's arguments | Shows the parameter list, current arg highlighted |

> Note: until the stdlib resolver is wired into the server (see the plan), a `load @cluesurf/base/...` import will show as unresolved. Test semantic features on a **self-contained** file first.

## 4. Test the server in isolation (no VS Code)

The server speaks Content-Length-framed JSON-RPC on stdio, so you can drive it from a script:

```bash
node -e '
const cp = require("child_process")
const p = cp.spawn("node", ["host/server.js"])
let out = ""; p.stdout.on("data", d => out += d)
const body = JSON.stringify({ jsonrpc:"2.0", id:1, method:"initialize", params:{ capabilities:{} } })
p.stdin.write("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body)
setTimeout(() => { console.log(out); p.kill() }, 600)
'
```

You should see an `initialize` result listing the server's capabilities.

The server logic itself is unit-tested in the monorepo: from `deck/seed/deck/seed`, run `pnpm tsx test/server/run.ts` and `pnpm tsx test/server/incremental.ts`.

## 5. Package + install locally

```bash
pnpm make             # vsce package -> seed-language-<version>.vsix
```

In any VS Code window: **Extensions: Install from VSIX…** and pick the file. Reload, open a `.tree` file.

## Feature roadmap

The full plan for robust autocomplete, import hints, and rich hover lives in `note/seed/language-server-plan.md` (monorepo `note/`). Current state and what is next are tracked there.
