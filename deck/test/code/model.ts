/**
 * A REAL model integration for the AI proposer: builds the prompt,
 * calls a chat-completions API, and parses the reply into an `Expr`
 * the synthesis loop proves. This is the concrete `ask` the async
 * proposer (ai-proposer.ts) was designed for - the integration is
 * complete; the only thing external is the API key (read from the
 * environment, never hard-coded) and the network.
 *
 * The parser is fully testable here (no network). Point the config at
 * any OpenAI/Anthropic-compatible endpoint and set the key, and the
 * model proposes candidates the prover certifies - a hallucination is
 * simply rejected and CEGIS recovers.
 */

import type { Expr } from './synthesize'
import { modelProposer, type AsyncProposer } from './ai-proposer'
import { parseReply } from '@term/test/code/model-reply'

// `TERM_<name>`, else the older `SEED_<name>`: the same rule as the CLI's `env` (call/code/home.ts), written here so
// @term/test, a library the CLI imports, does not import the CLI back
function env(name: string): string | undefined {
  return process.env[`TERM_${name}`] ?? process.env[`SEED_${name}`]
}

// --- parse a model's textual reply into an Expr ---

/**
 * Parse `max(a, b)`, `(0 - a)`, `min(x, 1)`, etc. into an Expr. The parser is Term since 2026-10-05
 * (deck/test/code/model-reply.tree, paired against this one's original over 50,000 replies by tmp/pair-model-reply.ts);
 * this face answers `null` where the port answers none.
 */
export function parseExpr(text: string, names: string[]): Expr | null {
  const read = parseReply(text, names) as { value?: Expr }

  return read && 'value' in read && read.value ? read.value : null
}

// --- the real model-backed proposer ---

export type ModelConfig = {
  /** Chat-completions endpoint, e.g. https://api.openai.com/v1/chat/completions */
  endpoint: string
  /** API key. Read from the environment, never hard-coded. */
  apiKey: string
  /** Model id. */
  model: string
  /** Parameter names, in order, for parsing the reply. */
  names: string[]
}

/** Read a model config from environment variables, or null if unset. */
export function modelConfigFromEnv(names: string[]): ModelConfig | null {
  const endpoint = env('MODEL_ENDPOINT')
  const apiKey = env('MODEL_KEY')
  const model = env('MODEL') ?? 'gpt-4o-mini'
  if (!endpoint || !apiKey) return null
  return { endpoint, apiKey, model, names }
}

/**
 * The production `ask`: prompt the model and parse its reply into an
 * Expr. The synthesis loop proves whatever it returns, so a wrong reply
 * is rejected and CEGIS recovers.
 */
export async function askModel(config: ModelConfig, prompt: string): Promise<Expr | null> {
  const system =
    `You synthesize a function body as a single expression over the integer inputs ` +
    `${config.names.join(', ')}. Use only: the input names, integer constants, + , - , ` +
    `min(x, y), max(x, y), and parentheses. Reply with ONLY the expression, nothing else.`

  const response = await fetch(config.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt },
      ],
      temperature: 0,
    }),
  })

  if (!response.ok) return null

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const reply = data.choices?.[0]?.message?.content
  if (!reply) return null

  return parseExpr(reply, config.names)
}

/** A model-backed proposer, ready to drop into the repair loop. */
export function realModelProposer(config: ModelConfig): AsyncProposer {
  return modelProposer(prompt => askModel(config, prompt))
}
