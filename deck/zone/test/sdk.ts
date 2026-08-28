// The SDK wrapper, against a fake SDK.
//
//   pnpm exec tsx test/sdk.ts
//
// A real token would test Bitwarden. This tests OUR code: that the value
// travels as an argument and never anywhere else, that an existing name is
// updated rather than duplicated, that a missing project is refused before
// anything is written, and that delete removes only what was asked for.
//
// The fake records every call, so "the value was never put in a string" is
// asserted rather than assumed.
import Module, { createRequire } from 'node:module'

const real = createRequire(import.meta.url)
const need = ((r: string) => (r === '@bitwarden/sdk-napi' ? fake : real(r))) as NodeJS.Require

type Call = { what: string; args: unknown[] }

const calls: Call[] = []
let projects = [{ id: 'p-base', name: 'base' }]
let secrets: Array<{ id: string; key: string; value: string }> = []

const fake = {
  BitwardenClient: class {
    auth() {
      return {
        loginAccessToken: async (token: string) => {
          calls.push({ what: 'login', args: [token] })

          if (token === 'bad') {
            throw new Error('401 Unauthorized')
          }
        },
      }
    }

    projects() {
      return { list: async () => ({ data: projects }) }
    }

    secrets() {
      return {
        list: async () => ({
          data: secrets.map(one => ({ id: one.id, key: one.key })),
        }),
        getByIds: async (ids: string[]) => ({
          data: secrets.filter(one => ids.includes(one.id)),
        }),
        create: async (org: string, key: string, value: string, note: string, ids: string[]) => {
          calls.push({ what: 'create', args: [org, key, value, note, ids] })
          const made = { id: `s-${secrets.length}`, key, value }
          secrets.push(made)
          return made
        },
        update: async (org: string, id: string, key: string, value: string, note: string, ids: string[]) => {
          calls.push({ what: 'update', args: [org, id, key, value, note, ids] })
          const at = secrets.findIndex(one => one.id === id)
          secrets[at] = { id, key, value }
          return secrets[at]
        },
        delete: async (ids: string[]) => {
          calls.push({ what: 'delete', args: [ids] })
          secrets = secrets.filter(one => !ids.includes(one.id))
          return {}
        },
      }
    }
  },
}

// hand the fake to the wrapper in place of the real module
const load = (Module as unknown as { _load: (...a: unknown[]) => unknown })._load
;(Module as unknown as { _load: (...a: unknown[]) => unknown })._load = (
  request: unknown,
  ...rest: unknown[]
) => (request === '@bitwarden/sdk-napi' ? fake : load(request, ...rest))

// the shim under test, loaded the way `term boot` would prepend it
import { readFileSync } from 'node:fs'
import { transformSync } from 'esbuild'

const source = readFileSync('code/hold/runtime/vault.ts', 'utf8')
const js = transformSync(source, { loader: 'ts', format: 'cjs' }).code
const vault = new Function('require', `${js}; return vault`)(need) as {
  put: (t: string, o: string, p: string, n: string, v: string) => Promise<string>
  drop: (t: string, o: string, p: string, n: string) => Promise<boolean>
  one: (t: string, o: string, n: string) => Promise<string>
}

const put = (a: any) => vault.put(a.token, a.organizationId, a.path, a.name, a.value)
const drop = (a: any) => vault.drop(a.token, a.organizationId, a.path, a.name)
const one = (a: any) => vault.one(a.token, a.organizationId, a.name)

let pass = 0
let fail = 0
const ok = (w: string) => { console.log(`  ok    ${w}`); pass += 1 }
const no = (w: string) => { console.log(`  FAIL  ${w}`); fail += 1 }

const SECRET = 'the-actual-secret-value'

// 1. a new name is created, in the right project
const first = await put({
  token: 'tok', organizationId: 'org', path: 'base',
  name: 'database-url', value: SECRET,
})

first === 'made' ? ok('a new name is created') : no(`got ${first}`)

const made = calls.find(c => c.what === 'create')
made?.args[2] === SECRET ? ok('the value is passed as an argument') : no('value not passed')
made?.args[4] && (made.args[4] as string[])[0] === 'p-base'
  ? ok('into the project the zone names')
  : no('wrong project')

// 2. an existing name is updated, not duplicated
const again = await put({
  token: 'tok', organizationId: 'org', path: 'base',
  name: 'database-url', value: 'a-new-value',
})

again === 'grew' ? ok('an existing name is updated') : no(`got ${again}`)
secrets.length === 1 ? ok('and not duplicated') : no(`${secrets.length} secrets exist`)

// 3. the value never appears anywhere but that one argument
const everywhere = JSON.stringify(
  calls.filter(c => c.what !== 'create' && c.what !== 'update'),
)

everywhere.includes(SECRET)
  ? no('the value leaked into another call')
  : ok('the value appears in no other call')

// 4. a missing project is refused before anything is written
projects = []
const before = secrets.length
let refused = false
const exit = process.exit
;(process as unknown as { exit: (c?: number) => void }).exit = () => {
  refused = true
  throw new Error('exited')
}

try {
  await put({ token: 'tok', organizationId: 'org', path: 'nowhere', name: 'x', value: 'y' })
} catch {
  // the fake exit throws
}

;(process as unknown as { exit: typeof exit }).exit = exit
refused ? ok('a missing project is refused') : no('it wrote into no project')
secrets.length === before ? ok('and nothing was written') : no('it wrote anyway')

// 5. delete removes only what was named
projects = [{ id: 'p-base', name: 'base' }]
secrets.push({ id: 's-9', key: 'other', value: 'keep' })
const gone = await drop({ token: 'tok', organizationId: 'org', path: 'base', name: 'database-url' })

gone ? ok('delete reports what it removed') : no('delete said nothing went')
secrets.length === 1 && secrets[0]?.key === 'other'
  ? ok('and removed only that one')
  : no('it removed the wrong thing')

// 6. reading one name back
const got = await one({ token: 'tok', organizationId: 'org', name: 'other' })
got === 'keep' ? ok('one name reads back') : no(`read ${got}`)

console.log('')
console.log(fail === 0 ? '  every sdk check passed' : `  ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
