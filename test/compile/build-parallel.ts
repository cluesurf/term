import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { compileProject } from '@term/call/code/make'
import { compileProjectParallel } from '@term/call/code/build-parallel'

// a few self-contained .tree files (no stdlib imports, so the project resolver only needs local files)
const FILES: Record<string,string> = {
  'add.tree': 'task add-two\n  take a, like number\n  take b, like number\n  like number\n  send back\n    call add\n      read a\n      read b\n',
  'point.tree': 'form point\n  link x, like number\n  link y, like number\n\ntask mag2\n  take p, like point\n  like number\n  send back\n    call add\n      call multiply\n        read p/x\n        read p/x\n      call multiply\n        read p/y\n        read p/y\n',
  'fib.tree': 'task fib\n  take n, like number\n  like number\n  fork test\n    hook test\n      call is-below\n        read n\n        code 2\n    hook hold\n      send back\n        read n\n    hook miss\n      send back\n        call add\n          call fib\n            call subtract\n              read n\n              code 1\n          call fib\n            call subtract\n              read n\n              code 2\n',
  'nested/util.tree': 'task triple\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      code 3\n',
}
function setup(): string {
  const root = mkdtempSync(join(tmpdir(),'seed-proj-'))
  for (const [rel, text] of Object.entries(FILES)) {
    const f = join(root, rel); mkdirSync(join(f,'..'), {recursive:true}); writeFileSync(f, text)
  }
  return root
}
function readHost(root: string): Record<string,string> {
  const out: Record<string,string> = {}
  const hostDir = join(root,'host')
  if (!existsSync(hostDir)) return out
  const walk = (d: string) => { for (const e of readdirSync(d,{withFileTypes:true})) { const p = join(d,e.name); if (e.isDirectory()) walk(p); else out[relative(hostDir,p)] = readFileSync(p,'utf8') } }
  walk(hostDir)
  return out
}
let pass=0, fail=0
function ok(n:string,c:boolean,info=''){ c?(pass++,console.log('ok    '+n)):(fail++,console.log('FAIL  '+n+'  '+info)) }
async function main(){
  const rootSeq = setup()
  const seqRes = compileProject(rootSeq)
  const seqOut = readHost(rootSeq)
  const rootPar = setup()
  const parRes = await compileProjectParallel(rootPar, { concurrency: 3 })
  const parOut = readHost(rootPar)
  ok('same compiled count', seqRes.compiled === parRes.compiled, `seq ${seqRes.compiled} par ${parRes.compiled}`)
  ok('same failed count', seqRes.failed === parRes.failed, `seq ${seqRes.failed} par ${parRes.failed}`)
  const seqKeys = Object.keys(seqOut).sort().join(',')
  const parKeys = Object.keys(parOut).sort().join(',')
  ok('same set of output files', seqKeys === parKeys, `\n  seq: ${seqKeys}\n  par: ${parKeys}`)
  let identical = true
  for (const k of Object.keys(seqOut)) { if (seqOut[k] !== parOut[k]) { identical = false; console.log('  DIFF in '+k) } }
  ok('byte-identical output to sequential', identical && seqKeys===parKeys)
  console.log('  files compiled:', seqRes.compiled, '| seq errors:', seqRes.errors.length, '| par errors:', parRes.errors.length)
  if (seqRes.errors.length) console.log('  seq errors:', seqRes.errors)
  if (parRes.errors.length) console.log('  par errors:', parRes.errors)
  rmSync(rootSeq,{recursive:true,force:true}); rmSync(rootPar,{recursive:true,force:true})
  console.log(`\nparallel-build: ${pass} pass, ${fail} fail`)
  process.exit(0)
}
main()
