// DNS over DNS-over-HTTPS (the browser has no raw resolver). Queries a public DoH endpoint for A records and reads the
// addresses out of the JSON answer. Public names only: localhost and private hosts are not resolvable this way.
const dns = (() => {
  const query = async (hostname: string): Promise<Array<string>> => {
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=A`,
      { headers: { accept: 'application/dns-json' } },
    )
    const data = (await response.json()) as { Answer?: Array<{ type: number; data: string }> }
    return (data.Answer ?? []).filter(answer => answer.type === 1).map(answer => answer.data)
  }
  return {
    resolve: query,
    resolveOne: async (hostname: string): Promise<string> => (await query(hostname))[0] ?? '',
  }
})()
