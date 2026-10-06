// Which cask answers a device module natively, and which defers to its WebView (device-layer-0013, -0014). A cask
// built for macos, ios or android resolves `@term/site/view/hosted` to the toolkit's answer, true; one built for rust
// (Linux and Windows) to the fallback's, false. The device app's generated bridge then carries the rule both ways: the
// dispatcher answers `unhosted` where there is no host, and the page's shim asks its WebView only on `unhosted`, never
// on a host's own `unavailable`. Needs no toolchain and no machine. Run: npx tsx test/compile/cask-device-host.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { collectModules } from '@term/make/code/compile/load'
import { projectResolver } from '@term/call/code/make'

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

const ROOT = process.cwd()
const PROGRAM = 'load @term/site/view/hosted\n  find has-device-host\n\ntask main\n  call has-device-host\n'

// the hosted module each env's resolution reached, by its folder
function hostedFor(env: string): string {
  const sources = collectModules({ file: join(ROOT, 'tmp/cask-device-host.tree'), text: PROGRAM }, projectResolver(ROOT, env as never)).sources
  const found = sources.map(one => one.file).find(file => /\/view\/native\/(?:[a-z-]+\/)?hosted\.tree$/.test(file)) ?? ''

  return /\/native\/toolkit\/hosted\.tree$/.test(found) ? 'toolkit' : /\/native\/hosted\.tree$/.test(found) ? 'fallback' : `none (${found})`
}

for (const env of ['macos', 'ios', 'android']) {
  ok(`a cask built for ${env} has the device hosts`, hostedFor(env) === 'toolkit', hostedFor(env))
}

ok('a cask built for rust has none, so its page asks the WebView', hostedFor('rust') === 'fallback', hostedFor('rust'))

const SITE = join(ROOT, 'deck/site/code/view/native/webview')
const dispatch = readFileSync(join(ROOT, 'deck/cask/test/device/dispatch.tree'), 'utf8')
ok('the device dispatcher answers unhosted where there is no host', dispatch.includes('task device-answer') && dispatch.includes('text <unhosted>') && dispatch.includes('call has-device-host'))

for (const shim of ['battery', 'clipboard', 'vibration']) {
  const text = readFileSync(join(SITE, `${shim}.tree`), 'utf8')
  ok(`the ${shim} shim asks its WebView on unhosted, and never on unavailable`, text.includes('text <unhosted>') && !text.includes('text <unavailable>'))
}

console.log(`\ncask-device-host: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
