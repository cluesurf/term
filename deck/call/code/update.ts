// Over-the-air page updates for a cask (native-dom-0016): the publishing half. A cask app's page (its TypeScript bundle
// and the files beside it) can change without a store release, as long as the native half it talks to is the one it
// was built against, which is exactly what the runtime version says (runtime-version.ts).
//
// The SHAPE is Expo's (docs/pages/technical-specs/expo-updates-1.mdx in expo/expo, read 2026-10-02), so the
// reasoning carries: a manifest names one launch asset and the other assets by content hash, the manifest's exact
// bytes are signed RSA PKCS#1 v1.5 with SHA-256 under a key whose public half is inside the app, and an asset is
// trusted because its hash is in the signed manifest. See note/term/app/13-expo-lessons.md, rank 1.
//
// THE TRANSPORT IS STATIC, which is where this departs from Expo. Expo's client asks a server, which picks the newest
// update by header. Here the publisher writes files and anything that serves files serves updates, R2 included, with
// no compute and nothing to keep running:
//
//   <out>/<platform>/<runtime-version>/<channel>.json       the manifest, the newest for that channel
//   <out>/<platform>/<runtime-version>/<channel>.json.sig   `sig=":<base64>:", keyid="root", alg="rsa-v1_5-sha256"`
//   <out>/assets/<sha256 hex>                               every asset, immutable, shared by every update
//
// A client fetches the manifest for its own platform, runtime version and channel, so it can never be offered an
// update built against another native half: the path itself is the compatibility check, and the signed
// `runtimeVersion` field is checked again on the device.
//
// The signing key never leaves this machine: `~/.base/@term/code/update/<identifier>.pem`, written 0600 and never
// overwritten. Its public half goes into the app at build time, in the two encodings the runtimes read.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { userHome } from '@term/call/code/home'

export type UpdateAsset = {
  // the file's path inside the page directory, which is where the client puts it
  key: string
  // base64url sha256 of the bytes, Expo's encoding
  hash: string
  contentType: string
  fileExtension: string
  // where it is fetched, relative to the update root
  url: string
}

export type UpdateManifest = {
  // a UUIDv4: when it was made says nothing, and `createdAt` is the field that does
  id: string
  createdAt: string
  runtimeVersion: string
  launchAsset: UpdateAsset
  assets: UpdateAsset[]
  metadata: { channel: string; platform: string }
  extra: Record<string, never>
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
}

// where the private key for an app lives
export function updateKeyPath(identifier: string): string {
  return userHome('update', `${identifier}.pem`)
}

// the app's update key: read when it exists, made once when it does not. Never overwritten, because every installed
// copy of the app trusts only this key, and a new one would orphan them all
export function updateKey(identifier: string, keyFile?: string): { privatePem: string; made: boolean } {
  const file = keyFile ?? updateKeyPath(identifier)

  if (existsSync(file)) {
    return { privatePem: readFileSync(file, 'utf8'), made: false }
  }

  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, privatePem, { mode: 0o600 })
  chmodSync(file, 0o600)

  return { privatePem, made: true }
}

// the public half, in the encodings the runtimes read: PKCS#1 DER for Apple's Security framework and SubjectPublicKeyInfo
// DER for the JVM's X509EncodedKeySpec and Rust
export function publicKeyFiles(privatePem: string): { pkcs1: Buffer; spki: Buffer } {
  const key = createPublicKey(createPrivateKey(privatePem))

  return {
    pkcs1: key.export({ type: 'pkcs1', format: 'der' }) as Buffer,
    spki: key.export({ type: 'spki', format: 'der' }) as Buffer,
  }
}

// write the public key into an app's resources, beside its runtime version
// `keyFile` overrides where the private key is read, which a test points at a temporary directory
export function stampUpdateKey({ identifier, into, keyFile }: { identifier: string; into: string; keyFile?: string }): void {
  const { pkcs1, spki } = publicKeyFiles(updateKey(identifier, keyFile).privatePem)
  mkdirSync(into, { recursive: true })
  writeFileSync(path.join(into, 'update-key.der'), pkcs1)
  writeFileSync(path.join(into, 'update-key.spki.der'), spki)
}

// every file under a directory, as paths relative to it, in a stable order
function filesUnder(root: string, at = ''): string[] {
  return readdirSync(path.join(root, at))
    .sort()
    .flatMap(name => {
      const relative = at ? `${at}/${name}` : name

      return statSync(path.join(root, relative)).isDirectory() ? filesUnder(root, relative) : [relative]
    })
}

function assetOf(page: string, key: string, out: string): UpdateAsset {
  const bytes = readFileSync(path.join(page, key))
  const hex = createHash('sha256').update(bytes).digest('hex')
  const stored = path.join(out, 'assets', hex)

  if (!existsSync(stored)) {
    mkdirSync(path.dirname(stored), { recursive: true })
    copyFileSync(path.join(page, key), stored)
  }

  const extension = path.extname(key)

  return {
    key,
    hash: Buffer.from(hex, 'hex').toString('base64url'),
    contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
    fileExtension: extension,
    url: `assets/${hex}`,
  }
}

// the signature header value over a manifest's exact bytes, in the structured-field form Expo's client reads
export function signManifest(bytes: Buffer, privatePem: string): string {
  const signature = sign('sha256', bytes, createPrivateKey(privatePem)).toString('base64')

  return `sig=":${signature}:", keyid="root", alg="rsa-v1_5-sha256"`
}

// publish one update: the page directory's files as content-addressed assets, and a signed manifest naming them as
// the newest for this platform, runtime version and channel. `index.html` is the launch asset
export function publishUpdate({
  page,
  out,
  identifier,
  platform,
  runtimeVersion,
  channel,
  keyFile,
}: {
  page: string
  out: string
  identifier: string
  platform: string
  runtimeVersion: string
  channel: string
  keyFile?: string
}): { manifest: UpdateManifest; file: string } {
  const files = filesUnder(page)

  if (!files.includes('index.html')) {
    throw new Error(`no index.html in ${page}: a page update launches from it`)
  }

  const assets = files.map(key => assetOf(page, key, out))
  const manifest: UpdateManifest = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    runtimeVersion,
    launchAsset: assets.find(asset => asset.key === 'index.html')!,
    assets: assets.filter(asset => asset.key !== 'index.html'),
    metadata: { channel, platform },
    extra: {},
  }
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2))
  const dir = path.join(out, platform, runtimeVersion)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${channel}.json`)
  writeFileSync(file, bytes)
  writeFileSync(`${file}.sig`, signManifest(bytes, updateKey(identifier, keyFile).privatePem))

  return { manifest, file }
}
