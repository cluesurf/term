import { execFileSync } from 'node:child_process'
import { parse } from '@/code/parser/tree'
import { mill } from '@/code/compile/mill'
import { resolve as resolveNames } from '@/code/check/resolve'
import { check } from '@/code/check/infer'
import { collectModules } from '@/code/compile/load'
import { emitSwift } from '@/code/compile/swift'
import { withNativeEnv, nativePrelude } from '@/code/compile/native'
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const baseTree = join(process.cwd(), '..', 'base.tree')
const stdlib = (p: string) => { const pre = '@cluesurf/base/'; if (!p.startsWith(pre)) return undefined; const f = join(baseTree, p.slice(pre.length) + '.tree'); return existsSync(f) ? { file: f, text: readFileSync(f, 'utf8') } : undefined }
const readRuntime = (p: string) => { const pre = '@cluesurf/base/'; if (!p.startsWith(pre)) return undefined; const f = join(baseTree, p.slice(pre.length)); return existsSync(f) ? readFileSync(f, 'utf8') : undefined }
const text = `load @cluesurf/base/code/network/http\n  find get\n\ntask compute\n  mark async\n  like text\n  send back\n    save r\n      call get\n        text <http://127.0.0.1:9000/>\n        wait true\n    read r/body\n`
const sources = collectModules({ file: 'main.tree', text }, withNativeEnv('swift', stdlib)).sources
const program: any = []
for (const u of sources) { const p = parse(u); const b = mill((p as any).tree, u.file); program.push(...(b as any).program) }
resolveNames(program, 'main.tree'); check(program, 'main.tree')
const dir = mkdtempSync(join(tmpdir(), 'httpc-'))
const file = join(dir, 'm.swift')
writeFileSync(file, `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(program)}\nprint(await compute(), terminator: "")\n`)
try { execFileSync('swiftc', ['-o', join(dir, 'm'), file], { stdio: 'pipe' }); console.log('SWIFT OK') }
catch (e: any) { console.log(String(e.stderr ?? e).slice(0, 1200)) }
