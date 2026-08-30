// The Bitwarden Secrets Manager SDK, as a runtime shim.
//
// A shim rather than a module, because that is how a native reaches
// JavaScript here: `term boot` prepends the file named after the global, the
// same way `cipher` and `octets` arrive. A plain module under `code/` never
// reaches `host/`.
//
// WHY NOT THE `bws` COMMAND. `bws secret create` takes the value as a
// COMMAND-LINE ARGUMENT, with no stdin and no file. A command line is
// readable by anything on the machine that can list processes, so writing a
// secret that way puts it in front of every process on the box. Here the
// value is a function argument and never leaves this process.
//
// WHY NOT THE REST API. Bitwarden Secrets Manager is end to end encrypted:
// secrets are stored as `EncString` values encrypted client side with a key
// carried in the access token. Calling the API directly would mean
// implementing their encryption, which is hand-rolling another product's
// crypto to save one command.
const vault = (() => {
  // `require` is provided by the runtime the shim is prepended into.
  const need = require

  // Load the SDK, or say plainly what is missing.
  //
  // It is optional: reading goes through `bws`, and only writing needs this.
  // A tree that never writes should not have to carry a native module, and
  // one that does should be told what to install rather than shown a
  // resolution stack trace.
  // The SDK, or nothing. `all` falls back to the `bws` command line tool
  // when it is absent, so a tree that has not installed the SDK still
  // reads. Writing has no fallback: `bws` takes a value as a command
  // argument, where anything that can list processes can read it.
  const maybe = () => {
    try {
      return need('@bitwarden/sdk-napi')
    } catch (e) {
      return undefined
    }
  }

  const load = () => {
    try {
      return need('@bitwarden/sdk-napi')
    } catch (e) {
      process.stderr.write(
        'The Bitwarden SDK is not installed.\n\n' +
          '  pnpm add @bitwarden/sdk-napi\n\n' +
          'It is how every secret is read and written. Reading used to go\n' +
          'through the `bws` command line tool, which is a second binary to\n' +
          'install and puts a value in argv when writing. This does neither.\n',
      )
      process.exit(1)
    }
  }

  const open = async (token: string) => {
    const { BitwardenClient } = load()
    const client = new BitwardenClient()

    try {
      await client.auth().loginAccessToken(token)
    } catch (e: any) {
      process.stderr.write(
        'The provider refused the credential.\n\n  ' +
          String(e?.message ?? e).split('\n')[0] +
          '\n\nThe credential may be wrong, expired or revoked. Check it with\n' +
          '`term zone code show` and replace it with `term zone code save`.\n',
      )
      process.exit(1)
    }

    return client
  }

  const projectOf = async (client: any, org: string, path: string) => {
    const projects = await client.projects().list(org)

    return projects.data.find((one: any) => one.name === path)?.id
  }

  const named = async (client: any, org: string, name: string) => {
    const all = await client.secrets().list(org)

    return all.data.find((one: any) => one.key === name)
  }

  return {
    // Write one secret: created if the name is new, updated if not.
    //
    // `value` is a function argument the whole way down. It is never
    // formatted into a string, never logged, never passed to a child.
    put: async (
      token: string,
      org: string,
      path: string,
      name: string,
      value: string,
    ): Promise<string> => {
      const client = await open(token)
      const project = await projectOf(client, org, path)

      if (!project) {
        process.stderr.write(
          `No project called ${path} at the provider.\n\n` +
            'Run `term zone save --commit` to create a project per zone first.\n',
        )
        process.exit(1)
      }

      const already = await named(client, org, name)

      if (already) {
        await client
          .secrets()
          .update(org, already.id, name, value, '', [project])

        return 'grew'
      }

      await client.secrets().create(org, name, value, '', [project])

      return 'made'
    },

    // Remove one secret by name.
    drop: async (
      token: string,
      org: string,
      path: string,
      name: string,
    ): Promise<boolean> => {
      const client = await open(token)
      const already = await named(client, org, name)

      if (!already) {
        return false
      }

      await client.secrets().delete([already.id])

      return true
    },

    // Read one secret's value by name.
    // EVERY SECRET IN THE ORGANIZATION, with its value and its note.
    //
    // This is what `zone read` needs, and it is why the container does not
    // need the `bws` CLI. `bws` is a Rust binary that is not in the image
    // and would have to be downloaded into it; the SDK is already a
    // dependency and speaks the same API.
    //
    // TWO CALLS, NOT ONE PER SECRET. `list` returns metadata only, so the
    // ids it yields are fetched together with `getByIds`. Asking per secret
    // would be nine hundred round trips.
    //
    // The note comes back on the list rather than the fetch in some SDK
    // versions, so both are merged by id and whichever carries it wins.
    all: async (
      token: string,
      org: string,
      // The projects asked for. Values are fetched ONLY for these, so
      // naming one zone does not pull every secret in the organization
      // into the process. Empty means all of them.
      binds: string[] = [],
    ): Promise<
      Array<{ name: string; body: string; note: string; bind: string }>
    > => {
      // NO SDK: fall back to `bws`, which is what reading used before.
      // The container has the SDK and no `bws`; a checkout may have the
      // reverse. Neither should have to install the other.
      if (!maybe()) {
        const cp = need('node:child_process')
        const out: Array<{ name: string; body: string; note: string; bind: string }> = []

        for (const bind of binds.length ? binds : ['']) {
          try {
            const raw = cp.execFileSync(
              'bws',
              ['secret', 'list', bind, '--output', 'json'].filter(Boolean),
              {
                encoding: 'utf8',
                maxBuffer: 33554432,
                timeout: 20000,
                env: { ...process.env, BWS_ACCESS_TOKEN: token },
                stdio: ['ignore', 'pipe', 'pipe'],
              },
            )

            for (const one of JSON.parse(raw)) {
              const key = String(one.key ?? '')
              const cut = key.indexOf(':')

              out.push({
                name: (cut > 0 ? key.slice(cut + 1) : key)
                  .toLowerCase()
                  .split('_')
                  .join('-'),
                body: String(one.value ?? ''),
                note: String(one.note ?? ''),
                bind: String(bind),
              })
            }
          } catch (e) {
            // A project that fails is empty rather than fatal: the caller
            // refuses on a missing required name, and that message names
            // the value, which is more use than a provider error naming a
            // project.
          }
        }

        return out
      }

      const client = await open(token)
      const listed = await client.secrets().list(org)
      const rows = listed?.data ?? []

      if (rows.length === 0) {
        return []
      }

      const byId = new Map<string, any>()

      for (const row of rows) {
        byId.set(row.id, row)
      }

      // WHAT `binds` HOLDS DEPENDS ON THE MODE, and both have to work.
      //
      // `note` mode looks the one project up by name and passes its ID.
      // `project` mode passes the zone PATH, which is the project's name.
      // The old `bws` path took whatever it was given as a command
      // argument, so the difference never surfaced.
      //
      // So each entry is matched against an id or a name, and the project
      // list is what turns a name into an id.
      const projects = await client.projects().list(org)
      const byName = new Map<string, string>()

      for (const one of projects?.data ?? []) {
        byName.set(String(one.name), String(one.id))
      }

      const wanted = new Set(
        binds.map(one => byName.get(one) ?? one).filter(Boolean),
      )

      // `list` returns metadata only, which is how the wanted rows are
      // picked before any VALUE is fetched. That is the whole isolation
      // guarantee: a run that asks for one zone never holds the others'
      // values, even for an instant.
      // ONLY FILTER WHEN THE PROVIDER SAYS WHICH PROJECT A SECRET IS IN.
      //
      // Not every SDK version puts `projectId` on a list row. Filtering on
      // an absent field matches nothing, and the failure is silent: the
      // fetch succeeds, the cache is written, and every required name reads
      // as missing afterwards. So when no row carries one, take them all
      // and let the zone note do the narrowing, which is what `note` mode
      // does anyway.
      const knows = rows.some((r: any) => String(r.projectId ?? '') !== '')

      const want =
        binds.length === 0 || !knows
          ? rows
          : rows.filter((r: any) => wanted.has(String(r.projectId ?? '')))

      if (want.length === 0) {
        return []
      }

      const got = await client.secrets().getByIds(want.map((r: any) => r.id))

      return (got?.data ?? []).map((one: any) => {
        const meta = byId.get(one.id) ?? {}
        // A key may carry a `<zone>:` prefix, which is not part of the name.
        const raw = String(one.key ?? meta.key ?? '')
        const cut = raw.indexOf(':')
        const key = cut > 0 ? raw.slice(cut + 1) : raw

        return {
          name: key.toLowerCase().split('_').join('-'),
          body: String(one.value ?? ''),
          note: String(one.note ?? meta.note ?? ''),
          // Which project it belongs to, so `project` mode can still group
          // by it. `note` mode ignores this and reads the note instead.
          bind: String(one.projectId ?? meta.projectId ?? ''),
        }
      })
    },

    one: async (
      token: string,
      org: string,
      name: string,
    ): Promise<string> => {
      const client = await open(token)
      const already = await named(client, org, name)

      if (!already) {
        return ''
      }

      const got = await client.secrets().getByIds([already.id])

      return got.data[0]?.value ?? ''
    },
  }
})()
