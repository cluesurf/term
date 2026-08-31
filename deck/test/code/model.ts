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
import { env } from '@term/call/code/home'

// --- parse a model's textual reply into an Expr ---

/** Parse `max(a, b)`, `(0 - a)`, `min(x, 1)`, etc. into an Expr. */
export function parseExpr(text: string, names: string[]): Expr | null {
  const tokens = tokenize(text)
  if (!tokens.length) return null
  let pos = 0

  // skip leading prose: advance to the first token that can start an
  // expression (a known name, min/max, an open paren, a number, or a
  // leading minus). Robust to replies like "The answer is max(a, b)."
  const startsExpr = (t: string | undefined): boolean =>
    t === '(' || t === 'min' || t === 'max' || names.includes(t ?? '') || /^-?\d+$/.test(t ?? '')
  while (pos < tokens.length && !startsExpr(tokens[pos])) pos++

  const peek = () => tokens[pos]
  const next = () => tokens[pos++]

  function parsePrimary(): Expr | null {
    const t = next()
    if (t === undefined) return null
    if (t === '(') {
      const inner = parseAdditive()
      if (peek() === ')') next()
      return inner
    }
    if (t === 'min' || t === 'max') {
      if (next() !== '(') return null
      const a = parseAdditive()
      if (peek() === ',') next()
      const b = parseAdditive()
      if (peek() === ')') next()
      if (!a || !b) return null
      return { form: t, left: a, right: b }
    }
    const idx = names.indexOf(t)
    if (idx >= 0) return { form: 'var', index: idx }
    if (/^-?\d+$/.test(t)) return { form: 'const', value: Number(t) }
    return null
  }

  function parseAdditive(): Expr | null {
    let left = parsePrimary()
    if (!left) return null
    while (peek() === '+' || peek() === '-') {
      const op = next()
      const right = parsePrimary()
      if (!right) return null
      left = { form: op === '+' ? 'add' : 'sub', left, right }
    }
    return left
  }

  const result = parseAdditive()
  return result
}

function tokenize(text: string): string[] {
  // keep only the first line/expression-ish chunk, strip code fences
  const cleaned = text.replace(/```[a-z]*|```/g, '').trim()
  const out: string[] = []
  const re = /\s*([A-Za-z_][A-Za-z0-9_]*|-?\d+|[()+\-,])/g
  let m: RegExpExecArray | null
  while ((m = re.exec(cleaned)) !== null) out.push(m[1])
  return out
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
