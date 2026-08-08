import { compile } from '@term/make/code/compile/compile'
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
const baseTree=join(process.cwd(),'deck','seed')
const STDLIB_PREFIX=/^@(?:cluesurf|term)\/seed\//
const stdlib=(p:string):any=>{if(!STDLIB_PREFIX.test(p))return undefined;const f=join(baseTree,p.replace(STDLIB_PREFIX,'')+'.tree');return existsSync(f)?{file:f,text:readFileSync(f,'utf8')}:undefined}
const readRuntime=(p:string):any=>{if(existsSync(p))return readFileSync(p,'utf8');if(!STDLIB_PREFIX.test(p))return undefined;const f=join(baseTree,p.replace(STDLIB_PREFIX,''));return existsSync(f)?readFileSync(f,'utf8'):undefined}
// URL parsing test: compile the real base.tree url module and run it, asserting the parsed components and relative
// resolution. Native URL delegation (one expression per backend, no shim). Run: npx tsx test/stdlib/url.ts
async function main(){
  const text=readFileSync('deck/seed/code/url.tree','utf8')
  const r:any=compile({file:'main.tree',text},{resolve:withNativeEnv('node',stdlib)})
  if(!r.ok){console.log('FAIL',JSON.stringify([...new Set(r.diagnostics?.map((d:any)=>d.message))].slice(0,5)));return}
  const ts=nativePrelude(r.program,'node',readRuntime)+'\n'+r.typescript
  const dir=mkdtempSync(join(tmpdir(),'url-'));const f=join(dir,'m.ts');writeFileSync(f,ts)
  const m:any=await import(pathToFileURL(f).href)
  let pass=0,fail=0; const eq=(n:string,g:any,w:any)=>{const ok=g===w;ok?pass++:fail++;console.log((ok?'ok   ':'FAIL ')+n+' = '+JSON.stringify(g)+(ok?'':' (want '+JSON.stringify(w)+')'))}
  const u=m.makeUrl('https://example.com:8080/a/b?x=1&y=2#top','http://localhost')
  eq('scheme', m.urlScheme(u), 'https')
  eq('host', m.urlHost(u), 'example.com')
  eq('port', m.urlPort(u), '8080')
  eq('path', m.urlPath(u), '/a/b')
  eq('query', m.urlQuery(u), 'x=1&y=2')
  eq('fragment', m.urlFragment(u), 'top')
  const rel=m.makeUrl('/users?id=1','http://localhost')
  eq('relative path', m.urlPath(rel), '/users')
  eq('relative query', m.urlQuery(rel), 'id=1')
  console.log('\nurl: '+pass+' pass, '+fail+' fail')
}
main()
