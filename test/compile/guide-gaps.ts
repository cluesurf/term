// Phase 1 of note/term/gaps/plan.md: programs the term.surf guides showed building clean and then behaving wrongly.
// Each block is the guide's own sample, held two ways where it can be: the wrong behavior is gone, and the right one
// (or a refusal that names the problem) is there. Where behavior is the point, the emitted TypeScript is run.
//
// Run: npx tsx test/compile/guide-gaps.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '@term/make/code/compile/compile'

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

type Built = { ok: boolean; typescript: string; messages: string; names: string[]; warnings: string[] }

function build(text: string, file = '/gate/code/gap.tree'): Built {
  const out = compile({ file, text })
  const warnings = ((out as { warnings?: { name: string; message: string }[] }).warnings ?? []).map(
    w => `${w.name}: ${w.message}`,
  )

  return out.ok
    ? { ok: true, typescript: out.typescript, messages: '', names: [], warnings }
    : {
        ok: false,
        typescript: '',
        messages: out.diagnostics.map(d => d.message).join(' | '),
        names: out.diagnostics.map(d => d.name),
        warnings,
      }
}

// the emitted module, imported, so its exports can be called
async function load(typescript: string): Promise<Record<string, (...args: unknown[]) => unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'term-guide-gaps-'))
  const file = join(dir, 'module.ts')
  writeFileSync(file, typescript)

  return (await import(pathToFileURL(file).href)) as Record<string, (...args: unknown[]) => unknown>
}

async function main(): Promise<void> {
  // ---- language/loops: nested `walk size` loops each keep their own counter ----
  {
    const built = build(`task grid
  take n, like number
  like number
  save total, code 0
  walk size
    bind base, code 0
    bind head, read n
    hook next
      walk size
        bind base, code 0
        bind head, read n
        hook next
          save total
            call add
              read total
              code 1
  send back, read total
`)
    ok('two nested walk size loops build', built.ok, built.messages)

    if (built.ok) {
      const mod = await load(built.typescript)
      ok('and the outer loop ends, having run the inner one n times each turn', mod.grid!(4) === 16)
    }
  }

  // ---- language/loops: a `take` beside the `bind` lines names the counter ----
  {
    const built = build(`task sum-to
  take n, like number
  like number
  save total, code 0
  walk size
    take j
    bind base, code 0
    bind head, read n
    hook next
      save total
        call add
          read total
          read j
  send back, read total
`)
    ok('a take beside the bind lines names the counter', built.ok, built.messages)

    if (built.ok) {
      const mod = await load(built.typescript)
      ok('and the body reads it', mod.sumTo!(5) === 10)
    }
  }

  console.log(`\nguide-gaps: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

void main()
