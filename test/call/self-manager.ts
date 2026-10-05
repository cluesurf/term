// `term self` names the package manager that owns a copy (deck/call/code/self.ts `managerOf`), by where that manager
// puts the payload: Homebrew's Cellar or Caskroom, winget's package folder for ClueSurf.Term, and /usr/lib/term for
// the .deb and the .rpm task/distro.ts makes, told apart by whether dpkg has a record of the package.
// Run: npx tsx test/call/self-manager.ts
import { managerOf } from '@term/call/code/self'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

const cases: [string, string, boolean, string | undefined][] = [
  ['a Homebrew formula', '/opt/homebrew/Cellar/term/2.7.0/libexec/term', false, 'homebrew'],
  ['a Homebrew cask', '/opt/homebrew/Caskroom/term/2.7.0/term', false, 'homebrew'],
  ['the .deb', '/usr/lib/term', true, 'apt'],
  ['the .rpm', '/usr/lib/term', false, 'dnf'],
  ['winget', 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Packages\\ClueSurf.Term_Microsoft.Winget.Source_8wekyb3d8bbwe\\term', false, 'winget'],
  ['a source checkout', '/Users/a/term/deck/term', false, undefined],
  ['a folder only named like the system one', '/usr/lib/term-old', true, undefined],
  ['another winget package', 'C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Other.Term_x\\term', false, undefined],
]

for (const [name, payload, dpkg, want] of cases) {
  const got = managerOf(payload, dpkg)

  ok(`${name}: ${want ?? 'no manager'}`, got === want, String(got))
}

console.log(`\nself-manager: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
