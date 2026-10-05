// The package index ping (code/oci/index-ping.ts): anonymous by default, credited to a term.surf account when a token
// is given, and the token never sent anywhere it should not go. A fake fetch stands in for the index, so nothing
// leaves the machine.

import { describe, expect, it } from 'vitest'

import { generateKeypair, verifyId } from '../code/object/sign'
import { pingIndex, publishStatement } from '../code/oci/index-ping'

const REPOSITORY = { host: 'ghcr.io', namespace: 'cluesurf/term', name: 'cluesurf/term/bind' } as never
const DIGEST = `sha256:${'a'.repeat(64)}`
const REFERENCE = `oci://ghcr.io/cluesurf/term/bind@${DIGEST}`
const NOW = new Date('2026-10-02T12:00:00.000Z')

type Seen = { url: string; headers: Record<string, string>; body: Record<string, string> }

// `ghcr` is what GHCR answers an anonymous pull-token request, per repository: 200 for a public package (the default
// for any repository not named), 401 for a private one
function fakeIndex(answer: { status: number; body?: unknown; ghcr?: Record<string, number> }): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = []
  const fake = (async (url: string, init: RequestInit) => {
    if (url.startsWith('https://ghcr.io/token')) {
      const scope = new URL(url).searchParams.get('scope') ?? ''
      const name = scope.replace(/^repository:/, '').replace(/:pull$/, '')

      return new Response('{}', { status: answer.ghcr?.[name] ?? 200 })
    }

    seen.push({
      url,
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)) as Record<string, string>,
    })

    return new Response(JSON.stringify(answer.body ?? {}), { status: answer.status })
  }) as unknown as typeof fetch

  return { fetch: fake, seen }
}

describe('pingIndex', () => {
  it('sends the reference alone, with no authorization, when there is no token', async () => {
    const index = fakeIndex({ status: 200, body: { form: 'selection', base: { outcome: 'published' } } })
    const ping = await pingIndex({ repository: REPOSITORY, digest: DIGEST, env: {}, fetch: index.fetch })

    expect(ping).toEqual({ form: 'sent', outcome: 'published' })
    expect(index.seen[0]!.url).toBe('https://tool.term.surf/packages/publish!')
    expect(index.seen[0]!.headers['authorization']).toBeUndefined()
    expect(index.seen[0]!.body).toEqual({ reference: REFERENCE })
  })

  it('with a token, sends it as a bearer and a claim signed by the version key', async () => {
    const keypair = generateKeypair()
    const index = fakeIndex({ status: 200, body: { form: 'selection', base: { outcome: 'published', publisher: { id: 'kvmt-nhbs' } } } })
    const ping = await pingIndex({
      repository: REPOSITORY,
      digest: DIGEST,
      token: 'ws-abc',
      keypair,
      env: {},
      fetch: index.fetch,
      now: () => NOW,
    })

    expect(ping).toEqual({ form: 'sent', outcome: 'published', publisher: 'kvmt-nhbs' })

    const { headers, body } = index.seen[0]!

    expect(headers['authorization']).toBe('Bearer ws-abc')
    expect(body['reference']).toBe(REFERENCE)
    expect(body['time']).toBe(NOW.toISOString())
    expect(body['key']).toBe(keypair.publicKey)
    expect(publishStatement({ reference: REFERENCE, time: NOW.toISOString() })).toBe(
      `term.publish.v1 ${REFERENCE} ${NOW.toISOString()}`,
    )
    expect(
      verifyId({ id: publishStatement({ reference: REFERENCE, time: body['time']! }), sig: body['sig']!, publicKey: keypair.publicKey }),
    ).toBe(true)
  })

  it('names the token page when the index refuses the token', async () => {
    const index = fakeIndex({ status: 401 })
    const ping = await pingIndex({ repository: REPOSITORY, digest: DIGEST, token: 'ws-dead', keypair: generateKeypair(), env: {}, fetch: index.fetch })

    expect(ping.form).toBe('failed')
    expect((ping as { reason: string }).reason).toContain('term.surf/settings/tokens')
  })

  it('says why the index refused, in the index own words', async () => {
    const index = fakeIndex({
      status: 400,
      body: {
        form: 'defect',
        note: 'The named thing failed validation',
        link: { thing: 'package', field: 'reference', value: '401', expected: 'an anonymous pull token, which a public package grants' },
      },
    })
    const ping = await pingIndex({ repository: REPOSITORY, digest: DIGEST, env: {}, fetch: index.fetch })

    expect(ping).toEqual({
      form: 'failed',
      reason: '400 from https://tool.term.surf: the reference needs an anonymous pull token, which a public package grants',
    })

    const bare = fakeIndex({ status: 502 })

    expect(await pingIndex({ repository: REPOSITORY, digest: DIGEST, env: {}, fetch: bare.fetch })).toEqual({
      form: 'failed',
      reason: '502 from https://tool.term.surf',
    })
  })

  it('names the settings page, and never asks the index, while the GHCR package is private', async () => {
    const index = fakeIndex({ status: 200, ghcr: { 'cluesurf/term/bind': 401 } })
    const ping = await pingIndex({ repository: REPOSITORY, digest: DIGEST, env: {}, fetch: index.fetch })

    expect(ping.form).toBe('failed')
    expect((ping as { reason: string }).reason).toContain(
      'https://github.com/orgs/cluesurf/packages/container/term%2Fbind/settings',
    )
    expect(index.seen).toHaveLength(0)
  })

  it('names the key set too, the second package the index reads, when only it is private', async () => {
    const index = fakeIndex({ status: 200, ghcr: { 'cluesurf/term/name': 401 } })
    const ping = await pingIndex({ repository: REPOSITORY, digest: DIGEST, env: {}, fetch: index.fetch })
    const reason = (ping as { reason: string }).reason

    expect(ping.form).toBe('failed')
    expect(reason).toContain('https://github.com/orgs/cluesurf/packages/container/term%2Fname/settings')
    expect(reason).not.toContain('term%2Fbind')
    expect(index.seen).toHaveLength(0)
  })

  it('never sends a token over plain http to anything but loopback', async () => {
    const index = fakeIndex({ status: 200 })
    const ping = await pingIndex({
      repository: REPOSITORY,
      digest: DIGEST,
      token: 'ws-abc',
      keypair: generateKeypair(),
      env: { TERM_INDEX_URL: 'http://index.example' },
      fetch: index.fetch,
    })

    expect(ping.form).toBe('failed')
    expect(index.seen).toHaveLength(0)

    const local = fakeIndex({ status: 200 })
    await pingIndex({
      repository: REPOSITORY,
      digest: DIGEST,
      token: 'ws-abc',
      keypair: generateKeypair(),
      env: { TERM_INDEX_URL: 'http://127.0.0.1:4000' },
      fetch: local.fetch,
    })

    expect(local.seen[0]!.headers['authorization']).toBe('Bearer ws-abc')
  })

  it('refuses to send a token without the key that proves the claim', async () => {
    const index = fakeIndex({ status: 200 })
    const ping = await pingIndex({ repository: REPOSITORY, digest: DIGEST, token: 'ws-abc', env: {}, fetch: index.fetch })

    expect(ping.form).toBe('failed')
    expect(index.seen).toHaveLength(0)
  })

  it('skips a registry the index does not read, token or not', async () => {
    const index = fakeIndex({ status: 200 })
    const ping = await pingIndex({
      repository: { host: 'localhost:5000', namespace: 'x', name: 'x/y' } as never,
      digest: DIGEST,
      token: 'ws-abc',
      keypair: generateKeypair(),
      env: {},
      fetch: index.fetch,
    })

    expect(ping.form).toBe('skipped')
    expect(index.seen).toHaveLength(0)
  })
})
