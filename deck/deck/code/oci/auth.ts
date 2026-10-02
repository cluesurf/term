// Credentials for an OCI registry, and the token flow that trades them for a bearer token.
//
// A registry answers an unauthenticated request with 401 and a `WWW-Authenticate` challenge. A `Bearer` challenge
// names a `realm` to ask for a token, the `service` and the `scope` the request needs. A `Basic` challenge asks for
// the username and password on the request itself. GHCR sends a Bearer challenge even for an anonymous public pull,
// so the anonymous case is a token request with no credentials, not a request with no token.
//
// Where credentials come from, in order, and only for the host each one names:
//
//   1. TERM_OCI_TOKEN (and TERM_OCI_USERNAME), for the host in TERM_OCI_HOST, default ghcr.io
//   2. GHCR_TOKEN and GHCR_USERNAME, for ghcr.io only. These are the names `zone load cluesurf` casts
//   3. the docker config (`$DOCKER_CONFIG/config.json`, else `~/.docker/config.json`), the file `oras login` and
//      `docker login` write: `auths`, then `credHelpers`, then `credsStore`
//
// A credential is never sent to a host it was not issued for. An environment token is bound to one host on
// purpose: a lockfile or a dependency can name any registry, and a token that went to every registry a resolve
// touched would go to whoever controls one of them.

import { execFile } from 'child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

export type OciCredentials =
  | { kind: 'basic'; username: string; password: string }
  // an OAuth2 refresh token, what `docker login` stores as `identitytoken`
  | { kind: 'identity'; token: string }

export type Challenge = {
  scheme: 'bearer' | 'basic'
  realm?: string
  service?: string
  scope?: string
}

const DEFAULT_TOKEN_HOST = 'ghcr.io'

/** Credentials for one registry host, from the environment and then the docker config, or undefined. */
export async function credentialsFor(input: {
  host: string
  env?: NodeJS.ProcessEnv
  home?: string
}): Promise<OciCredentials | undefined> {
  const env = input.env ?? process.env
  const host = input.host.toLowerCase()

  const termToken = env['TERM_OCI_TOKEN']?.trim()
  const termHost = (env['TERM_OCI_HOST']?.trim() || DEFAULT_TOKEN_HOST).toLowerCase()

  if (termToken && termHost === host) {
    return {
      kind: 'basic',
      username: env['TERM_OCI_USERNAME']?.trim() || 'term',
      password: termToken,
    }
  }

  const ghcrToken = env['GHCR_TOKEN']?.trim()

  if (ghcrToken && host === 'ghcr.io') {
    return {
      kind: 'basic',
      username: env['GHCR_USERNAME']?.trim() || 'term',
      password: ghcrToken,
    }
  }

  return dockerCredentials({ host, env, home: input.home })
}

type DockerConfig = {
  auths?: Record<string, { auth?: string; username?: string; password?: string; identitytoken?: string }>
  credHelpers?: Record<string, string>
  credsStore?: string
}

// The docker config's keys are written several ways for one host: `ghcr.io`, `https://ghcr.io`,
// `https://ghcr.io/v1/`. Docker Hub is `https://index.docker.io/v1/`.
function hostKeys(host: string): string[] {
  const keys = [host, `https://${host}`, `https://${host}/`, `https://${host}/v1/`, `https://${host}/v2/`, `http://${host}`]

  if (host === 'docker.io' || host === 'registry-1.docker.io' || host === 'index.docker.io') {
    keys.push('https://index.docker.io/v1/', 'index.docker.io', 'docker.io')
  }

  return keys
}

async function dockerCredentials(input: {
  host: string
  env: NodeJS.ProcessEnv
  home?: string
}): Promise<OciCredentials | undefined> {
  const dir = input.env['DOCKER_CONFIG']?.trim() || path.join(input.home ?? os.homedir(), '.docker')
  let config: DockerConfig

  try {
    config = JSON.parse(await fs.readFile(path.join(dir, 'config.json'), 'utf8')) as DockerConfig
  } catch {
    return undefined
  }

  const keys = hostKeys(input.host)

  for (const key of keys) {
    const entry = config.auths?.[key]

    if (!entry) {
      continue
    }

    if (entry.identitytoken) {
      return { kind: 'identity', token: entry.identitytoken }
    }

    if (entry.auth) {
      const decoded = Buffer.from(entry.auth, 'base64').toString('utf8')
      const colon = decoded.indexOf(':')

      if (colon > 0) {
        return { kind: 'basic', username: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
      }
    }

    if (entry.username && entry.password) {
      return { kind: 'basic', username: entry.username, password: entry.password }
    }
  }

  const helper = keys.map(key => config.credHelpers?.[key]).find(Boolean) ?? config.credsStore

  if (!helper) {
    return undefined
  }

  return helperCredentials({ helper, host: input.host })
}

// A credential helper is the program `docker-credential-<name>`, given the server URL on stdin and answering JSON.
// Run without a shell, so neither the helper name nor the host can inject a command.
async function helperCredentials(input: { helper: string; host: string }): Promise<OciCredentials | undefined> {
  if (!/^[a-zA-Z0-9_-]+$/.test(input.helper)) {
    return undefined
  }

  const answer = await new Promise<string | undefined>(resolve => {
    const child = execFile(
      `docker-credential-${input.helper}`,
      ['get'],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error ? undefined : stdout),
    )

    child.stdin?.end(input.host)
  })

  if (!answer) {
    return undefined
  }

  try {
    const parsed = JSON.parse(answer) as { Username?: string; Secret?: string }

    if (!parsed.Secret) {
      return undefined
    }

    // a helper returns `<token>` as the username when the secret is an identity token
    if (parsed.Username === '<token>') {
      return { kind: 'identity', token: parsed.Secret }
    }

    return { kind: 'basic', username: parsed.Username ?? '', password: parsed.Secret }
  } catch {
    return undefined
  }
}

/**
 * Parse a `WWW-Authenticate` header. Only the first challenge is read, which is what every registry in practice
 * sends. Quoted values may hold commas (`scope="repository:a:pull,push"`), so the parameters are tokenized, not split.
 */
export function parseChallenge(header: string | null): Challenge | undefined {
  if (!header) {
    return undefined
  }

  const match = /^\s*(Bearer|Basic)\b\s*(.*)$/i.exec(header)

  if (!match) {
    return undefined
  }

  const scheme = match[1]!.toLowerCase() as 'bearer' | 'basic'
  const params: Record<string, string> = {}
  const pattern = /([a-zA-Z_]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))\s*,?/g

  for (const part of match[2]!.matchAll(pattern)) {
    params[part[1]!.toLowerCase()] = (part[2] ?? part[3] ?? '').replace(/\\(.)/g, '$1')
  }

  return { scheme, realm: params['realm'], service: params['service'], scope: params['scope'] }
}

export function basicHeader(credentials: { username: string; password: string }): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`, 'utf8').toString('base64')}`
}
