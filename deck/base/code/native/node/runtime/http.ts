// HTTP shim over the host fetch. Returns a plain { status, body } that matches the http-response record shape.
//
// `header` is a Map of name to value and may be empty. fetch takes headers as
// a plain object, so the Map is spread into one; an empty Map yields no
// headers, which is what a request that wants none should send.
const http = {
  request: async (
    method: string,
    url: string,
    body: string,
    header?: Map<string, string>,
  ): Promise<{ status: number; body: string }> => {
    const headers: Record<string, string> = {}

    if (header) {
      for (const [name, value] of header) {
        headers[name] = value
      }
    }

    const init: RequestInit = { method }

    if (body.length > 0) {
      init.body = body
    }

    if (Object.keys(headers).length > 0) {
      init.headers = headers
    }

    const response = await fetch(url, init)

    return { status: response.status, body: await response.text() }
  },
}
