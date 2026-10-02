// The one HTTP primitive over the host fetch. Answers a flat list of text: `ok`, the status, the body, then each
// response header as a lower-case name and its value; or `timeout` / `outage` and the host's message. The public
// http module (base/code/network/http.tree) builds the response from it, so every backend answers alike.
const http = {
  request: async (
    method: string,
    url: string,
    body: string,
    header: Map<string, string>,
    timeout: number,
  ): Promise<Array<string>> => {
    const headers: Record<string, string> = {}

    for (const [name, value] of header) {
      headers[name] = value
    }

    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(Math.max(0, timeout)) }

    if (body.length > 0) {
      init.body = body
    }

    try {
      const response = await fetch(url, init)
      const text = await response.text()
      const out = ['ok', String(response.status), text]

      response.headers.forEach((value, name) => {
        out.push(name.toLowerCase(), value)
      })

      return out
    } catch (error) {
      const name = (error as { name?: string }).name

      return [name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'outage', String(error)]
    }
  },
}
