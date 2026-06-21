# Seed Proof - VSCode extension

The proof IDE for Seed: the InfoView goal panel (live proof state) and the hammer, over the Seed language server. This is the **client** for the LSP proof protocol whose server side is built and tested in `../proof-lsp.ts` (`proof/state`, `proof/hammer`).

## Files

- `package.json` - the extension manifest (the `seed.showProof` command, `.tree` language, keybinding).
- `extension.ts` - the entry point (`activate` / `deactivate`).
- `client.ts` - starts the Seed flow language server and connects VSCode to it.
- `infoview.ts` - the InfoView webview: requests `proof/state` on cursor move, renders the goal panel, and posts `proof/hammer` from the per-goal buttons.
- `tsconfig.json` - the build config.

## Run it (in a real editor)

This is a standard VSCode extension. It cannot run in a headless sandbox - it needs the editor runtime - but it is complete and openable:

```sh
cd deck/seed/deck/seed/deck/test/code/vscode
pnpm install          # or npm install
pnpm compile          # tsc -> out/
code .                # open in VSCode, press F5 to launch the Extension Host
```

Point it at the Seed flow server with `SEED_FLOW_SERVER=<path-to-flow/main.js>` (or bundle the server under `server/flow/main.js`). Open a `.tree` file and run **"Seed: Show Proof"** - the InfoView shows the goals; the hammer button on an open goal calls the server (the hammer built in `../hammer.ts`) and the panel re-renders PROVED / REFUTED / OPEN.

## What is wired

The whole request cycle is built and tested server-side (`demo-proof-lsp.ts`, 5/5). This client is the rendering + interaction layer. Together they are the complete proof IDE; the only thing the sandbox cannot do is run the editor itself.
