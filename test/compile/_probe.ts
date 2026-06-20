import { compile } from '@/code/compile/compile'

// `#` markdown comments where `note <...>` docs used to sit: module top, before a task, inside a form, before a field.
const SRC = `# A module-level **markdown** comment (was a note).

# This documents the point form.
form point
  # the x coordinate
  link x, like number
  link y, like number

# Compute something.
task compute
  like number
  send back
    code 5
`
const r = compile({ file: 'c.tree', text: SRC }, {})
console.log(r.ok ? 'OK: # comments parse everywhere' : 'ERR ' + JSON.stringify(r.diagnostics?.slice(0, 3)))
