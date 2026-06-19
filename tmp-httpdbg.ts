import { parse } from '@/code/parser/tree'
import { mill } from '@/code/compile/mill'
import { resolve as resolveNames } from '@/code/check/resolve'
import { check } from '@/code/check/infer'
import { collectModules } from '@/code/compile/load'
import { emitSwift } from '@/code/compile/swift'
import { emitKotlin } from '@/code/compile/kotlin'
import { withNativeEnv } from '@/code/compile/native'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
const baseTree = join(process.cwd(), '..', 'base.tree')
const stdlib = (p: string) => { const pre = '@cluesurf/base/'; if (!p.startsWith(pre)) return undefined; const f = join(baseTree, p.slice(pre.length) + '.tree'); return existsSync(f) ? { file: f, text: readFileSync(f, 'utf8') } : undefined }
const text = `load @cluesurf/base/code/network/http\n  find get\n\ntask compute\n  mark async\n  like text\n  send back\n    save r\n      call get\n        text <http://127.0.0.1:9000/>\n        wait true\n    read r/body\n`
function build(env: 'swift' | 'kotlin') {
  const sources = collectModules({ file: 'main.tree', text }, withNativeEnv(env, stdlib)).sources
  const program: any = []
  for (const u of sources) { const p = parse(u); const b = mill((p as any).tree, u.file); program.push(...(b as any).program) }
  resolveNames(program, 'main.tree'); check(program, 'main.tree')
  return program
}
console.log('=== SWIFT ===')
console.log(emitSwift(build('swift')).split('\n').filter((l: string) => /HttpResponse|func (get|request|compute)|struct/.test(l)).join('\n'))
console.log('=== KOTLIN ===')
console.log(emitKotlin(build('kotlin')).split('\n').filter((l: string) => /HttpResponse|fun (get|request|compute)|class/.test(l)).join('\n'))
