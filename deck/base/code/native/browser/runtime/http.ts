// HTTP shim over the host fetch. Returns a plain { status, body } that matches the http-response record shape.
const http = {
  request: async (
    method: string,
    url: string,
    body: string,
  ): Promise<{ status: number; body: string }> => {
    const response = await fetch(
      url,
      body.length > 0 ? { method, body } : { method },
    )
    return { status: response.status, body: await response.text() }
  },
}
