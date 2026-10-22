// `term knit`'s one door to the Claude API. It is reached only when the loop runs (knit.ts imports it then), and the
// key is read from the environment at that moment, so `term` starts, and every other verb runs, with no key set
// (note/project/term/assurance/prove-loop).
//
// The request goes through the repository's raw-HTTP Messages client, deck/make/code/code/api-client.ts
// (`streamMessage`), so the Term CLI takes no SDK dependency (lead decision, 2026-10-21). Only the fields read below are
// typed; they are the Messages API's own names.

import type { Usage } from '@term/call/code/knit-plan'

// one content block as the API returns it and takes it back: passed back UNCHANGED, thinking blocks included
export type Block = { type: string; [field: string]: unknown }

export type Message = { role: 'user' | 'assistant'; content: string | Block[] }

export type Tool = {
  name: string
  description: string
  input_schema: { type: 'object'; properties: Record<string, unknown>; required: string[]; additionalProperties: false }
}

export type Turn = {
  content: Block[]
  usage: Usage
  stopReason: string
  // the model that served the turn, and whether a fallback model ran in it (priced then at the dearest rates)
  model: string
  fellBack: boolean
  refusal?: string
  // attempts that broke partway and were retried: billed, and not in `usage`
  broken?: Usage[]
}

// what the loop asks of a model. The loop is written against this, so test/call/knit.ts drives it with a scripted
// speaker and no network
export type Speaker = {
  model: string
  ask(input: { system: string; tools: Tool[]; messages: Message[] }): Promise<Turn>
}

export class KnitSetup extends Error {
  next: string

  constructor(message: string, next: string) {
    super(message)
    this.next = next
  }
}

// a request that failed for good, with the usage of the attempts that broke partway, so the cap still counts them
export class KnitRequest extends Error {
  broken: Usage[]

  constructor(message: string, broken: Usage[]) {
    super(message)
    this.broken = broken
  }
}

// the models the server-side refusal fallback takes (claude-api skill: on by default for these)
const FALLBACK = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1'])

// the request body for one turn: adaptive thinking (the only mode Opus 5.5 takes) at the effort asked, the fixed system
// prompt and the growing conversation cached for an hour (a turn plus a round of `term hold` can pass five minutes; a
// longer TTL may not follow a shorter one, so both are an hour), strict tools, and the refusal fallback
export function bodyOf(input: { model: string; effort: string; maxTokens: number; system: string; tools: Tool[]; messages: Message[] }): { body: Record<string, unknown>; betas: string[] } {
  const fallback = FALLBACK.has(input.model)

  return {
    body: {
      model: input.model,
      max_tokens: input.maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort: input.effort },
      system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral', ttl: '1h' } }],
      cache_control: { type: 'ephemeral', ttl: '1h' },
      tools: input.tools.map(tool => ({ ...tool, strict: true })),
      messages: input.messages,
      ...(fallback ? { fallbacks: 'default' } : {}),
    },
    betas: fallback ? ['server-side-fallback-2026-07-01'] : [],
  }
}

export async function claudeSpeaker(input: { model: string; effort: string; maxTokens: number }): Promise<Speaker> {
  const key = process.env.ANTHROPIC_API_KEY

  if (!key) {
    throw new KnitSetup(
      'ANTHROPIC_API_KEY is not set, so the loop cannot reach the model',
      'run it under the zone that holds the key: /Users/lancepollard/base/crew/cluesurf/deck/zone/bin/zone load deck/make -- term knit ...',
    )
  }

  const { streamMessage } = await import('../../../../../../make/code/code/api-client')

  return {
    model: input.model,
    async ask({ system, tools, messages }) {
      const { body, betas } = bodyOf({ ...input, system, tools, messages })
      let message: Awaited<ReturnType<typeof streamMessage>>

      try {
        message = await streamMessage({ apiKey: key, body, betas, retries: 4, retryBroken: false })
      } catch (error) {
        const broken = ((error as { brokenUsage?: Usage[] } | null)?.brokenUsage ?? []) as Usage[]
        throw new KnitRequest(error instanceof Error ? error.message : String(error), broken)
      }

      const usage = message.usage as Usage & { iterations?: { type?: string }[] }
      const stopDetails = message.stop_details as { category?: string | null; explanation?: string } | null | undefined
      const broken = (message.broken_usage as Usage[] | undefined) ?? []

      return {
        content: message.content as Block[],
        usage,
        stopReason: String(message.stop_reason ?? ''),
        model: String(message.model ?? input.model),
        fellBack: (usage.iterations ?? []).some(one => one.type === 'fallback_message'),
        ...(message.stop_reason === 'refusal' ? { refusal: `${stopDetails?.category ?? 'no category'}: ${stopDetails?.explanation ?? ''}` } : {}),
        ...(broken.length > 0 ? { broken } : {}),
      }
    },
  }
}
