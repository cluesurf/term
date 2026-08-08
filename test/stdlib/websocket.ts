import { compile } from '@term/make/code/compile/compile'
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'; import { join } from 'node:path'; import { pathToFileURL } from 'node:url'
import * as http from 'node:http'; import * as crypto from 'node:crypto'; import type { Duplex } from 'node:stream'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
const baseTree=join(process.cwd(),'deck','base')
const STDLIB_PREFIX=/^@(?:cluesurf|term)\/seed\//
const stdlib=(p:string):any=>{if(!STDLIB_PREFIX.test(p))return undefined;const f=join(baseTree,p.replace(STDLIB_PREFIX,'')+'.tree');return existsSync(f)?{file:f,text:readFileSync(f,'utf8')}:undefined}
const readRuntime=(p:string):any=>{if(existsSync(p))return readFileSync(p,'utf8');if(!STDLIB_PREFIX.test(p))return undefined;const f=join(baseTree,p.replace(STDLIB_PREFIX,''));return existsSync(f)?readFileSync(f,'utf8'):undefined}
// minimal raw WebSocket echo server (handshake + unmask client text frame + echo unmasked)
function wsEcho(port:number):http.Server{
  const srv=http.createServer()
  srv.on('upgrade',(req,sock:Duplex)=>{
    const key=req.headers['sec-websocket-key'] as string
    const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n')
    sock.on('data',(buf:Buffer)=>{
      const len=buf[1]&0x7f; if(len>=126) return
      const mask=buf.subarray(2,6); const payload=Buffer.from(buf.subarray(6,6+len))
      for(let i=0;i<payload.length;i++) payload[i]^=mask[i%4]
      sock.write(Buffer.concat([Buffer.from([0x81,payload.length]),payload]))
    })
  })
  return srv
}
const SRC=`load @cluesurf/seed/code/network/websocket
  find connect

task echo
  note async
  take url, like text
  take message, like text
  like text
  save ws
    call connect
      read url
      wait true
  call send
    read ws
    read message
    wait true
  save reply
    call receive
      read ws
      wait true
  call close
    read ws
    wait true
  send back
    read reply/data
`
// WebSocket test: a Seed websocket client (connect / send / receive / close) against a minimal raw WS echo server,
// compiled from base.tree and run. Proves network/websocket works end to end over node global WebSocket.
// Run: npx tsx test/stdlib/websocket.ts
async function main(){
  const srv=wsEcho(8761); await new Promise<void>(r=>srv.listen(8761,'127.0.0.1',r))
  const r:any=compile({file:'main.tree',text:SRC},{resolve:withNativeEnv('node',stdlib)})
  if(!r.ok){console.log('COMPILE FAIL',JSON.stringify([...new Set(r.diagnostics?.map((d:any)=>d.message))].slice(0,5)));srv.close();return}
  const ts=nativePrelude(r.program,'node',readRuntime)+'\n'+r.typescript
  const dir=mkdtempSync(join(tmpdir(),'ws-'));const f=join(dir,'m.ts');writeFileSync(f,ts)
  const m:any=await import(pathToFileURL(f).href)
  let pass=0,fail=0; const eq=(n:string,g:any,w:any)=>{const ok=g===w;ok?pass++:fail++;console.log((ok?'ok   ':'FAIL ')+n+' = '+JSON.stringify(g))}
  try { eq('websocket connect/send/receive round-trip', await m.echo('ws://127.0.0.1:8761','hello-ws'), 'hello-ws') }
  finally { srv.close() }
  console.log('\nnetwork/websocket: '+pass+' pass, '+fail+' fail')
}
main()
