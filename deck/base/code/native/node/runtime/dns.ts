// DNS over node's resolver (getaddrinfo, via node:dns/promises lookup). lookup respects the host's resolution order
// (/etc/hosts, then DNS), so localhost and numeric IPs resolve without a network round trip.
import { lookup as dnsLookup } from 'node:dns/promises'

const dns = {
  resolve: async (hostname: string): Promise<Array<string>> => {
    const results = await dnsLookup(hostname, { all: true })
    return results.map(result => result.address)
  },
  resolveOne: async (hostname: string): Promise<string> => {
    const result = await dnsLookup(hostname)
    return result.address
  },
}
