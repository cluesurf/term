<h3 align='center'>zone.tree</h3>
<p align='center'>
  The Term Secret Access Library
</p>

## Overview

`zone` binds a machine, keeps its bootstrap credential in the operating
system's own keystore, and runs commands with secrets that exist only for
the life of the child process.

Nothing lands in a `.env`, a shell profile, git, or the terminal.

```bash
zone call npm run dev
```

## Commands

```text
zone bind                 configure this machine
zone call <command>       run a command with secrets
zone code save <tier>     store a bootstrap credential
zone code show <tier>     describe it without revealing it
zone code list            describe every tier
zone code toss <tier>     remove the local copy
zone show                 what this machine is bound to
zone test                 check the setup
zone toss                 unbind this machine
```

`call` takes the child command as ordinary arguments, so no `--` is
needed. A leading `--` is still accepted for a child whose own first
argument would otherwise look like a zone option.

## Three kinds of thing

Kept as distinct types on purpose, because collapsing them is how a
bootstrap credential ends up treated like an ordinary variable and
printed.

| | |
| --- | --- |
| `code` | the bootstrap credential that opens a provider |
| `hold` | a value retrieved from that provider |
| `need` | a declared requirement, carrying no value at all |

## Where the credential lives

The bootstrap credential is kept in one of five stores, chosen by what
the machine has. `zone bind` records the choice; `zone show` reports it.

| store | where the credential lives |
| --- | --- |
| `keychain` | macOS Keychain (via `security`) |
| `secret` | Linux Secret Service (via `secret-tool`) |
| `manager` | Windows Credential Manager |
| `env` | the `ZONE_CODE` environment variable |
| `prompt` | nowhere, asked on each run |

The system stores are preferred: encrypted at rest, unlocked by the
user's own login. **`env` is the headless store** — a CI runner, a
container, or a server has no desktop keychain but does have an
environment, populated from whatever secret store the platform provides.
Set `ZONE_CODE` (or `ZONE_CODE_<TIER>` for a specific tier) to the
bootstrap token and zone fetches everything else, so the platform holds
one secret instead of a whole `.env`. Force a store with `ZONE_SAVE`
(`ZONE_SAVE=env`) when auto-detection would pick the wrong one.

## Configuration

The machine binding, at `~/.config/zone/zone.tree`. Holds no secret.

```tree
zone <1>

mind lance
host lance-macbook
base development

hold bitwarden
  team cluesurf

save keychain
```

The repository declaration, at `.zone.tree`. Names what a project needs,
never what those things are, so it is safe to commit.

```tree
zone <1>
name talk

tier development
  hold bitwarden
  bind cluesurf-talk-development
  need openai-api-key
  need database-url
  want sentry-dsn
```

`need` must be present or the command refuses to start. `want` may be
absent. Names are kebab-case here and become `SCREAMING_SNAKE_CASE` in the
child's environment, the same rule the Term config system uses.

## What it will not do

- Print a credential. There is no flag for it.
- Mask one. A fragment still identifies the service and often the account.
- Persist a retrieved value anywhere.
- Put a credential in a command argument, where process inspection sees it.
- Pretend removing a local copy revoked anything remotely.

## Status

Working end to end. `zone bind`, `show`, `test`, `code save/show/list/toss`,
`call`, and `toss` all run. Two test suites cover it:

- `term test` (unit) — the pure logic: the kebab to `SCREAMING_SNAKE`
  naming rule, the required-versus-optional distinction, tier
  narrowing. Written in the Term test DSL under `test/`.
- `tmp/e2e.sh` (integration harness) — drives the whole
  `.env`-replacement pipeline against a fake provider: bind, store
  selection, a child process seeing only its declared secrets,
  exit-code passthrough, and refusal on a missing requirement. 16
  checks, entirely headless, touches no keychain. It lives in `tmp/`
  (scratch, gitignored); run it with `bash tmp/e2e.sh`.

Build with `term make` from this directory (zero errors across every
module). The `env` store makes the tool usable in CI and containers
today; the desktop stores work on their own platforms.

## Design

`note/library/zone/readme.md`.

## License

Copyright 2021-2026+ <a href='https://clue.surf'>ClueSurf</a>

Licensed under the Apache License, Version 2.0 (the "License"); you may
not use this file except in compliance with the License. You may obtain
a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

## ClueSurf

Made by [ClueSurf](https://clue.surf), meditating on the universe.
