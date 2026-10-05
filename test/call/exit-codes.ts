// Phase 2 of note/term/gaps/plan.md, "Exit codes that tell the truth": a command that failed at what it was asked
// exits non-zero, and a command that wrote nothing does not say it wrote something. Each case is the run a term.surf
// guide made, against the built CLI.
//
// Run: npx tsx test/call/exit-codes.ts (after `pnpm run make:line`)

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
// TERM_LINE points at another bundle, so a change can be tried without replacing the CLI a running gate uses
const LINE = process.env.TERM_LINE ?? join(HERE, '../../host/line.js')

let pass = 0
let fail = 0

function ok(name: string, good: boolean, detail = ''): void {
  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

function term(cwd: string, ...args: string[]): { status: number | null; out: string } {
  const run = spawnSync('node', [LINE, ...args], { cwd, encoding: 'utf8', timeout: 240_000, env: { ...process.env, NO_COLOR: '1' } })

  return { status: run.status, out: `${run.stdout}${run.stderr}` }
}

// a project with one benchmark and one test file, which is what `term time` walks
const project = mkdtempSync(join(tmpdir(), 'term-exit-codes-'))
mkdirSync(join(project, 'code'))
mkdirSync(join(project, 'test'))
writeFileSync(join(project, 'deck.tree'), 'deck @probe/exit\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')
writeFileSync(
  join(project, 'code/base.tree'),
  `task time-sum
  like number
  send back
    call add
      code 1
      code 2
`,
)
writeFileSync(
  join(project, 'test/sum.tree'),
  `test sum-adds
  want hold
    call is-equal
      call add
        code 1
        code 2
      code 3
`,
)

// ---- commands/show: outside a project ----
{
  const empty = mkdtempSync(join(tmpdir(), 'term-exit-empty-'))
  const run = term(empty, 'show', 'mark')

  ok('`term show mark` outside a project exits non-zero', run.status !== 0, run.out)

  // from the project's own `code/` folder, the nearest deck.tree above it
  const shown = mkdtempSync(join(tmpdir(), 'term-show-'))
  mkdirSync(join(shown, 'code'))
  writeFileSync(join(shown, 'deck.tree'), 'deck @probe/show\n  mark <0.0.2>\n')

  const nested = term(join(shown, 'code'), 'show', 'mark')

  ok('`term show mark` from `code/` reads the deck.tree above it', nested.status === 0 && nested.out.trim() === '0.0.2', nested.out)

  const json = term(shown, 'show', 'mark', '--back', 'json')

  ok('`--back json` prints the version as JSON', json.out.trim() === '{"mark":"0.0.2"}', json.out)

  const toolchain = term(empty, 'show', '--back', 'json')
  const parsed = (() => {
    try {
      return JSON.parse(toolchain.out) as Record<string, string>
    } catch {
      return {}
    }
  })()

  ok('and the toolchain as JSON', typeof parsed.term === 'string' && typeof parsed.node === 'string', toolchain.out)

  const block = term(empty, 'show')

  ok('the toolchain block has no blank line before or after it', block.out.startsWith('term ') && !block.out.endsWith('\n\n'), JSON.stringify(block.out))

  const unknown = term(empty, 'show', 'nope')

  ok('`term show nope` is refused, exit 2', unknown.status === 2 && /nothing named nope to show/.test(unknown.out), unknown.out)

  const broken = mkdtempSync(join(tmpdir(), 'term-show-broken-'))
  writeFileSync(join(broken, 'deck.tree'), 'deck @probe/broken\n  mark <not a version>\n')

  const unread = term(broken, 'show', 'mark')

  ok('a deck.tree that cannot be read says so, not that there is none', unread.status !== 0 && /could not be read/.test(unread.out), unread.out)

  // the native toolchains, each with its version or `not found`: with only node's own folder on the PATH, none is
  const tools = term(empty, 'show', 'tools', '--back', 'json')
  const listed = (() => {
    try {
      return JSON.parse(tools.out) as { tool: string; version: string | null }[]
    } catch {
      return []
    }
  })()

  ok('`term show tools` names cargo, rustc, swiftc, kotlinc and java', listed.map(one => one.tool).join(' ') === 'cargo rustc swiftc kotlinc java', tools.out)

  const bare = spawnSync(process.execPath, [LINE, 'show', 'tools'], {
    cwd: empty,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1', PATH: dirname(process.execPath) },
  })

  ok('and says `not found` for one that is not on the PATH', bare.status === 0 && /cargo\s+not found/.test(bare.stdout), `${bare.stdout}${bare.stderr}`)

  // and `term make --target` asks first, before it builds anything
  if (process.platform === 'darwin') {
    const target = spawnSync(process.execPath, [LINE, 'make', '--target', 'macos'], {
      cwd: shown,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', PATH: dirname(process.execPath) },
    })

    ok('`term make --target macos` without swiftc refuses before it builds, naming it', target.status !== 0 && /needs swiftc/.test(target.stderr) && !/bridge|build +program/.test(target.stderr), target.stderr)
  }
}

// ---- commands/time, tests/benchmarks: a baseline that does not exist ----
{
  const run = term(project, 'time', '--compare', 'nope', '--fail-on-regression', '5')

  ok('`term time --compare` with no such baseline exits 1', run.status === 1, run.out)
  // a ✗ item naming the baseline, with the path it looked for in a `looked` field
  ok('naming the file it looked for', /There is no baseline named nope[\s\S]*?looked\s+\S*nope\.json/.test(run.out), run.out)
  ok('before any benchmark ran', !/time-sum/.test(run.out), run.out)
}

// ---- commands/time: `--history` alone runs nothing, and prints local time ----
{
  term(project, 'time', '--save', 'history-probe')

  const shown = term(project, 'time', '--history', 'time-sum')
  const local = new Date()
  const today = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')} `

  ok('`term time --history` prints the saved runs and runs no benchmark', shown.status === 0 && /History for "time-sum"/.test(shown.out) && /History shown/.test(shown.out) && !/Benchmarks complete/.test(shown.out), shown.out)
  ok('in local time, with no `T`', shown.out.includes(today) && !/\d{4}-\d\d-\d\dT\d\d/.test(shown.out), shown.out)

  const compared = term(project, 'time', '--compare', 'history-probe')

  ok('a comparison\'s counts are on the closing item, not a bare line', /Benchmarks complete[\s\S]*improvement/.test(compared.out) && !/improvement\(s\)/.test(compared.out), compared.out)
}

// ---- commands/time: the walk is the build's, and a test file is rewritten ----
{
  const run = term(project, 'time')

  ok('`term time` runs the benchmark', run.status === 0 && /time-sum/.test(run.out), run.out)
  ok('and compiles neither the manifest nor a raw test file as code', !/unknown-name|deck\.tree: /.test(run.out), run.out)
}

// ---- commands/form: `--list` writes nothing and says so ----
{
  const file = join(project, 'code/loose.tree')
  const written = 'task two\n  like number\n  send back\n    call add\n      code 1\n      code 2\n\n\n\n'

  writeFileSync(file, written)

  const run = term(project, 'form', '--list', 'code/loose.tree')

  ok('`term form --list` leaves the file as it was', readFileSync(file, 'utf8') === written)
  ok('and does not say it formatted anything', !/Formatted \d+ file/.test(run.out), run.out)
  ok('it says it printed the file and wrote nothing', /Printed .*nothing (was )?written/i.test(run.out), run.out)
}

// ---- commands/test, tests/writing: a failing test says which `want` failed ----
{
  const tests = mkdtempSync(join(tmpdir(), 'term-want-'))
  mkdirSync(join(tests, 'test'))
  writeFileSync(join(tests, 'deck.tree'), 'deck @probe/want\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')
  writeFileSync(
    join(tests, 'test/double.tree'),
    `task double
  take n, like number
  like number
  send back
    call multiply
      read n
      code 2

test <double of three is six>
  want hold
    call is-equal
      call double
        code 3
      code 6

test <double of zero is zero>
  want hold
    call is-equal
      call double
        code 0
      code 1
`,
  )

  const run = term(tests, 'test')

  ok('a failing test fails the run', run.status === 1, run.out)
  ok('naming the line of the `want` that did not hold', /line 17 did not hold: want hold/.test(run.out), run.out)
}

// ---- parsers/grammars: a grammar builds and rolls as its reader, and a miss says where and what ----
{
  const grammar = mkdtempSync(join(tmpdir(), 'term-grammar-'))
  mkdirSync(join(grammar, 'code/version'), { recursive: true })
  writeFileSync(join(grammar, 'deck.tree'), 'deck @probe/grammar\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\nlink @term/feed, mark <0.0.x>\n')
  writeFileSync(
    join(grammar, 'code/version/mine.tree'),
    `mine version
  mine form, form digits
    send major
  mine char, <.>
  mine form, form digits
    send minor

mine digits
  mine list
    mine range
      bind base, <0>
      bind head, <9>
`,
  )

  const made = term(grammar, 'make')

  ok('a grammar builds', made.status === 0, made.out)
  ok('with no warning about the reader it generated', !/never used/.test(made.out), made.out)

  const rolled = term(grammar, 'roll', 'task', '--host', '@probe/grammar')

  ok('`term roll` reads the grammar as the build does, not as plain Term', rolled.status === 0 && !/unknown-name/.test(rolled.out), rolled.out)
  ok('and a miss raises `failure`', /task @probe\/grammar\/read-version[\s\S]*?halt failure/.test(rolled.out), rolled.out)

  writeFileSync(
    join(grammar, 'probe.ts'),
    `import { readVersion } from './host/code/version/mine.ts'
const cursor = (text: string) => ({ text: [text], position: [0], length: [Array.from(text).length], pull: { form: 'none' as const }, exhausted: [true] })
try {
  readVersion(cursor('12-4'))
} catch (e) {
  console.log((e as { note?: string }).note)
}
`,
  )

  const probe = spawnSync('npx', ['tsx', 'probe.ts'], { cwd: grammar, encoding: 'utf8', timeout: 120_000 })

  ok('a miss names what it expected, where reading stopped, and what was there', /expected "\." at position 2, found "-"/.test(probe.stdout), `${probe.stdout}${probe.stderr}`)
}

// ---- a `mine.tree` under the `mill` role is a mill grammar, checked as itself, never read as a feed grammar ----
{
  const mills = mkdtempSync(join(tmpdir(), 'term-mill-'))
  mkdirSync(join(mills, 'code/text'), { recursive: true })
  writeFileSync(join(mills, 'deck.tree'), 'deck @probe/mill\nhead <Probe>\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')
  writeFileSync(join(mills, 'role.tree'), 'role mill\n  take @/code/**/*.tree\n')
  writeFileSync(
    join(mills, 'code/text/mine.tree'),
    `mine text
  mine list
    mine form, like text-def
      site text

mine text-def
  mine term, term text
    mine term
      site name
    mine text
      site text
`,
  )

  const made = term(mills, 'make')

  ok('a mill grammar builds under the `mill` role', made.status === 0 && !/cannot tell whether this grammar reads/.test(made.out), made.out)
}

// ---- packages/versions: `term move mark rc` starts and moves a pre-release, and a bad level is refused ----
{
  const moved = mkdtempSync(join(tmpdir(), 'term-move-'))
  writeFileSync(join(moved, 'deck.tree'), 'deck @probe/move\n  mark <1.4.2>\n')

  const versions = ['rc', 'rc', '3'].map(level => {
    term(moved, 'move', 'mark', level)

    return /mark <([^>]+)>/.exec(readFileSync(join(moved, 'deck.tree'), 'utf8'))?.[1]
  })

  ok('`term move mark rc` goes 1.4.3-rc.1, 1.4.3-rc.2, and `3` releases 1.4.3', versions.join(' ') === '1.4.3-rc.1 1.4.3-rc.2 1.4.3', versions.join(' '))

  const bad = term(moved, 'move', 'mark', '4')

  ok('`term move mark 4` is refused with exit 2, and moves nothing', bad.status === 2 && /4 is not a part of the version/.test(bad.out) && readFileSync(join(moved, 'deck.tree'), 'utf8').includes('<1.4.3>'), bad.out)
}

// ---- packages/versions: `term save` takes the versions a link accepts ----
{
  const saved = mkdtempSync(join(tmpdir(), 'term-save-'))
  writeFileSync(join(saved, 'deck.tree'), 'deck @probe/save\n  mark <0.0.1>\n')

  // the install after it has no registry to reach here, so only the manifest is read
  term(saved, 'save', '@probe/none', '^1.2.0')
  const written = readFileSync(join(saved, 'deck.tree'), 'utf8')

  ok('`term save @probe/none ^1.2.0` writes the range it means', /link @probe\/none, mark <1\.2\.0\.\.2\.0\.0>/.test(written), written)

  const bad = term(saved, 'save', '@probe/other', 'nope')

  ok('`term save` with a version that is none is refused, and writes nothing', bad.status !== 0 && !readFileSync(join(saved, 'deck.tree'), 'utf8').includes('@probe/other'), bad.out)
}

// ---- commands/wake: a file already in the folder is kept ----
{
  const woken = mkdtempSync(join(tmpdir(), 'term-wake-'))
  writeFileSync(join(woken, 'readme.md'), '# mine\n')
  writeFileSync(join(woken, '.gitignore'), 'secrets\n')

  const run = term(woken, 'wake')

  ok('`term wake` keeps a readme.md and a .gitignore already there', run.status === 0 && readFileSync(join(woken, 'readme.md'), 'utf8') === '# mine\n' && readFileSync(join(woken, '.gitignore'), 'utf8') === 'secrets\n', run.out)
  ok('and writes the rest, saying which it kept', readFileSync(join(woken, 'deck.tree'), 'utf8').startsWith('deck ') && /keep\s+readme\.md/.test(run.out) && /2 files/.test(run.out), run.out)
}

// ---- commands/wash: `-h` is help, and a folder that is no project is left alone ----
{
  const loose = mkdtempSync(join(tmpdir(), 'term-wash-'))
  mkdirSync(join(loose, 'make'))
  writeFileSync(join(loose, 'make/notes.txt'), 'mine\n')

  const hinted = term(loose, 'wash', '-h')

  ok('`term wash -h` prints help and removes nothing', hinted.status === 0 && /Show help/.test(hinted.out) && existsSync(join(loose, 'make/notes.txt')), hinted.out)

  const washed = term(loose, 'wash')

  ok('`term wash` outside a project refuses and keeps `make/`', washed.status === 1 && /no deck\.tree here/.test(washed.out) && existsSync(join(loose, 'make/notes.txt')), washed.out)

  const word = term(loose, 'wash', 'everything')

  ok('`term wash everything` is refused, exit 2', word.status === 2 && /nothing named everything to wash/.test(word.out), word.out)
}

// ---- commands/view: with no path, the documents are what role.tree gives the view role ----
{
  const viewed = mkdtempSync(join(tmpdir(), 'term-view-'))
  mkdirSync(join(viewed, 'code'))
  mkdirSync(join(viewed, 'page'))
  writeFileSync(join(viewed, 'deck.tree'), 'deck @probe/view\n  mark <0.0.1>\n')
  writeFileSync(join(viewed, 'role.tree'), 'role view\n  take @/page/**/*.tree\n\nrole code\n  take @/code/**/*.tree\n')
  writeFileSync(join(viewed, 'code/boot.tree'), 'task boot\n  like void\n')
  writeFileSync(
    join(viewed, 'page/sounds.tree'),
    `load @view/text
  find heading

view page
  view text/heading
    bind rank, 1
    bind text, <Vowels>
`,
  )

  const all = term(viewed, 'view')

  ok('`term view` checks the view role alone, not the code, deck.tree or role.tree', all.status === 0 && /page\/sounds\.tree/.test(all.out) && /1 document read/.test(all.out) && !/boot\.tree|deck\.tree|role\.tree/.test(all.out), all.out)

  const found = term(viewed, 'view', 'page/sounds.tree', '--find')

  ok('`--find` ends its manifest with one newline', found.status === 0 && /[^\n]\n$/.test(found.out.split('· view')[0] ?? found.out), JSON.stringify(found.out))

  // a bare `<vowel>` in a query is the text, the same as `text <vowel>`
  const query = (literal: string): string => `load @view/text
  find list

host slug, like text

find vowel
  task <filter:phoneme>
  meet and
    hold is-equal
      read self/language
      read slug
    hold is-equal
      read self/kind
      ${literal}

view page
  view text/list
    bind list, read vowel
`

  writeFileSync(join(viewed, 'page/bare.tree'), query('<vowel>'))
  writeFileSync(join(viewed, 'page/spelled.tree'), query('text <vowel>'))

  const manifestOf = (file: string): string => (term(viewed, 'view', file, '--find').out.split('· view')[0] ?? '').replace(/page\/\w+/g, 'page')

  const bare = manifestOf('page/bare.tree')
  const spelled = manifestOf('page/spelled.tree')

  ok('a bare `<vowel>` in a query reaches the manifest as `text <vowel>` does', spelled !== '' && bare === spelled, `${bare}\n---\n${spelled}`)
}

// ---- commands/mind: a replaced fact, forgetting one, and the memory kept by git ----
{
  const minded = mkdtempSync(join(tmpdir(), 'term-mind-'))
  writeFileSync(join(minded, 'deck.tree'), 'deck @probe/mind\n  mark <0.0.1>\n')

  term(minded, 'mind', 'Ratios use integer division', '--name', 'integer-ratio', '--kind', 'decision')
  const again = term(minded, 'mind', 'Ratios round toward zero', '--name', 'integer-ratio', '--kind', 'decision')

  ok('a fact under a used name is a change naming what it was', /~ change\s+integer-ratio/.test(again.out) && /was: Ratios use integer division/.test(again.out) && /Replaced/.test(again.out), again.out)

  const forgot = term(minded, 'mind', '--forget', 'integer-ratio')
  const index = readFileSync(join(minded, '.base/@cluesurf/term/memory/index.md'), 'utf8')

  ok('`--forget` removes the fact and its index line', forgot.status === 0 && /remove\s+integer-ratio/.test(forgot.out) && !existsSync(join(minded, '.base/@cluesurf/term/memory/integer-ratio.md')) && !index.includes('integer-ratio'), `${forgot.out}\n${index}`)

  const unknown = term(minded, 'mind', '--forget', 'nothing-here')

  ok('`--forget` of a name never used fails', unknown.status === 1 && /no fact named nothing-here/.test(unknown.out), unknown.out)

  const kind = term(minded, 'mind', 'x', '--kind', 'wish')

  ok('a refused `--kind` is one readable item, exit 2', kind.status === 2 && !kind.out.includes('␊') && /wish/.test(kind.out), kind.out)

  // the scaffold's .gitignore keeps the memory and ignores the rest of .base/
  const woken = mkdtempSync(join(tmpdir(), 'term-mind-git-'))
  term(woken, 'wake')
  spawnSync('git', ['-C', woken, 'init', '-q'])
  const ignored = (file: string): boolean => spawnSync('git', ['-C', woken, 'check-ignore', '-q', file]).status === 0

  ok('a new project commits its memory and ignores its cache', !ignored('.base/@cluesurf/term/memory/index.md') && ignored('.base/@cluesurf/term/cache/x') && ignored('.base/other/x') && ignored('host/x.ts'), '')
}

// ---- packages/decks: a deck under the project's own deck/ folder is linked by `term load` ----
{
  const local = mkdtempSync(join(tmpdir(), 'term-local-deck-'))
  mkdirSync(join(local, 'code'))
  mkdirSync(join(local, 'deck/tools/code'), { recursive: true })
  writeFileSync(join(local, 'deck.tree'), 'deck @probe/app\n  mark <0.0.1>\n  link @alice/tools, mark <1.x.x>\n')
  writeFileSync(join(local, 'deck/tools/deck.tree'), 'deck @alice/tools\n  mark <1.0.0>\n')
  writeFileSync(join(local, 'deck/tools/code/stars.tree'), 'task stars\n  like number\n  send back, 5\n')
  writeFileSync(join(local, 'code/base.tree'), 'load @alice/tools/stars\n  find stars\n\ntask boot\n  like number\n  send back, stars()\n')

  const loaded = term(local, 'load', '--offline')
  const linked = (() => {
    try {
      return realpathSync(join(local, 'link/@alice/tools'))
    } catch {
      return ''
    }
  })()

  ok('`term load` links a deck under the project\'s own deck/ folder to that folder', loaded.status === 0 && linked === realpathSync(join(local, 'deck/tools')), `${linked}\n${loaded.out}`)
  ok('and counts it on its item, not as a bare `Installed 1 packages` line', /install +Dependencies[\s\S]*?1 deck\b/.test(loaded.out) && !/Installed \d+ packages/.test(loaded.out), loaded.out)

  const made = term(local, 'make')

  ok('and a module that loads it builds, with no `term link`', made.status === 0, made.out)

  const sought = term(local, 'seek')

  ok('and `term seek` finds it installed', sought.status === 0 && !/missing/i.test(sought.out), sought.out)

  // `term link --toss` removes a link, and says so only when there was one
  const tossed = term(local, 'link', '--toss', '@alice/tools')
  const gone = (() => {
    try {
      realpathSync(join(local, 'link/@alice/tools'))

      return false
    } catch {
      return true
    }
  })()

  ok('`term link --toss` removes the link', tossed.status === 0 && gone && /unlinked/.test(tossed.out), tossed.out)

  const again = term(local, 'link', '--toss', '@alice/tools')

  ok('and a second time says there is none, exit 1', again.status === 1 && /no link named @alice\/tools/.test(again.out), again.out)
}

// ---- packages/install: a load of a deck that is not installed is refused at the load ----
{
  const missing = mkdtempSync(join(tmpdir(), 'term-missing-deck-'))
  mkdirSync(join(missing, 'code'))
  writeFileSync(join(missing, 'deck.tree'), 'deck @probe/app\n  mark <0.0.1>\n  link @alice/tools, mark <1.x.x>\n')
  writeFileSync(join(missing, 'code/base.tree'), 'load @alice/tools/stars\n  find stars\n\ntask boot\n  like number\n  send back, stars()\n')

  const made = term(missing, 'make')

  ok('a load of a deck that is not installed is refused at the load, naming it', made.status === 1 && /@alice\/tools is not installed/.test(made.out) && /base\.tree:1:/.test(made.out) && !/"stars" is not defined/.test(made.out), made.out)
}

// ---- packages/install: a `link/` entry that points nowhere does not stop the walk ----
{
  const dangling = mkdtempSync(join(tmpdir(), 'term-dangling-'))
  mkdirSync(join(dangling, 'code'))
  mkdirSync(join(dangling, 'link/@alice'), { recursive: true })
  writeFileSync(join(dangling, 'deck.tree'), 'deck @probe/app\n  mark <0.0.1>\n')
  writeFileSync(join(dangling, 'code/base.tree'), 'task one\n  like number\n  send back, 1\n')
  symlinkSync('../../nowhere', join(dangling, 'link/@alice/tools'))

  const made = term(dangling, 'make')

  ok('a `link/` entry that points nowhere does not stop a build that does not load it', made.status === 0 && !/ENOENT/.test(made.out), made.out)
}

// ---- commands/hunt: a test file is rewritten before it is hunted, so it compiles ----
{
  const hunted = mkdtempSync(join(tmpdir(), 'term-hunt-'))
  mkdirSync(join(hunted, 'code'))
  mkdirSync(join(hunted, 'test'))
  writeFileSync(join(hunted, 'deck.tree'), 'deck @probe/hunt\n  mark <0.0.1>\n')
  writeFileSync(join(hunted, 'code/base.tree'), 'task double\n  take n, like number\n  like number\n  send back, multiply(n, 2)\n')
  writeFileSync(join(hunted, 'test/double.tree'), 'load ../code/base\n  find double\n\ntest <doubles>\n  want hold\n    call is-equal\n      call double\n        code 2\n      code 4\n')

  const run = term(hunted, 'hunt', '--runs', '20', '--fuzz-timeout', '30')

  ok('`term hunt` compiles a test file as the build does', /2 files · 2 compiled/.test(run.out), run.out)
}

// ---- commands/test: a file of laws alone is counted as checked proofs, not as a test ----
{
  const lawful = mkdtempSync(join(tmpdir(), 'term-laws-'))
  mkdirSync(join(lawful, 'test'))
  writeFileSync(join(lawful, 'deck.tree'), 'deck @probe/laws\n  mark <0.0.1>\n')
  writeFileSync(join(lawful, 'test/one.tree'), 'test <one>\n  want hold\n    call is-equal\n      code 1\n      code 1\n')
  writeFileSync(
    join(lawful, 'test/law.tree'),
    'task double\n  take n, like integer\n  like integer\n  send back, multiply(n, 2)\n\nrule double-is-sum\n  mark n, like integer\n  show is-equal double(n), add(n, n)\n',
  )

  const run = term(lawful, 'test')

  ok('a file of laws alone is counted as a checked proof file, not a test', run.status === 0 && /1 test · 1 passed · 1 proof file checked/.test(run.out), run.out)
}

// ---- commands: `term` alone names every verb `term -h` lists ----
{
  const full = term(project, '-h').out
  const verbs = [...new Set([...full.matchAll(/^ {2}term (\w+)/gm)].map(m => m[1]!))]
  const banner = term(project).out
  const missing = verbs.filter(verb => !new RegExp(`^ {4}term ${verb}\\b`, 'm').test(banner))

  ok('`term` alone names every verb `term -h` lists', verbs.length > 30 && missing.length === 0, `${verbs.length} verbs, missing: ${missing.join(' ')}`)
}

// ---- commands/walk: the session reads the project it was started in ----
{
  const walked = mkdtempSync(join(tmpdir(), 'term-walk-'))
  mkdirSync(join(walked, 'code'))
  writeFileSync(join(walked, 'deck.tree'), 'deck @probe/walk\n  mark <0.0.1>\n')
  writeFileSync(join(walked, 'code/count.tree'), 'task triple\n  take n, like number\n  like number\n  send back, multiply(n, 3)\n')

  const session = spawnSync(process.execPath, [LINE, 'walk'], {
    cwd: walked,
    encoding: 'utf8',
    input: 'load ./code/count\n  find triple\n\ntriple(4)\n\nload ./code/nope\n  find nothing\n\nexit\n',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 120_000,
  })

  ok('`term walk` loads a project file by a relative path and calls it', /added \.\/code\/count/.test(session.stdout) && /^12$/m.test(session.stdout), `${session.stdout}\n${session.stderr}`)
  ok('and refuses a load nothing answers, rather than printing `added`', /nothing answers load \.\/code\/nope/i.test(session.stderr) && !/added \.\/code\/nope/.test(session.stdout), `${session.stdout}\n${session.stderr}`)
}

// ---- commands/scan: a file is read the way `term make` reads it ----
{
  const scanned = mkdtempSync(join(tmpdir(), 'term-scan-'))
  mkdirSync(join(scanned, 'code'))
  writeFileSync(join(scanned, 'deck.tree'), 'deck @probe/scan\n  mark <0.0.1>\n')
  writeFileSync(join(scanned, 'role.tree'), 'role code\n  mark lean\n  take @/code/**/*.tree\n')
  writeFileSync(
    join(scanned, 'code/area.tree'),
    'task area\n  take height, like number\n  take width, like number\n  like number\n  back multiply(height, width)\n\ntask room\n  like number\n  back area(height 3, width 4)\n',
  )

  const made = term(scanned, 'make')
  const run = term(scanned, 'scan', 'code/area.tree')

  ok('`term scan` reads a `mark lean` file as lean, as `term make` does', made.status === 0 && run.status === 0 && !/not defined/.test(run.out), `${made.out}\n${run.out}`)

  const missing = term(scanned, 'scan', 'code/nope.tree')

  ok('and names a missing file relative to the working folder', /looked +code\/nope\.tree/.test(missing.out), missing.out)

  // a name loaded from a sibling file by a relative path
  writeFileSync(join(scanned, 'code/main.tree'), 'load ./area\n  find room\n\ntask boot\n  like number\n  back room()\n')

  const sibling = term(scanned, 'scan', 'code/main.tree')

  ok('and follows a relative `load` to a sibling file', sibling.status === 0 && !/not defined/.test(sibling.out), sibling.out)
}

// ---- commands/make: a file named without --emit is refused, not ignored ----
{
  const named = term(project, 'make', 'code/base.tree')

  ok('`term make <file>` without --emit is refused, exit 2, naming --emit', named.status === 2 && /builds the whole project/.test(named.out) && /--emit/.test(named.out), named.out)
}

// ---- packages/manifest: a field no tool reads is warned about ----
{
  const inert = mkdtempSync(join(tmpdir(), 'term-inert-'))
  mkdirSync(join(inert, 'code'))
  writeFileSync(join(inert, 'deck.tree'), 'deck @probe/inert\n  mark <0.0.1>\n  test ./test\n  book ./note\n')
  writeFileSync(join(inert, 'code/base.tree'), 'task one\n  like number\n  send back, 1\n')

  const linted = term(inert, 'lint')

  ok('`term lint` warns on `test` and `book` in a manifest, at their lines', /`test` in a manifest is read by nothing/.test(linted.out) && /`book` in a manifest is read by nothing/.test(linted.out) && /deck\.tree:3/.test(linted.out), linted.out)

  const fresh = mkdtempSync(join(tmpdir(), 'term-inert-wake-'))
  term(fresh, 'wake')

  ok('and a new project has none', !/manifest-inert|read by nothing/.test(term(fresh, 'lint').out), readFileSync(join(fresh, 'deck.tree'), 'utf8'))
}

// ---- tests/backends: `term hold --cross` ----
{
  const crossed = mkdtempSync(join(tmpdir(), 'term-cross-'))
  mkdirSync(join(crossed, 'code'))
  mkdirSync(join(crossed, 'test'))
  writeFileSync(join(crossed, 'deck.tree'), 'deck @probe/cross\n  mark <0.0.1>\n')
  writeFileSync(join(crossed, 'code/unused.tree'), 'task square\n  take n, like number\n  like number\n  save spare, 1\n  send back, multiply(n, n)\n')
  writeFileSync(join(crossed, 'test/square.tree'), 'test <four>\n  want hold\n    call is-equal\n      call multiply\n        code 2\n        code 2\n      code 4\n')

  const agreed = term(crossed, 'hold', '--cross')

  ok('`term hold --cross` passes an unused `save` and a test file', agreed.status === 0 && /Every backend agrees/.test(agreed.out) && !/disagree|does not compile/.test(agreed.out), agreed.out)

  writeFileSync(join(crossed, 'code/broken.tree'), 'task broken\n  like number\n  send back, <x>\n')

  const refused = term(crossed, 'hold', '--cross')

  ok('a file that does not compile says so, at its own line', refused.status === 1 && /code\/broken\.tree does not compile/.test(refused.out) && /broken\.tree:3:/.test(refused.out), refused.out)
}

// ---- commands/wash: `boot` and `store` targets ----
{
  const washed = mkdtempSync(join(tmpdir(), 'term-wash-boot-'))
  writeFileSync(join(washed, 'deck.tree'), 'deck demo\n  mark <0.0.1>\n')

  for (const dir of ['.base/@cluesurf/term/boot/x', '.base/@cluesurf/term/client/y', 'build', 'work', 'host']) {
    mkdirSync(join(washed, dir), { recursive: true })
  }

  const boot = term(washed, 'wash', 'boot')

  ok(
    '`term wash boot` removes boot/, client/, build/ and work/, and leaves host/',
    boot.status === 0 && /Boot output removed/.test(boot.out) && !existsSync(join(washed, 'build')) && !existsSync(join(washed, 'work')) && !existsSync(join(washed, '.base/@cluesurf/term/boot')) && existsSync(join(washed, 'host')),
    boot.out,
  )

  // the machine-wide store, pointed somewhere harmless: its module cache goes, the installed decks beside it stay
  const home = mkdtempSync(join(tmpdir(), 'term-wash-store-'))
  mkdirSync(join(home, 'mill/v1'), { recursive: true })
  mkdirSync(join(home, 'blobs'))
  writeFileSync(join(home, 'index.json'), '{}')
  const nowhere = mkdtempSync(join(tmpdir(), 'term-wash-anywhere-'))
  const run = spawnSync('node', [LINE, 'wash', 'store'], { cwd: nowhere, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', TERM_CACHE_HOME: home } })
  const out = `${run.stdout}${run.stderr}`

  ok(
    '`term wash store` removes the shared module cache from anywhere, and keeps the installed decks',
    run.status === 0 && /Shared module cache removed/.test(out) && !existsSync(join(home, 'mill')) && existsSync(join(home, 'blobs')) && existsSync(join(home, 'index.json')),
    out,
  )
}

// ---- commands/look: a module that does not compile is listed, and says so ----
{
  const looked = mkdtempSync(join(tmpdir(), 'term-look-broken-'))
  mkdirSync(join(looked, 'code'))
  writeFileSync(join(looked, 'deck.tree'), 'deck demo\n  mark <0.0.1>\n')
  writeFileSync(join(looked, 'code/broken.tree'), 'task half\n  take n, like number\n\n  like number\n\n  back <not a number>\n')

  const run = term(looked, 'look', 'code/broken.tree')

  ok('`term look` on a module that does not compile lists it and says so', run.status === 0 && /does not compile, so its signatures are as written/.test(run.out) && /task\s+half/.test(run.out) && /term scan code\/broken\.tree/.test(run.out), run.out)
}

// ---- library/collections: `term boot` after a list read past its end stops the program ----
{
  const stopped = mkdtempSync(join(tmpdir(), 'term-boot-stop-'))
  mkdirSync(join(stopped, 'code'))
  writeFileSync(join(stopped, 'deck.tree'), 'deck @probe/stop\nmark <0.0.2>\nlink @term/base, mark <0.0.x>\n')
  writeFileSync(
    join(stopped, 'code/base.tree'),
    `load @term/base/list
  find get

load @term/base/console
  find log

task third
  take names, like list, like text
  like text
  back get(names, 2)

task boot
  save names, make list, <Ada>, <Grace>
  log third(names)
`,
  )

  const run = term(stopped, 'boot', 'code/base.tree')

  ok('`term boot` exits 1 when the program stops on a defect', run.status === 1 && /defect/.test(run.out), `${run.status} ${run.out.slice(-600)}`)

  // ---- commands/boot: `--out` on an entry with no commands, a sentence as its subject ----
  // the subject began `--out writes ...`, lowercase, the one item subject that did not start a sentence (2026-10-04)
  const out = term(stopped, 'boot', 'code/base.tree', '--out', 'host/x')

  ok(
    '`term boot --out` on an entry with no `hook` commands is refused, its subject a sentence',
    out.status === 1 && /✗ boot\s+An `--out` folder holds a command-line program, and this entry\s+declares no `hook`\s+commands/.test(out.out),
    out.out,
  )
}

console.log(`\nexit-codes: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
