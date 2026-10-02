// The face component contract (native-dom-0009, 0011, 0025). A component the author writes once has a GENERIC
// implementation (`face/code/component/native/<name>.tree`, the abstract fallback) and may have one per platform rung
// (`native/toolkit/<name>.tree`, ...). The contract is the generic one's props: every platform implementation must take
// exactly the same names, in the same order, at the same types, so an author's `view <name> / bind ...` means the same
// thing on every platform. An APP may shadow one at the same relative path in its own package (projectResolver), and
// is held to the same contract. Read through the compiler's own parser and mill, never a second reader of `.tree`.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { expandTemplates } from '@term/make/code/compile/template'
import type { Type } from '@term/make/code/compile/node'

// where face's implementations live, relative to a package root; an app's shadows live at the same path in the app
export const FACE_NATIVE_PATH = 'code/component/native'

// a type as one comparable string
function typeText(type: Type | undefined): string {
  return type === undefined ? '(inferred)' : JSON.stringify(type, (key, value) => (key === 'span' ? undefined : value))
}

// the props of `view <name>` in a file, as `name: type`, in order, or undefined when the file declares no such view
export function propsOf(file: string, text: string, name: string): string[] | undefined {
  const parsed = parse({ file, text })

  if (!parsed.ok) {
    return undefined
  }

  const built = mill(expandTemplates(parsed.tree), file)

  if (!built.ok) {
    return undefined
  }

  const view = built.program.find(node => node.form === 'view' && node.name === name)

  return view?.form === 'view' ? view.params.map(param => `${param.name}: ${typeText(param.type)}`) : undefined
}

export type ContractFinding = { component: string; rung: string; file: string; problem: string }

// every platform implementation under `nativeDir` (a package's `code/component/native`) against the generic
// implementation of the same component in `faceNativeDir`. For face itself the two are the same directory; for an app
// they are the app's shadows against face's generics. An app shadow of a component face has no generic for is a
// finding too: there is no contract to hold it to, so it shadows nothing.
export function contractFindings(faceNativeDir: string, nativeDir: string = faceNativeDir): ContractFinding[] {
  const findings: ContractFinding[] = []

  if (!existsSync(nativeDir)) {
    return findings
  }

  const rungs = readdirSync(nativeDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)

  for (const rung of rungs) {
    for (const file of readdirSync(join(nativeDir, rung)).filter(name => name.endsWith('.tree'))) {
      const component = file.replace(/\.tree$/, '')
      const path = join(nativeDir, rung, file)
      const genericFile = join(faceNativeDir, `${component}.tree`)

      if (!existsSync(genericFile)) {
        findings.push({ component, rung, file: path, problem: `face has no generic ${component} to take its contract from` })
        continue
      }

      const contract = propsOf(genericFile, readFileSync(genericFile, 'utf8'), component)

      if (!contract?.length) {
        findings.push({ component, rung, file: genericFile, problem: `the generic ${component} declares no props` })
        continue
      }

      const props = propsOf(path, readFileSync(path, 'utf8'), component)

      if (JSON.stringify(props) !== JSON.stringify(contract)) {
        findings.push({
          component,
          rung,
          file: path,
          problem: `takes ${JSON.stringify(props ?? null)}, the contract is ${JSON.stringify(contract)}`,
        })
        continue
      }

      // an untyped prop reaches Swift and Kotlin as whatever inference guesses, which was `Void`
      const untyped = props!.filter(prop => prop.endsWith('(inferred)'))

      if (untyped.length) {
        findings.push({ component, rung, file: path, problem: `untyped props ${untyped.join(', ')}` })
      }
    }
  }

  return findings
}
