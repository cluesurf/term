// The one grammar record this process reads manifests, roles and lockfiles with (the original mill.ts's module
// variables, grammar-reading.tree's mark-shared manifest-grammars, term-cli-in-term-0075), and a Term refusal raised
// as the Error the originals threw. Shared by the package faces (term-cli-in-term-0115). It reaches only
// grammar-reading.tree, so the browser worker's role reader (call/code/browser/build.mjs) bundles no Node module.
import * as grammarReading from '@term/deck/code/package/grammar-reading'

export const GRAMMARS = grammarReading.makeGrammars()

export async function refused<T>(
  run: () => T | Promise<T>,
): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const note = (error as { note?: unknown }).note

    throw typeof note === 'string' ? new Error(note) : error
  }
}

export function refusedNow<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    const note = (error as { note?: unknown }).note

    throw typeof note === 'string' ? new Error(note) : error
  }
}
