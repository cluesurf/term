// ---- one Messages API request, streamed and accumulated whole ----
//
// `term knit` (knit-model.ts) sends its requests through this, so the Term CLI needs no SDK. It is the raw-HTTP shape
// of the SDK's `stream(...).finalMessage()`: the request is sent with `stream: true`, every server-sent event is applied
// to one message, and the message comes back as the non-streaming API would return it: every content block whole and
// in order (thinking blocks with their signatures, so they can be passed back unchanged), `stop_reason`,
// `stop_details`, and `usage` with the cache fields. Lines are buffered across chunks. A 429, a 5xx, an overload or a
// dropped connection is retried with backoff, honoring `retry-after`; any other refusal is thrown with the API's own
// message.
//
// Copied whole from the parent repository's raw-HTTP Messages client (term/self-contained item 0019), so the Term repo
// holds the one piece of it the CLI uses. It needs nothing but the platform's fetch and TextDecoder.

export type MessageBlock = { type: string; [field: string]: unknown }

export type StreamedMessage = {
  id?: string
  model?: string
  role?: string
  content: MessageBlock[]
  stop_reason?: string | null
  stop_details?: unknown
  usage: Record<string, unknown>
  [field: string]: unknown
}

export class MessageRequestError extends Error {
  constructor(message: string, public status: number, public retryable: boolean) {
    super(message)
  }
}

// apply one server-sent event to the message being built. Exported for the tests that replay a captured stream
export function applyStreamEvent(message: StreamedMessage, event: Record<string, any>, partial: Map<number, string>): void {
  switch (event.type) {
    case 'message_start': {
      const { content: _content, ...rest } = event.message ?? {}
      Object.assign(message, rest)
      message.usage = { ...(event.message?.usage ?? {}) }
      return
    }
    case 'content_block_start': {
      const block = { ...(event.content_block ?? {}) } as MessageBlock
      // a tool's input arrives as JSON text in deltas: it starts empty, never as the `{}` placeholder
      if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        partial.set(event.index, '')
      }
      message.content[event.index] = block
      return
    }
    case 'content_block_delta': {
      const block = message.content[event.index]
      const delta = event.delta ?? {}

      if (!block) {
        return
      }

      if (delta.type === 'text_delta') {
        block.text = String(block.text ?? '') + delta.text
      } else if (delta.type === 'thinking_delta') {
        block.thinking = String(block.thinking ?? '') + delta.thinking
      } else if (delta.type === 'signature_delta') {
        block.signature = delta.signature
      } else if (delta.type === 'input_json_delta') {
        partial.set(event.index, (partial.get(event.index) ?? '') + (delta.partial_json ?? ''))
      } else if (delta.type === 'citations_delta') {
        block.citations = [...((block.citations as unknown[]) ?? []), delta.citation]
      }
      return
    }
    case 'content_block_stop': {
      const block = message.content[event.index]
      const json = partial.get(event.index)

      if (block && json !== undefined) {
        block.input = json === '' ? {} : JSON.parse(json)
        partial.delete(event.index)
      }
      return
    }
    case 'message_delta': {
      if (event.delta && 'stop_reason' in event.delta) message.stop_reason = event.delta.stop_reason
      if (event.delta && 'stop_details' in event.delta) message.stop_details = event.delta.stop_details
      if (event.delta && 'stop_sequence' in event.delta) message.stop_sequence = event.delta.stop_sequence
      // the final usage: output tokens, and any field the start did not carry
      message.usage = { ...message.usage, ...(event.usage ?? {}) }
      return
    }
    case 'error':
      throw new MessageRequestError(
        `${event.error?.type ?? 'error'}: ${event.error?.message ?? 'the stream reported an error'}`,
        0,
        event.error?.type === 'overloaded_error' || event.error?.type === 'api_error',
      )
    default:
      // ping, message_stop and anything newer
      return
  }
}

async function streamOnce(input: { apiKey: string; body: Record<string, unknown>; betas: string[]; baseUrl: string }): Promise<StreamedMessage> {
  const response = await fetch(`${input.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': input.apiKey,
      ...(input.betas.length > 0 ? { 'anthropic-beta': input.betas.join(',') } : {}),
    },
    body: JSON.stringify({ ...input.body, stream: true }),
  })

  if (!response.ok) {
    const text = await response.text()
    const retryable = response.status === 429 || response.status === 408 || response.status === 409 || response.status >= 500
    const error = new MessageRequestError(`API request failed (${response.status}): ${text.slice(0, 2000)}`, response.status, retryable)
    const after = Number(response.headers.get('retry-after'))
    ;(error as MessageRequestError & { after?: number }).after = Number.isFinite(after) ? after : undefined
    throw error
  }

  const reader = response.body?.getReader()

  if (!reader) {
    throw new MessageRequestError('The response body is not readable', 0, true)
  }

  const decoder = new TextDecoder()
  const message: StreamedMessage = { content: [], usage: {} }
  const partial = new Map<number, string>()
  let buffer = ''

  try {
    return await readStream(reader, decoder, message, partial, buffer)
  } catch (error) {
    // a stream that broke after it started was billed for what it read and wrote: say how much, so a caller that
    // counts spend counts it
    if (error && typeof error === 'object' && Object.keys(message.usage).length > 0) {
      ;(error as { usage?: Record<string, unknown> }).usage = message.usage
    }

    throw error
  }
}

async function readStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: InstanceType<typeof TextDecoder>,
  message: StreamedMessage,
  partial: Map<number, string>,
  buffer: string,
): Promise<StreamedMessage> {
  const take = (line: string): void => {
    if (!line.startsWith('data:')) {
      return
    }

    const data = line.slice(5).trim()

    if (data === '' || data === '[DONE]') {
      return
    }

    applyStreamEvent(message, JSON.parse(data), partial)
  }

  while (true) {
    const { value, done } = await reader.read()

    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    let at = buffer.indexOf('\n')

    while (at >= 0) {
      take(buffer.slice(0, at).replace(/\r$/, ''))
      buffer = buffer.slice(at + 1)
      at = buffer.indexOf('\n')
    }
  }

  take(buffer)

  // message_start carries `stop_reason: null`; only message_delta sets it
  if (message.stop_reason == null) {
    throw new MessageRequestError('The stream ended before the message did', 0, true)
  }

  message.content = message.content.filter(block => block !== undefined)

  return message
}

// one request, retried on what the API says may be retried, up to `retries` times, waiting 2, 4, 8 ... seconds (at
// most a minute) or what `retry-after` asks
export async function streamMessage(input: {
  apiKey: string
  body: Record<string, unknown>
  betas?: string[]
  retries?: number
  baseUrl?: string
  wait?: (ms: number) => Promise<void>
  // false: a stream that broke after it started (and was billed) is thrown, with its usage, rather than retried, so a
  // caller that caps spend can price the retry before it is sent
  retryBroken?: boolean
}): Promise<StreamedMessage> {
  const retries = input.retries ?? 4
  const wait = input.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  // the usage of attempts that broke partway, billed and not part of the message returned
  const broken: Record<string, unknown>[] = []

  for (let attempt = 0; ; attempt++) {
    try {
      const message = await streamOnce({ apiKey: input.apiKey, body: input.body, betas: input.betas ?? [], baseUrl: input.baseUrl ?? 'https://api.anthropic.com/v1' })
      return broken.length > 0 ? { ...message, broken_usage: broken } : message
    } catch (error) {
      const usage = (error as { usage?: Record<string, unknown> } | null)?.usage

      if (usage) {
        broken.push(usage)
      }

      const known = error instanceof MessageRequestError
      // a dropped connection reaches here as a TypeError from fetch
      const retryable = known ? error.retryable : error instanceof TypeError

      if (!retryable || attempt >= retries || (usage && input.retryBroken === false)) {
        if (error && typeof error === 'object') {
          ;(error as { brokenUsage?: Record<string, unknown>[] }).brokenUsage = broken
        }

        throw error
      }

      const after = known ? (error as MessageRequestError & { after?: number }).after : undefined
      await wait(after !== undefined ? after * 1000 : Math.min(60_000, 2000 * 2 ** attempt))
    }
  }
}
