import { readFileSync } from 'node:fs'
import { compile } from '@cluesurf/make/code/compile/compile'
import { projectResolver } from '@cluesurf/call/code/make'
const HOME = '/Users/lancepollard/base/crew/cluesurf/mesh/site/clue.surf/home2'
const INSTALL = '/Users/lancepollard/base/crew/cluesurf/deck/seed/deck/seed'
const resolve = projectResolver(HOME, 'browser', INSTALL)
const file = HOME + '/site/page/legal/privacy.tree'
const r = compile({ file, text: readFileSync(file,'utf8') }, { resolve, env: 'browser' })
if (r.ok) console.log('OK')
else console.log(JSON.stringify(r.diagnostics[0], (k,v)=> k==='type'?undefined:v, 2).slice(0,1500))
