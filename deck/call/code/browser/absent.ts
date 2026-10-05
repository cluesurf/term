// The Node builtins the browser compile NAMES and never calls (build.mjs aliases each one here). A module on the
// compile path imports one at its top for something the worker never reaches, so the import has to resolve, and
// what it hands back throws the moment it is called.
//
// ONLY THE NAMES THE CLOSURE ACTUALLY IMPORTS ARE HERE, on purpose. A new Node import on the compile path then fails
// the bundle with esbuild's "No matching export", naming the file, instead of shipping a stub nobody looked at.
//
//   fileURLToPath   make/code/resolve.ts `stdlibBase`, read only when TERM_STDLIB is unset, and the bundle sets it

function absent(name: string): () => never {
  return () => {
    throw new Error(`\`${name}\` is a Node builtin, and the browser compile has no Node`)
  }
}

export const fileURLToPath = absent('fileURLToPath')

export default { fileURLToPath }
