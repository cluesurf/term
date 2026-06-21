# Seed for VS Code

`.tree` syntax highlighting plus the Seed language server (diagnostics, hover, go-to-definition, references, rename, document symbols).

The highlighting comes from the TextMate grammar in `text/tree.json`. The semantic features come from the Seed language server (`deck/flow/code/main.ts`), which `build.mjs` bundles into `host/server.js` and the client (`code/extension.ts`) launches over stdio.

## Develop

```bash
# --ignore-workspace is required: this folder sits under the seed monorepo's
# pnpm-workspace.yaml, and without the flag pnpm installs that workspace instead
# of this extension's own dependencies.
pnpm install --ignore-workspace   # vscode-languageclient, esbuild, @vscode/vsce, types
pnpm build                        # bundles host/extension.js + host/server.js
```

Then open this folder in VS Code and press `F5` (Run Seed Extension). A second "Extension Development Host" window opens with the extension loaded. Open any `.tree` file to see highlighting and live diagnostics.

`pnpm build` and re-launch (or run the `build` watch) after editing the client or the server.

## Package and publish

```bash
pnpm dock         # vsce login cluesurf   (one-time auth)
pnpm make         # vsce package          -> seed-language-<version>.vsix
pnpm host         # vsce publish
```

Install the `.vsix` locally with VS Code's "Extensions: Install from VSIX…" command.
