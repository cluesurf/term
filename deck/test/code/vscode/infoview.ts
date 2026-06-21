/**
 * The VSCode InfoView client: the webview that renders the proof state
 * the server (`proof-lsp.ts`) computes. This is the last piece of the
 * proof IDE - complete extension code. It cannot run in this sandbox
 * (it needs the VSCode runtime, exactly as a website needs a browser),
 * but the logic is real: on cursor move it requests `proof/state` over
 * the LSP and re-renders the goal panel; the "hammer" button sends
 * `proof/hammer`.
 *
 * Drop this into a VSCode extension. The `vscode` and `vscode-
 * languageclient` imports resolve inside the extension host. The
 * server side it talks to is already built and tested.
 */

// These imports resolve in the VSCode extension host, not here.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-nocheck
import * as vscode from 'vscode'
import { LanguageClient } from 'vscode-languageclient/node'
import { startSeedLanguageClient } from './client'

/** The shape the server returns for `proof/state` (mirrors proof-lsp.ts). */
type GoalView = {
  name: string
  status: 'open' | 'proved' | 'refuted'
  detail?: string
  counterexample?: number[]
}
type ProofStateView = {
  uri: string
  goals: GoalView[]
  solved: number
  total: number
  done: boolean
}

/** The InfoView panel: a webview beside the editor showing the goals. */
export class InfoView {
  private panel: vscode.WebviewPanel | undefined

  constructor(
    private readonly client: LanguageClient,
    private readonly context: vscode.ExtensionContext,
  ) {}

  /** Open (or reveal) the panel and start tracking the cursor. */
  show(): void {
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel(
        'seedInfoView',
        'Seed Proof',
        vscode.ViewColumn.Beside,
        { enableScripts: true },
      )
      this.panel.onDidDispose(() => (this.panel = undefined))
      // the hammer button posts a message back; forward it to the server
      this.panel.webview.onDidReceiveMessage(async message => {
        if (message.command === 'hammer') {
          await this.client.sendRequest('proof/hammer', {
            uri: message.uri,
            goal: message.goal,
          })
          await this.refresh()
        }
      })
    }
    void this.refresh()
  }

  /** Re-request the proof state at the active position and re-render. */
  async refresh(): Promise<void> {
    const editor = vscode.window.activeTextEditor
    if (!editor || !this.panel) return

    const state = await this.client.sendRequest<ProofStateView>('proof/state', {
      uri: editor.document.uri.toString(),
      position: editor.selection.active,
    })

    this.panel.webview.html = this.render(state)
  }

  /** The webview HTML: the goal panel, with a hammer button per goal. */
  private render(state: ProofStateView): string {
    const rows = state.goals
      .map(goal => {
        const mark =
          goal.status === 'proved' ? '&#10003;' : goal.status === 'refuted' ? '&#10007;' : '&#9675;'
        const cls = goal.status
        const detail =
          goal.status === 'refuted' && goal.counterexample
            ? `fails at ${JSON.stringify(goal.counterexample)}`
            : goal.detail ?? ''
        const button =
          goal.status === 'open'
            ? `<button onclick="hammer('${goal.name}')">hammer</button>`
            : ''
        return `<li class="${cls}"><span class="mark">${mark}</span> <b>${goal.name}</b> <span class="detail">${detail}</span> ${button}</li>`
      })
      .join('\n')

    return `<!doctype html>
<html>
<head><style>
  body { font-family: var(--vscode-editor-font-family); padding: 8px; }
  h3 { font-weight: 600; }
  ul { list-style: none; padding: 0; }
  li { padding: 4px 0; }
  .proved .mark { color: var(--vscode-testing-iconPassed, green); }
  .refuted .mark { color: var(--vscode-testing-iconFailed, red); }
  .open .mark { color: var(--vscode-descriptionForeground, gray); }
  .detail { color: var(--vscode-descriptionForeground); }
  button { margin-left: 8px; }
</style></head>
<body>
  <h3>${state.uri} (${state.solved}/${state.total}${state.done ? ', done' : ''})</h3>
  <ul>${rows}</ul>
  <script>
    const vscodeApi = acquireVsCodeApi()
    function hammer(goal) {
      vscodeApi.postMessage({ command: 'hammer', goal, uri: ${JSON.stringify(state.uri)} })
    }
  </script>
</body>
</html>`
  }
}

/** Extension entry: start the LSP client, register the InfoView, and
 * refresh it as the cursor moves. */
export function activate(context: vscode.ExtensionContext): void {
  // the LanguageClient setup (server module, transport) is the standard
  // LSP boilerplate; assume `client` is the started Seed language client.
  const client = startSeedLanguageClient(context)
  const infoView = new InfoView(client, context)

  context.subscriptions.push(
    vscode.commands.registerCommand('seed.showProof', () => infoView.show()),
    vscode.window.onDidChangeTextEditorSelection(() => void infoView.refresh()),
    vscode.workspace.onDidSaveTextDocument(() => void infoView.refresh()),
  )
}

