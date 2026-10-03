# Term for VS Code

The one VS Code extension for Term. It carries the `.tree` syntax highlighting, the Term language server (diagnostics, hover, completion, go-to-definition, references, rename, document symbols, code actions, code lens, inlay hints, semantic tokens), and a `.tree` file icon.

It replaced `deck/tree-code` (`cluesurf.tree-code`, "TreeCode") on 2026-10-02. That extension shipped the same grammars and nothing else. Its icon and its icon theme now live here under `view/`.

The extension's identifier is `cluesurf.term-code`, and its client id is `term`, so its settings sit under `term.*`. It was `cluesurf.seed-language` with settings under `seed.*` until 2026-10-02. The new name is a new Marketplace listing, so an installed `seed-language` does not update into it: uninstall that one too.

## What it contributes

| piece | file |
| --- | --- |
| the `tree` language, `.tree` files | `package.json` `contributes.languages` |
| comments, brackets, auto-closing, off-side folding, word pattern | `text/bind.json` |
| the TextMate grammar, scope `source.tree` | `text/tree.json` |
| highlighting inside fenced `tree` blocks in markdown | `text/mark.json` |
| the marketplace icon | `view/tree.png`, drawn from `view/tree.svg` by `pnpm view` |
| the `Tree` file icon theme, opt-in | `view/view.json` |
| the client | `code/extension.ts`, bundled to `host/extension.js` |
| the server | `deck/flow/code/main.ts`, bundled to `host/server.js` |

The grammar names no keywords. Every head is colored by position, so a retired word (`wave`, `bust`, `send kink`, `mark async`) is not singled out. The coloring by meaning comes from the server's semantic tokens.

## Develop

```bash
# --ignore-workspace is required: this folder sits under the term monorepo's
# pnpm-workspace.yaml, and without the flag pnpm installs that workspace instead
# of this extension's own dependencies.
pnpm install --ignore-workspace   # vscode-languageclient, esbuild, @vscode/vsce, types
pnpm build                        # bundles host/extension.js + host/server.js
```

Then open this folder in VS Code and press `F5` (Run Term Extension). A second "Extension Development Host" window opens with the extension loaded. Open any `.tree` file to see highlighting and live diagnostics.

`pnpm build` and re-launch (or run the `build` watch) after editing the client or the server.

## Package and publish

```bash
pnpm dock         # vsce login cluesurf   (one-time auth)
pnpm make         # vsce package          -> term-code-<version>.vsix
pnpm host         # vsce publish
```

Install the `.vsix` locally with VS Code's "Extensions: Install from VSIX…" command, or `code --install-extension term-code-<version>.vsix`.

Anyone with `cluesurf.tree-code` installed should uninstall it. Both register the `tree` language and the same grammar scope, so keeping both loads the grammar twice.
