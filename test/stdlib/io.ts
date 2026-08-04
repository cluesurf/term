// Native-delegated IO test: the public `file` API forwards (internally, hidden) to the per-env native implementation,
// selected by the build target. Here the node target resolves `native/file` -> `native/node/file`, which docks to
// node:fs. We compile a program that only ever names `file`, transpile + import it, and run real file operations on a
// temp file. Proves the Tier-3 architecture end to end. Run: npx tsx test/stdlib/io.ts

import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import {
  withNativeEnv,
  nativePrelude,
} from '@term/make/code/compile/native'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin } from '@term/make/code/compile/kotlin'
import type { Source } from '@term/make/code/compile/load'
import { render } from '@term/make/code/parser/diagnostic'

const here = dirname(fileURLToPath(import.meta.url))
const baseTree = join(here, '..', '..', 'deck', 'base')

const stdlib = (path: string): Source | undefined => {
  const prefix = '@cluesurf/seed/'

  if (!path.startsWith(prefix)) {return undefined}

  const file = join(baseTree, `${path.slice(prefix.length)}.tree`)

  return existsSync(file)
    ? { file, text: readFileSync(file, 'utf8') }
    : undefined
}

// the node target: abstract native imports resolve to native/node/*
const resolve = withNativeEnv('node', stdlib)

let pass = 0
let fail = 0

function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

// read a native runtime shim's raw source from base.tree (the path carries its real extension, no `.tree`)
const readRuntime = (path: string): string | undefined => {
  const prefix = '@cluesurf/seed/'

  if (!path.startsWith(prefix)) {return undefined}

  const file = join(baseTree, path.slice(prefix.length))

  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

async function loadProgram(
  source: string,
): Promise<Record<string, (...a: unknown[]) => unknown>> {
  const result = compile(
    { file: 'main.tree', text: source },
    { resolve },
  )

  if (!result.ok) {
    for (const d of result.diagnostics)
      {console.log(render(d, source.split('\n'), false))}

    throw new Error('compile failed')
  }

  // prepend any node runtime shim the program docks (e.g. the regex shim wrapping new RegExp), same as the build does
  const prelude = nativePrelude(result.program, 'node', readRuntime)
  const js = transformSync(`${prelude}\n${result.typescript}`, {
    loader: 'ts',
    format: 'esm',
  }).code

  const dir = mkdtempSync(join(tmpdir(), 'seed-io-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, js)

  return (await import(pathToFileURL(file).href)) as Record<
    string,
    (...a: unknown[]) => unknown
  >
}

// the program only ever names `file` — the node platform is hidden behind the API
const PROGRAM = `load @cluesurf/seed/code/file
  find file

task round-trip
  mark async
  take p, like text
  like text
  call write
    read p
    text <hello world>
    wait true
  send back
    call read
      read p
      wait true

task exists
  mark async
  take p, like text
  like boolean
  send back
    call test
      read p
      wait true
`

// clock: forwards to node:perf_hooks (now) + node:timers/promises (sleep), hidden behind the API
const CLOCK = `load @cluesurf/seed/code/clock
  find clock

task get-now
  like number
  send back
    call now

task sleep-then-now
  mark async
  take ms, like number
  like number
  call sleep
    read ms
    wait true
  send back
    call now
`

// process + console: forward to host globals via the `<global:X>` dock (no import), hidden behind the API
const PROCESS = `load @cluesurf/seed/code/process
  find process

task plat
  like text
  send back
    call platform
`

const CONSOLE = `load @cluesurf/seed/code/console
  find console

task say
  take m, like text
  call log
    read m
`

const ENVIRONMENT = `load @cluesurf/seed/code/environment
  find environment

task cwd
  like text
  send back
    call directory

task var-of
  take name, like text
  like text
  send back
    call variable
      read name
`

// file metadata: size and kind, over the host stat. Total (missing path reads 0 and false).
const FILE_META = `load @cluesurf/seed/code/file/metadata
  find size
  find is-directory
  find is-file

task size-of
  take path, like text
  like number
  send back
    call size
      read path

task dir-check
  take path, like text
  like boolean
  send back
    call is-directory
      read path

task file-check
  take path, like text
  like boolean
  send back
    call is-file
      read path
`

// directory operations: make, exists, remove. make and remove are recursive and best effort.
const FILE_DIR = `load @cluesurf/seed/code/file/directory
  find make
  find remove
  find exists
  find list
  find walk

task make-dir
  take path, like text
  like boolean
  call make
    read path
  send back
    call exists
      read path

task remove-dir
  take path, like text
  like boolean
  call remove
    read path
  send back
    call exists
      read path

task list-dir
  take path, like text
  like list
    like text
  send back
    call list
      read path

task walk-dir
  take path, like text
  like list
    like text
  send back
    call walk
      read path
`

// path: filesystem path string manipulation over the host path library. Scalar text/boolean, no list involved.
const PATH = `load @cluesurf/seed/code/path
  find join
  find directory
  find file-name
  find file-extension
  find is-absolute

task join-of
  take base, like text
  take name, like text
  like text
  send back
    call join
      read base
      read name

task dir-of
  take target, like text
  like text
  send back
    call directory
      read target

task name-of
  take target, like text
  like text
  send back
    call file-name
      read target

task ext-of
  take target, like text
  like text
  send back
    call file-extension
      read target

task absolute-of
  take target, like text
  like boolean
  send back
    call is-absolute
      read target
`

const TIME = `load @cluesurf/seed/code/time
  find time

task epoch
  like number
  send back
    call now
`

// log: leveled logger forwarding to the host console (info/warn/error/debug), hidden behind the API
const LOG = `load @cluesurf/seed/code/log
  find log

task note-info
  take m, like text
  call info
    read m

task note-warn
  take m, like text
  call warn
    read m
`

// math: the clean interface delegating to the host Math (absolute/minimum/power/...), plus pure clamp/gcd/factorial
const MATH = `load @cluesurf/seed/code/math
  find absolute
  find power
  find square-root
  find clamp
  find greatest-common-divisor
  find factorial

task abs-neg
  like number
  send back
    call absolute
      call subtract
        code 0
        code 7

task two-to-ten
  like number
  send back
    call power
      code 2
      code 10

task root-of
  like number
  send back
    call square-root
      code 144

task clamp-high
  like number
  send back
    call clamp
      code 15
      code 0
      code 10

task gcd-of
  like number
  send back
    call greatest-common-divisor
      code 12
      code 18

task fact-of
  like number
  send back
    call factorial
      code 5
`

// color HSL: convert RGB to HSL through the math interface (max/min), integer-scaled
const HSL = `load @cluesurf/seed/code/color/hsl
  find from-rgb
  find to-rgb
  find hsl-color

load @cluesurf/seed/code/color/rgb
  find rgb-color

task blue-hue
  like number
  save c
    call from-rgb
      make rgb-color
        bind red, code 0
        bind green, code 0
        bind blue, code 255
  send back
    read c/hue

task green-hue
  like number
  save c
    call from-rgb
      make rgb-color
        bind red, code 0
        bind green, code 255
        bind blue, code 0
  send back
    read c/hue

task white-saturation
  like number
  save c
    call from-rgb
      make rgb-color
        bind red, code 255
        bind green, code 255
        bind blue, code 255
  send back
    read c/saturation

task back-to-red
  like number
  save c
    call to-rgb
      make hsl-color
        bind hue, code 0
        bind saturation, code 100
        bind lightness, code 50
  send back
    read c/red

task back-to-green-channel
  like number
  save c
    call to-rgb
      make hsl-color
        bind hue, code 120
        bind saturation, code 100
        bind lightness, code 50
  send back
    read c/green

task white-back-blue
  like number
  save c
    call to-rgb
      make hsl-color
        bind hue, code 0
        bind saturation, code 0
        bind lightness, code 100
  send back
    read c/blue

task red-lightness
  like number
  save c
    call from-rgb
      make rgb-color
        bind red, code 255
        bind green, code 0
        bind blue, code 0
  send back
    read c/lightness
`

// base64 + hex text encodings, delegating to the host Buffer (round-trip + a known vector)
const ENCODE = `load @cluesurf/seed/code/text/base64
  find encode
  find decode

task b64
  take m, like text
  like text
  send back
    call encode
      read m

task un-b64
  take m, like text
  like text
  send back
    call decode
      read m
`

const HEXCODE = `load @cluesurf/seed/code/text/hex
  find encode
  find decode

task hexed
  take m, like text
  like text
  send back
    call encode
      read m

task un-hexed
  take m, like text
  like text
  send back
    call decode
      read m
`

// sha256 / md5 digests, delegating to the host node:crypto (async interface, uniform across platforms)
const DIGEST = `load @cluesurf/seed/code/cryptography/digest
  find sha256
  find md5
  find digest
  find digest-algorithm

load @cluesurf/seed/code/bytes
  find from-text
  find to-hex

task sha
  mark async
  take m, like text
  like text
  send back
    call to-hex
      call sha256
        call from-text
          read m
        wait true

task md
  mark async
  take m, like text
  like text
  send back
    call to-hex
      call md5
        call from-text
          read m
        wait true

# the parameterized verb: digest with the algorithm selected at the call site
task sha-via-verb
  mark async
  take m, like text
  like text
  send back
    call to-hex
      call digest
        call from-text
          read m
        make sha-256
        wait true
`

// rgb -> hex color string, the byte formatting delegated to the host Buffer
const HEXCOLOR = `load @cluesurf/seed/code/color/hex
  find from-rgb

load @cluesurf/seed/code/color/rgb
  find rgb-color

task hex-of
  like text
  send back
    call from-rgb
      make rgb-color
        bind red, code 255
        bind green, code 0
        bind blue, code 128
`

// hmac-sha256, delegating to the host node:crypto (async interface)
const HMAC = `load @cluesurf/seed/code/cryptography/hmac
  find sha256

load @cluesurf/seed/code/bytes
  find from-text
  find to-hex

task mac
  mark async
  take k, like text
  take d, like text
  like text
  send back
    call to-hex
      call sha256
        call from-text
          read k
        call from-text
          read d
        wait true
`

// rgb -> hsv, pure-logic on the math interface
const HSV = `load @cluesurf/seed/code/color/hsv
  find from-rgb
  find hsv-color

load @cluesurf/seed/code/color/rgb
  find rgb-color

task red-value
  like number
  save c
    call from-rgb
      make rgb-color
        bind red, code 255
        bind green, code 0
        bind blue, code 0
  send back
    read c/value

task red-saturation
  like number
  save c
    call from-rgb
      make rgb-color
        bind red, code 255
        bind green, code 0
        bind blue, code 0
  send back
    read c/saturation

task gray-saturation
  like number
  save c
    call from-rgb
      make rgb-color
        bind red, code 128
        bind green, code 128
        bind blue, code 128
  send back
    read c/saturation
`

// string utilities, native-delegated (node uses host String methods directly)
const STRING = `load @cluesurf/seed/code/text/string
  find to-upper
  find trim
  find repeat
  find starts-with
  find replace

task shout
  take m, like text
  like text
  send back
    call to-upper
      read m

task trimmed
  take m, like text
  like text
  send back
    call trim
      read m

task tripled
  take m, like text
  like text
  send back
    call repeat
      read m
      code 3

task has-prefix
  take m, like text
  take p, like text
  like boolean
  send back
    call starts-with
      read m
      read p

task swapped
  take m, like text
  like text
  send back
    call replace
      read m
      text <a>
      text <b>
`

// uuid v4, delegating to the host crypto.randomUUID
const UUID = `load @cluesurf/seed/code/uuid
  find version4

task make-id
  like text
  send back
    call version4
`

// random, delegating to the host Math (integer(n,n) is deterministic, so it is the testable case)
const RANDOM = `load @cluesurf/seed/code/random
  find number
  find integer

task unit
  like number
  send back
    call number

task fixed
  like number
  send back
    call integer
      code 5
      code 5

task ranged
  like number
  send back
    call integer
      code 1
      code 6
`

// regex, delegating to the host engine via the regex shim (wraps new RegExp on node)
const REGEX = `load @cluesurf/seed/code/regex
  find matches
  find replace
  find find

task is-digits
  take m, like text
  like boolean
  send back
    call matches
      text <^[0-9]+$>
      read m

task strip-vowels
  take m, like text
  like text
  send back
    call replace
      text <[aeiou]>
      read m
      text <*>

task first-number
  take m, like text
  like text
  send back
    call find
      text <[0-9]+>
      read m
`

// json: parse the host JSON to the opaque dynamic value, navigate it, read leaves; round-trip via stringify
const JSON_PROG = `load @cluesurf/seed/code/json
  find parse
  find stringify
  find get-field
  find get-item
  find as-number
  find as-text
  find as-boolean

task read-count
  take text, like text
  like decimal
  send back
    call as-number
      call get-field
        call parse
          read text
        text <count>

task read-name
  take text, like text
  like text
  send back
    call as-text
      call get-field
        call parse
          read text
        text <name>

task item-number
  take text, like text
  like decimal
  send back
    call as-number
      call get-item
        call parse
          read text
        code 1

task bool-of
  take text, like text
  like boolean
  send back
    call as-boolean
      call parse
        read text

task round-trip
  take text, like text
  like text
  send back
    call stringify
      call parse
        read text

task literal-object
  like decimal
  send back
    call as-number
      call get-field
        call parse
          text <{"count":7,"name":"seed"}>
        text <count>
`

// typed JSON decode: a `form` schema's fields read straight out of the parsed JSON via the field accessors
const JSON_DECODE = `load @cluesurf/seed/code/json
  find parse
  find field-text
  find field-number
  find field-boolean

form person
  link name, like text
  link age, like decimal
  link active, like boolean

task decode
  take text, like text
  like person
  save j
    call parse
      read text
  send back
    make person
      bind name
        call field-text
          read j
          text <name>
      bind age
        call field-number
          read j
          text <age>
      bind active
        call field-boolean
          read j
          text <active>

task name-of
  take text, like text
  like text
  save p
    call decode
      read text
  send back
    read p/name

task age-of
  take text, like text
  like decimal
  save p
    call decode
      read text
  send back
    read p/age
`

// typed JSON encode: a `form`'s fields are assembled into the opaque dynamic value (make-object + set-field +
// from-*), then stringified through the host JSON. Symmetric with the field-accessor decode above, and cross-platform
// (every backend builds the native JSON value, no derive macros). Verified by parsing the output back out.
const JSON_ENCODE = `load @cluesurf/seed/code/json
  find parse
  find stringify
  find field-text
  find field-number
  find field-boolean
  find make-object
  find set-field
  find from-text
  find from-number
  find from-boolean

form person
  link name, like text
  link age, like decimal
  link active, like boolean

task encode
  take p, like person
  like text
  send back
    call stringify
      call set-field
        call set-field
          call set-field
            call make-object
            text <name>
            call from-text
              read p/name
          text <age>
          call from-number
            read p/age
        text <active>
        call from-boolean
          read p/active

task sample
  like text
  save p
    make person
      bind name
        text <seed>
      bind age
        3.0
      bind active
        true
  send back
    call encode
      read p

task encoded-name
  like text
  save j
    call parse
      call sample
  send back
    call field-text
      read j
      text <name>

task encoded-age
  like decimal
  save j
    call parse
      call sample
  send back
    call field-number
      read j
      text <age>

task encoded-active
  like boolean
  save j
    call parse
      call sample
  send back
    call field-boolean
      read j
      text <active>
`

// secure random: cryptographically secure raw bytes (the currency). A request for 16 bytes rendered to hex is a
// 32-char string. The generator is OS-backed (node randomBytes); two draws differ. Synchronous on every host.
const SECURE_RANDOM = `load @cluesurf/seed/code/cryptography/random
  find bytes

load @cluesurf/seed/code/bytes
  find to-hex

task draw
  take size, like number
  like text
  send back
    call to-hex
      call bytes
        read size
`

// the bytes currency type: text/hex/base64 codecs at the edges, length and concat over the native Uint8Array. The
// data stays a raw buffer the whole way through, no hex tax between operations.
const BYTES = `load @cluesurf/seed/code/bytes
  find from-text
  find to-text
  find to-hex
  find from-hex
  find to-base64
  find from-base64
  find length
  find count
  find encode
  find decode
  find concat

# the parameterized codec verb: encode bytes in a base chosen at the call site (16 = hex, 64 = base64)
task encode-in
  take input, like text
  take base, like number
  like text
  send back
    call encode
      call from-text
        read input
      read base

# round-trip through the decode verb at a runtime base
task decode-round-trip
  take input, like text
  take base, like number
  like text
  send back
    call to-text
      call decode
        call encode
          call from-text
            read input
          read base
        read base

# count is the canonical name for the byte length
task count-of
  take input, like text
  like number
  send back
    call count
      call from-text
        read input

task hex-of
  take input, like text
  like text
  send back
    call to-hex
      call from-text
        read input

task round-trip-text
  take input, like text
  like text
  send back
    call to-text
      call from-text
        read input

task round-trip-base64
  take input, like text
  like text
  send back
    call to-text
      call from-base64
        call to-base64
          call from-text
            read input

task byte-length
  take input, like text
  like number
  send back
    call length
      call from-text
        read input

task concat-hex
  like text
  send back
    call to-hex
      call concat
        call from-text
          text <ab>
        call from-text
          text <cd>

task hex-round-trip
  take input, like text
  like text
  send back
    call to-text
      call from-hex
        call to-hex
          call from-text
            read input
`

// zero-copy file IO: write a byte buffer and read it back as bytes. node fs returns a Buffer (a Uint8Array) with no
// utf8 round-trip. The text codec is applied only at the very edge to check the result.
const BYTES_FILE = `load @cluesurf/seed/code/file
  find write-bytes
  find read-bytes

load @cluesurf/seed/code/bytes
  find from-text
  find to-text
  find length

task round-trip-file
  mark async
  take path, like text
  take input, like text
  like text
  call write-bytes
    read path
    call from-text
      read input
    wait true
  send back
    call to-text
      call read-bytes
        read path
        wait true

task byte-size-on-disk
  mark async
  take path, like text
  take input, like text
  like number
  call write-bytes
    read path
    call from-text
      read input
    wait true
  send back
    call length
      call read-bytes
        read path
        wait true
`

// AES-256-GCM authenticated encryption: encrypt then decrypt round-trips back to the plaintext (via SubtleCrypto on
// node). Key and nonce are hex; the ciphertext (with the appended tag) is hex.
const CIPHER = `load @cluesurf/seed/code/cryptography/cipher
  find encrypt
  find decrypt

load @cluesurf/seed/code/bytes
  find from-text
  find to-text
  find from-hex
  find to-hex

task seal
  mark async
  take key, like text
  take nonce, like text
  take plain, like text
  like text
  send back
    call to-hex
      call encrypt
        call from-hex
          read key
        call from-hex
          read nonce
        call from-text
          read plain
        wait true

task open
  mark async
  take key, like text
  take nonce, like text
  take cipher, like text
  like text
  send back
    call to-text
      call decrypt
        call from-hex
          read key
        call from-hex
          read nonce
        call from-hex
          read cipher
        wait true
`

// Ed25519 signatures: generate a key pair, sign a message with the private key, verify with the public key (via
// SubtleCrypto on node). Keys and signatures are hex. A tampered message must fail verification.
const SIGNATURE = `load @cluesurf/seed/code/cryptography/signature
  find make-key-pair
  find sign
  find verify

load @cluesurf/seed/code/bytes
  find from-text

task round-trip
  mark async
  take message, like text
  like boolean
  save pair
    call make-key-pair
      wait true
  save proof
    call sign
      read pair/private-key
      call from-text
        read message
      wait true
  send back
    call verify
      read pair/public-key
      call from-text
        read message
      read proof
      wait true

task tampered
  mark async
  take message, like text
  take other, like text
  like boolean
  save pair
    call make-key-pair
      wait true
  save proof
    call sign
      read pair/private-key
      call from-text
        read message
      wait true
  send back
    call verify
      read pair/public-key
      call from-text
        read other
      read proof
      wait true
`

// calendar: UTC formatting / components / construction / arithmetic over an epoch-millis timestamp (via the host
// Date). Formatting is ISO 8601 with millisecond precision; arithmetic on fixed units is pure, months delegate.
const CALENDAR = `load @cluesurf/seed/code/calendar
  find make-utc
  find format
  find parse
  find year
  find month
  find add-days
  find add-months
  find to-parts

task stamp
  like number
  send back
    call make-utc
      code 2026
      code 6
      code 19
      code 12
      code 34
      code 56

task formatted
  take m, like number
  like text
  send back
    call format
      read m

task parsed
  take text, like text
  like number
  send back
    call parse
      read text

task year-of
  take m, like number
  like integer
  send back
    call year
      read m

task next-day
  take m, like number
  like text
  send back
    call format
      call add-days
        read m
        code 1

task next-month
  take m, like number
  like integer
  send back
    call month
      call add-months
        read m
        code 1

task parts-weekday
  take m, like number
  like integer
  save parts
    call to-parts
      read m
  send back
    read parts/weekday
`

// X25519 ECDH key agreement: two parties generate key pairs, exchange public keys, and derive the same shared secret
// (via SubtleCrypto on node). The agreement property -- secret(a.private, b.public) == secret(b.private, a.public) --
// is what makes a shared key possible.
const KEY_AGREEMENT = `load @cluesurf/seed/code/cryptography/key-agreement
  find make-key-pair
  find shared-secret

load @cluesurf/seed/code/bytes
  find to-hex

task agree
  mark async
  like boolean
  save a
    call make-key-pair
      wait true
  save b
    call make-key-pair
      wait true
  save ab
    call shared-secret
      read a/private-key
      read b/public-key
      wait true
  save ba
    call shared-secret
      read b/private-key
      read a/public-key
      wait true
  send back
    call is-equal
      call to-hex
        read ab
      call to-hex
        read ba
`

// network/dns: resolve a host to its addresses via the platform resolver. A numeric IP resolves to itself with no
// network round trip, so the assertion is deterministic and offline.
const DNS = `load @cluesurf/seed/code/network/dns
  find resolve
  find resolve-one

task one
  mark async
  take host, like text
  like text
  send back
    call resolve-one
      read host
      wait true

task all
  mark async
  take host, like text
  like list
    like text
  send back
    call resolve
      read host
      wait true
`

// network/http: GET through the host fetch (a data: URL needs no server), reading status + body off the response
const HTTP = `load @cluesurf/seed/code/network/http
  find get

task fetch-body
  mark async
  take url, like text
  like text
  save response
    call get
      read url
      wait true
  send back
    read response/body

task fetch-status
  mark async
  take url, like text
  like number
  save response
    call get
      read url
      wait true
  send back
    read response/status
`

// float: real floating-point math (host float library) + fractional division that does NOT truncate
const FLOAT = `load @cluesurf/seed/code/float
  find square-root
  find round-down
  find power

task root-of
  like decimal
  send back
    call square-root
      9.0

task floor-of
  like decimal
  send back
    call round-down
      3.7

task pow-of
  like decimal
  send back
    call power
      2.0
      3.0

task div-of
  like decimal
  send back
    call divide
      7.0
      2.0
`

async function main(): Promise<void> {
  const fl = await loadProgram(FLOAT)
  expect('float: square-root(9.0) is 3', fl.rootOf(), 3)
  expect('float: round-down(3.7) is 3', fl.floorOf(), 3)
  expect('float: power(2.0, 3.0) is 8', fl.powOf(), 8)
  expect(
    'float: 7.0 / 2.0 is 3.5 (not truncated like integer division)',
    fl.divOf(),
    3.5,
  )

  const ht = await loadProgram(HTTP)
  expect(
    'network/http: get reads the body (data URL via host fetch)',
    await ht.fetchBody('data:text/plain,hello%20seed'),
    'hello seed',
  )
  expect(
    'network/http: get reads the status',
    await ht.fetchStatus('data:text/plain,x'),
    200,
  )

  const dns = await loadProgram(DNS)
  expect(
    'network/dns: resolve-one of a numeric IP returns it (offline)',
    await dns.one('127.0.0.1'),
    '127.0.0.1',
  )
  expect(
    'network/dns: resolve of localhost includes the loopback address',
    ((await dns.all('localhost')) as string[]).includes(
      '127.0.0.1',
    ),
    true,
  )

  const js = await loadProgram(JSON_PROG)
  expect(
    'json: parse + get-field + as-number reads a number field',
    js.readCount('{"count":42,"name":"seed"}'),
    42,
  )
  expect(
    'json: get-field + as-text reads a string field',
    js.readName('{"count":42,"name":"seed"}'),
    'seed',
  )
  expect(
    'json: get-item + as-number indexes an array',
    js.itemNumber('[10,20,30]'),
    20,
  )
  expect('json: as-boolean reads a bool', js.boolOf('true'), true)
  expect(
    'json: stringify(parse) round-trips through the host JSON',
    js.roundTrip('{"a":1,"b":[2,3]}'),
    '{"a":1,"b":[2,3]}',
  )
  expect(
    'json: a JSON object literal in seed source parses (brace fix)',
    js.literalObject(),
    7,
  )

  const jd = await loadProgram(JSON_DECODE)
  expect(
    'json: decode a typed `form` from JSON (text field)',
    jd.nameOf('{"name":"seed","age":3,"active":true}'),
    'seed',
  )
  expect(
    'json: decode a typed `form` from JSON (number field)',
    jd.ageOf('{"name":"seed","age":3,"active":true}'),
    3,
  )

  const je = await loadProgram(JSON_ENCODE)
  expect(
    'json: encode a typed `form` to JSON, text field survives the round-trip',
    je.encodedName(),
    'seed',
  )
  expect(
    'json: encode a typed `form` to JSON, number field survives the round-trip',
    je.encodedAge(),
    3,
  )
  expect(
    'json: encode a typed `form` to JSON, boolean field survives the round-trip',
    je.encodedActive(),
    true,
  )

  const by = await loadProgram(BYTES)
  expect(
    'bytes: from-text -> to-hex (utf8 then hex)',
    by.hexOf('hi'),
    '6869',
  )
  expect(
    'bytes: text round-trips through utf8 (multibyte)',
    by.roundTripText('café'),
    'café',
  )
  expect(
    'bytes: base64 round-trips back to the text',
    by.roundTripBase64('café'),
    'café',
  )
  expect(
    'bytes: utf8 length counts bytes not chars (é is 2)',
    by.byteLength('café'),
    5,
  )
  expect(
    'bytes: concat two buffers then hex',
    by.concatHex(),
    '61626364',
  )
  expect(
    'bytes: hex round-trips back to the text',
    by.hexRoundTrip('hello'),
    'hello',
  )
  // the minimal-surface verbs: encode/decode with a base parameter, and count as the canonical length
  expect(
    'bytes: encode verb at base 16 equals hex',
    (by.encodeIn as (s: string, b: number) => string)('hi', 16),
    '6869',
  )
  expect(
    'bytes: encode verb at base 64 equals base64',
    (by.encodeIn as (s: string, b: number) => string)('hi', 64),
    Buffer.from('hi').toString('base64'),
  )
  expect(
    'bytes: decode verb round-trips at base 64',
    (by.decodeRoundTrip as (s: string, b: number) => string)(
      'café',
      64,
    ),
    'café',
  )
  expect(
    'bytes: count verb counts bytes (é is 2)',
    (by.countOf as (s: string) => number)('café'),
    5,
  )

  const sr = await loadProgram(SECURE_RANDOM)
  const draw16 = sr.draw(16) as string
  expect(
    'crypto/random: 16 bytes is a 32-char hex string',
    draw16.length === 32 && /^[0-9a-f]+$/.test(draw16),
    true,
  )
  expect(
    'crypto/random: two draws differ (not a constant)',
    sr.draw(16) !== sr.draw(16),
    true,
  )

  const cp = await loadProgram(CIPHER)
  const cipherKey =
    '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff'

  const cipherNonce = '000102030405060708090a0b'
  const sealed = (await cp.seal(
    cipherKey,
    cipherNonce,
    'attack at dawn',
  )) as string

  expect(
    'crypto/cipher: ciphertext is non-empty hex',
    /^[0-9a-f]+$/.test(sealed) && sealed.length > 0,
    true,
  )
  expect(
    'crypto/cipher: decrypt(encrypt(x)) round-trips the plaintext (AES-256-GCM)',
    await cp.open(cipherKey, cipherNonce, sealed),
    'attack at dawn',
  )

  const sigMod = await loadProgram(SIGNATURE)
  expect(
    'crypto/signature: verify(sign(message)) is true (Ed25519)',
    await sigMod.roundTrip('ship sails at noon'),
    true,
  )
  expect(
    'crypto/signature: a tampered message fails verification',
    await sigMod.tampered('ship sails at noon', 'ship sails at dusk'),
    false,
  )

  const cal = await loadProgram(CALENDAR)
  const stamp = cal.stamp() as number
  expect(
    'calendar: make-utc + format gives the ISO 8601 UTC string',
    cal.formatted(stamp),
    '2026-06-19T12:34:56.000Z',
  )
  expect(
    'calendar: parse is the inverse of format',
    cal.parsed('2026-06-19T12:34:56.000Z'),
    stamp,
  )
  expect('calendar: year component (UTC)', cal.yearOf(stamp), 2026)
  expect(
    'calendar: add-days crosses into the next day',
    cal.nextDay(stamp),
    '2026-06-20T12:34:56.000Z',
  )
  expect(
    'calendar: add-months is calendar-aware (June -> July)',
    cal.nextMonth(stamp),
    7,
  )
  expect(
    'calendar: to-parts weekday matches the host Date (0=Sunday)',
    cal.partsWeekday(stamp),
    new Date(stamp).getUTCDay(),
  )

  const ka = await loadProgram(KEY_AGREEMENT)
  expect(
    'crypto/key-agreement: both parties derive the same X25519 shared secret',
    await ka.agree(),
    true,
  )

  const rx = await loadProgram(REGEX)
  expect(
    'regex/matches accepts a matching string',
    rx.isDigits('12345'),
    true,
  )
  expect(
    'regex/matches rejects a non-matching string',
    rx.isDigits('12a45'),
    false,
  )
  expect(
    'regex/replace replaces all matches',
    rx.stripVowels('seedlang'),
    's**dl*ng',
  )
  expect(
    'regex/find returns the first match',
    rx.firstNumber('abc42def7'),
    '42',
  )

  const ud = await loadProgram(UUID)
  const id = ud.makeId() as string
  expect(
    'uuid/version4 returns a 36-char id',
    typeof id === 'string' && id.length === 36,
    true,
  )
  expect(
    'uuid/version4 is dashed (8-4-4-4-12)',
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      id,
    ),
    true,
  )

  const rn = await loadProgram(RANDOM)
  const u = rn.unit() as number
  expect('random/number is in [0,1)', u >= 0 && u < 1, true)
  expect('random/integer(5,5) is deterministically 5', rn.fixed(), 5)

  const r = rn.ranged() as number
  expect('random/integer(1,6) is in range', r >= 1 && r <= 6, true)

  const sg = await loadProgram(STRING)
  expect(
    'text/string: to-upper uppercases',
    sg.shout('hello'),
    'HELLO',
  )
  expect(
    'text/string: trim strips whitespace',
    sg.trimmed('  hi  '),
    'hi',
  )
  expect(
    'text/string: repeat repeats n times',
    sg.tripled('ab'),
    'ababab',
  )
  expect(
    'text/string: starts-with detects the prefix',
    sg.hasPrefix('seedlang', 'seed'),
    true,
  )
  expect(
    'text/string: replace replaces all occurrences',
    sg.swapped('a-a-a'),
    'b-b-b',
  )

  const hm = await loadProgram(HMAC)
  expect(
    'cryptography/hmac: sha256 matches the RFC test vector',
    await hm.mac('key', 'The quick brown fox jumps over the lazy dog'),
    'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
  )

  const hv = await loadProgram(HSV)
  expect('color/hsv: pure red has value 100', hv.redValue(), 100)
  expect(
    'color/hsv: pure red has saturation 100',
    hv.redSaturation(),
    100,
  )
  expect('color/hsv: gray has saturation 0', hv.graySaturation(), 0)

  const hc = await loadProgram(HEXCOLOR)
  expect(
    'color/hex: rgb(255,0,128) formats as #ff0080',
    hc.hexOf(),
    '#ff0080',
  )

  const b6 = await loadProgram(ENCODE)
  expect(
    'text/base64: encodes a known vector',
    b6.b64('hello'),
    'aGVsbG8=',
  )
  expect(
    'text/base64: round-trips through the host Buffer',
    b6.unB64(b6.b64('seed encodings')),
    'seed encodings',
  )

  const hx = await loadProgram(HEXCODE)
  expect('text/hex: encodes a known vector', hx.hexed('hi'), '6869')
  expect(
    'text/hex: round-trips through the host Buffer',
    hx.unHexed(hx.hexed('cluesurf')),
    'cluesurf',
  )

  const dg = await loadProgram(DIGEST)
  expect(
    'cryptography/digest: sha256 matches the known vector for "abc"',
    await dg.sha('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
  expect(
    'cryptography/digest: md5 matches the known vector for "abc"',
    await dg.md('abc'),
    '900150983cd24fb0d6963f7d28e17f72',
  )
  expect(
    'cryptography/digest: the digest verb with algorithm sha-256 matches the named form',
    await (dg.shaViaVerb as (m: string) => Promise<string>)('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )

  const ma = await loadProgram(MATH)
  expect('math: absolute delegates to host Math.abs', ma.absNeg(), 7)
  expect('math: power delegates to host Math.pow', ma.twoToTen(), 1024)
  expect(
    'math: square-root delegates to host Math.sqrt',
    ma.rootOf(),
    12,
  )
  expect('math: clamp composes from the interface', ma.clampHigh(), 10)
  expect('math: greatest-common-divisor (pure)', ma.gcdOf(), 6)
  expect('math: factorial (pure)', ma.factOf(), 120)

  // the delegating interface is thrown away in the compiled output: the wrapper chain collapses to the native call
  const mathOut = compile(
    { file: 'main.tree', text: MATH },
    { resolve },
  )

  const mathTs = mathOut.ok ? mathOut.typescript : ''
  expect(
    'math: the absolute wrapper is inlined away (no function absolute)',
    mathTs.includes('function absolute'),
    false,
  )
  expect(
    'math: the power wrapper is inlined away (no function power)',
    mathTs.includes('function power'),
    false,
  )
  expect(
    'math: power delegates inline to the host Math (math.pow)',
    mathTs.includes('math.pow'),
    true,
  )
  expect(
    'math: absolute delegates inline to the host Math (math.abs)',
    mathTs.includes('math.abs'),
    true,
  )
  expect(
    'math: a non-forwarder (factorial) is kept',
    mathTs.includes('function factorial'),
    true,
  )

  const hl = await loadProgram(HSL)
  expect('color/hsl: pure blue has hue 240', hl.blueHue(), 240)
  expect('color/hsl: pure green has hue 120', hl.greenHue(), 120)
  expect('color/hsl: white has saturation 0', hl.whiteSaturation(), 0)
  expect('color/hsl: pure red has lightness 50', hl.redLightness(), 50)
  expect(
    'color/hsl: hsl(0,100,50) converts back to red (255)',
    hl.backToRed(),
    255,
  )
  expect(
    'color/hsl: hsl(120,100,50) converts back to green channel (255)',
    hl.backToGreenChannel(),
    255,
  )
  expect(
    'color/hsl: hsl(0,0,100) converts back to white (blue 255)',
    hl.whiteBackBlue(),
    255,
  )

  const en = await loadProgram(ENVIRONMENT)
  const cwd = en.cwd() as string
  expect(
    'environment: directory reads the working dir (non-empty)',
    typeof cwd === 'string' && cwd.length > 0,
    true,
  )
  process.env.SEED_TEST_VAR = 'present'
  expect(
    'environment: variable reads an env var',
    en.varOf('SEED_TEST_VAR'),
    'present',
  )
  expect(
    'environment: variable returns empty for an unset var',
    en.varOf('SEED_DEFINITELY_UNSET_VAR'),
    '',
  )

  const metaDir = mkdtempSync(join(tmpdir(), 'seed-meta-'))
  const metaFile = join(metaDir, 'note.txt')
  writeFileSync(metaFile, 'twelve bytes')

  const fm = await loadProgram(FILE_META)
  expect(
    'file/metadata: size reads the byte length',
    fm.sizeOf(metaFile),
    12,
  )
  expect(
    'file/metadata: is-file is true for a file',
    fm.fileCheck(metaFile),
    true,
  )
  expect(
    'file/metadata: is-directory is false for a file',
    fm.dirCheck(metaFile),
    false,
  )
  expect(
    'file/metadata: is-directory is true for a directory',
    fm.dirCheck(metaDir),
    true,
  )
  expect(
    'file/metadata: size of a missing path is 0',
    fm.sizeOf(join(metaDir, 'nope')),
    0,
  )

  const fd = await loadProgram(FILE_DIR)
  const newDir = join(metaDir, 'made', 'deep')
  expect(
    'file/directory: make creates the directory (recursive)',
    fd.makeDir(newDir),
    true,
  )
  expect(
    'file/directory: remove deletes the directory',
    fd.removeDir(newDir),
    false,
  )

  const entries = fd.listDir(metaDir) as string[]
  expect(
    'file/directory: list returns the directory entries',
    Array.isArray(entries) && entries.includes('note.txt'),
    true,
  )
  expect(
    'file/directory: list of a missing path is empty',
    (fd.listDir(join(metaDir, 'nope')) as string[]).length,
    0,
  )
  // nested tree for walk: metaDir/branch/leaf.txt
  fd.makeDir(join(metaDir, 'branch'))
  writeFileSync(join(metaDir, 'branch', 'leaf.txt'), 'x')

  const walked = fd.walkDir(metaDir) as string[]
  expect(
    'file/directory: walk lists nested entries recursively',
    Array.isArray(walked) &&
      walked.some(p => p.endsWith('branch')) &&
      walked.some(p => p.endsWith('leaf.txt')),
    true,
  )
  expect(
    'file/directory: walk of a missing path is empty',
    (fd.walkDir(join(metaDir, 'nope')) as string[]).length,
    0,
  )

  const pa = await loadProgram(PATH)
  expect(
    'path: join combines a base and a name',
    pa.joinOf('/a/b', 'c.txt'),
    '/a/b/c.txt',
  )
  expect(
    'path: directory is everything before the last segment',
    pa.dirOf('/a/b/c.txt'),
    '/a/b',
  )
  expect(
    'path: file-name is the last segment',
    pa.nameOf('/a/b/c.txt'),
    'c.txt',
  )
  expect(
    'path: file-extension carries its dot',
    pa.extOf('/a/b/c.txt'),
    '.txt',
  )
  expect(
    'path: file-extension is empty when there is none',
    pa.extOf('/a/b/c'),
    '',
  )
  expect(
    'path: is-absolute is true for a rooted path',
    pa.absoluteOf('/a/b'),
    true,
  )
  expect(
    'path: is-absolute is false for a relative path',
    pa.absoluteOf('a/b'),
    false,
  )

  const ti = await loadProgram(TIME)
  const epoch = ti.epoch() as number
  expect(
    'time: now returns a positive epoch',
    typeof epoch === 'number' && epoch > 0,
    true,
  )

  const pr = await loadProgram(PROCESS)
  const plat = pr.plat() as string
  expect(
    'process: platform reads the host global (non-empty string)',
    typeof plat === 'string' && plat.length > 0,
    true,
  )

  const co = await loadProgram(CONSOLE)
  expect(
    'console: log forwards to the host console and returns unit',
    co.say('') === undefined,
    true,
  )

  const lg = await loadProgram(LOG)
  expect(
    'log: info forwards to the host console and returns unit',
    lg.noteInfo('') === undefined,
    true,
  )
  expect(
    'log: warn forwards to the host console and returns unit',
    lg.noteWarn('') === undefined,
    true,
  )

  const c = await loadProgram(CLOCK)
  const t0 = c.getNow() as number
  expect(
    'clock: now returns a positive number (node perf_hooks)',
    typeof t0 === 'number' && t0 > 0,
    true,
  )

  const t1 = (await c.sleepThenNow(5)) as number
  expect('clock: sleep then now advances time', t1 >= t0, true)

  const m = await loadProgram(PROGRAM)
  const dir = mkdtempSync(join(tmpdir(), 'seed-iofile-'))
  const path = join(dir, 'note.txt')
  const missing = join(dir, 'nope.txt')

  const content = await m.roundTrip(path)
  expect(
    'file: write then read round-trips through node fs',
    content,
    'hello world',
  )
  expect(
    'file: the file really exists on disk after write',
    existsSync(path),
    true,
  )
  expect(
    'file: test reports an existing file',
    await m.exists(path),
    true,
  )
  expect(
    'file: test reports a missing file',
    await m.exists(missing),
    false,
  )

  const bf = await loadProgram(BYTES_FILE)
  const bytesPath = join(dir, 'raw.bin')
  expect(
    'file: write-bytes then read-bytes round-trips as a native buffer (no utf8 hop)',
    await bf.roundTripFile(bytesPath, 'raw bytes ☃'),
    'raw bytes ☃',
  )
  expect(
    'file: the bytes on disk count utf8 octets (snowman is 3 bytes)',
    await bf.byteSizeOnDisk(bytesPath, 'ab☃'),
    5,
  )

  // cross-target: the SAME public `file` module compiles for every platform, each forwarding to its own native impl,
  // emitting that platform's file API. The program only ever names `file`.
  const fileSrc = stdlib('@cluesurf/seed/code/file')!.text
  const compileFor = (env: 'node' | 'rust' | 'swift' | 'kotlin') =>
    compile(
      { file: 'file.tree', text: fileSrc },
      { resolve: withNativeEnv(env, stdlib) },
    )

  const nodeR = compileFor('node')
  expect(
    'file compiles for the node target (node:fs)',
    nodeR.ok && nodeR.typescript.includes('fs.readFile'),
    true,
  )

  const rustR = compileFor('rust')
  expect(
    'file compiles for the rust target (io runtime)',
    rustR.ok && emitRust(rustR.program).includes('io::file_read'),
    true,
  )

  const swiftR = compileFor('swift')
  expect(
    'file compiles for the swift target (io runtime)',
    swiftR.ok && emitSwift(swiftR.program).includes('io.fileRead'),
    true,
  )

  const kotlinR = compileFor('kotlin')
  expect(
    'file compiles for the kotlin target (io runtime)',
    kotlinR.ok && emitKotlin(kotlinR.program).includes('io.fileRead'),
    true,
  )

  // browser: the same file module compiles to TypeScript that drives the OPFS shim (io.fileRead), and the OPFS
  // runtime (navigator.storage.getDirectory) is pulled into the prelude. Browser has no host here, so this is a
  // compile + shim-wiring check, not a run.
  const browserR = compile(
    { file: 'file.tree', text: fileSrc },
    { resolve: withNativeEnv('browser', stdlib) },
  )

  expect(
    'file compiles for the browser target (OPFS io shim)',
    browserR.ok && browserR.typescript.includes('io.fileRead'),
    true,
  )
  expect(
    'file pulls the OPFS runtime into the browser prelude',
    browserR.ok &&
      nativePrelude(browserR.program, 'browser', readRuntime).includes(
        'navigator.storage.getDirectory',
      ),
    true,
  )

  // the public digest interface compiles for every target. digest is a declarative `bind`: it inlines each platform's
  // built-in crypto call directly at the use site (no hand-written shim), so the emit shows the native expression.
  const digestSrc = stdlib(
    '@cluesurf/seed/code/cryptography/digest',
  )!.text

  const digestFor = (env: 'node' | 'rust' | 'swift' | 'kotlin') =>
    compile(
      { file: 'd.tree', text: digestSrc },
      { resolve: withNativeEnv(env, stdlib) },
    )

  const dNode = digestFor('node')
  expect(
    'digest compiles for node (node:crypto createHash, inlined)',
    dNode.ok && dNode.typescript.includes('createHash'),
    true,
  )

  const dRust = digestFor('rust')
  expect(
    'digest compiles for rust, sha2 crate pulled into the prelude',
    dRust.ok &&
      nativePrelude(dRust.program, 'rust', readRuntime).includes(
        'Sha256::digest',
      ),
    true,
  )

  const dSwift = digestFor('swift')
  expect(
    'digest compiles for swift, CryptoKit pulled into the prelude',
    dSwift.ok &&
      nativePrelude(dSwift.program, 'swift', readRuntime).includes(
        'SHA256.hash',
      ),
    true,
  )

  const dKotlin = digestFor('kotlin')
  expect(
    'digest compiles for kotlin, java.security pulled into the prelude',
    dKotlin.ok &&
      nativePrelude(dKotlin.program, 'kotlin', readRuntime).includes(
        'MessageDigest.getInstance',
      ),
    true,
  )

  const dBrowser = digestFor('browser')
  expect(
    'digest compiles for browser, Web Crypto pulled into the prelude',
    dBrowser.ok &&
      nativePrelude(dBrowser.program, 'browser', readRuntime).includes(
        'subtle.digest',
      ),
    true,
  )

  // the public string interface compiles for every target, each using that platform's string ops
  const stringSrc = stdlib('@cluesurf/seed/code/text/string')!.text
  const stringFor = (
    env: 'node' | 'browser' | 'rust' | 'swift' | 'kotlin',
  ) =>
    compile(
      { file: 's.tree', text: stringSrc },
      { resolve: withNativeEnv(env, stdlib) },
    )

  expect(
    'string compiles for node (host toUpperCase)',
    (() => {
      const r = stringFor('node')

      return r.ok && r.typescript.includes('toUpperCase')
    })(),
    true,
  )
  expect(
    'string compiles for browser (host toUpperCase)',
    (() => {
      const r = stringFor('browser')

      return r.ok && r.typescript.includes('toUpperCase')
    })(),
    true,
  )
  expect(
    'string compiles for rust (text shim)',
    (() => {
      const r = stringFor('rust')

      return r.ok && emitRust(r.program).includes('text::upper')
    })(),
    true,
  )
  expect(
    'string compiles for swift (text shim)',
    (() => {
      const r = stringFor('swift')

      return r.ok && emitSwift(r.program).includes('text.upper')
    })(),
    true,
  )
  expect(
    'string compiles for kotlin (text shim)',
    (() => {
      const r = stringFor('kotlin')

      return r.ok && emitKotlin(r.program).includes('text.upper')
    })(),
    true,
  )

  // the public regex interface compiles for every target, each wrapping that platform's regex engine
  const regexSrc = stdlib('@cluesurf/seed/code/regex')!.text
  const regexFor = (
    env: 'node' | 'browser' | 'rust' | 'swift' | 'kotlin',
  ) =>
    compile(
      { file: 'r.tree', text: regexSrc },
      { resolve: withNativeEnv(env, stdlib) },
    )

  expect(
    'regex compiles for node (regex shim)',
    (() => {
      const r = regexFor('node')

      return r.ok && r.typescript.includes('regex.matches')
    })(),
    true,
  )
  expect(
    'regex compiles for rust (regex shim)',
    (() => {
      const r = regexFor('rust')

      return r.ok && emitRust(r.program).includes('regex::matches')
    })(),
    true,
  )
  expect(
    'regex compiles for swift (regex shim)',
    (() => {
      const r = regexFor('swift')

      return r.ok && emitSwift(r.program).includes('regex.matches')
    })(),
    true,
  )
  expect(
    'regex compiles for kotlin (regex shim)',
    (() => {
      const r = regexFor('kotlin')

      return r.ok && emitKotlin(r.program).includes('regex.matches')
    })(),
    true,
  )

  // the public http interface compiles for every target, each wrapping that platform's HTTP library
  const httpSrc = stdlib('@cluesurf/seed/code/network/http')!.text
  const httpFor = (
    env: 'node' | 'browser' | 'rust' | 'swift' | 'kotlin',
  ) =>
    compile(
      { file: 'h.tree', text: httpSrc },
      { resolve: withNativeEnv(env, stdlib) },
    )

  expect(
    'http compiles for node (fetch shim)',
    (() => {
      const r = httpFor('node')

      return r.ok && r.typescript.includes('http.request')
    })(),
    true,
  )
  expect(
    'http compiles for rust (http shim)',
    (() => {
      const r = httpFor('rust')

      return r.ok && emitRust(r.program).includes('http::request')
    })(),
    true,
  )
  expect(
    'http compiles for swift (http shim)',
    (() => {
      const r = httpFor('swift')

      return r.ok && emitSwift(r.program).includes('http.request')
    })(),
    true,
  )
  expect(
    'http compiles for kotlin (http shim)',
    (() => {
      const r = httpFor('kotlin')

      return r.ok && emitKotlin(r.program).includes('http.request')
    })(),
    true,
  )

  console.log(
    `\nio: ${pass} pass, ${fail} fail  (public file API -> hidden node native -> real fs; + cross-target compile)`,
  )

  if (fail > 0) {process.exit(1)}
}

main()
