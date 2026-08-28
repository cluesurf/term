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
  const load = () => {
    try {
      return need('@bitwarden/sdk-napi')
    } catch (e) {
      process.stderr.write(
        'The Bitwarden SDK is not installed.\n\n' +
          '  pnpm add @bitwarden/sdk-napi\n\n' +
          'It is what lets a secret be written without putting its value in\n' +
          'a command line. Reading does not need it.\n',
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
