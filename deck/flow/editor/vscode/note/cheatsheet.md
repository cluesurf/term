# Seed extension — test cheatsheet

Copy each snippet into a `.tree` file in the Extension Development Host (F5), then do the action and check the result. Work top to bottom.

---

## 1. Highlighting

```
task double
  take value, like number
  like number
  send back
    call add
      read value
      read value
```

**Check:** `task` / `take` / `like` / `send back` / `call` / `read` are keyword-colored, `number` is a type, the bare name `double` is a function name. No red squiggles.

---

## 2. Comments are markdown (`#`)

```
# This is a **markdown** comment.
task noop
  send back
    code 0
```

**Check:** the `#` line is comment-colored.

---

## 3. Diagnostics — type mismatch

```
task wrong
  take flag, like boolean
  like number
  send back
    call add
      read flag
      code 1
```

**Check:** red squiggle under `read flag` (a `boolean` where a `number` is expected). Hover the squiggle → the error message. Delete `read flag`, replace with `code 2` → squiggle clears live.

---

## 4. Diagnostics — unknown name

```
task oops
  send back
    read missing
```

**Check:** squiggle under `missing` ("unknown name" / "did you mean…").

---

## 5. Hover — inferred type

```
task box-area
  take side, like number
  like number
  send back
    call multiply
      read side
      read side
```

**Action:** hover `side`, then hover the whole `call multiply ...`.
**Check:** popover shows `number` for `side`, and the call's result type. Hovering `box-area` (the definition) shows its full signature.

---

## 6. Completion — scope + keywords

```
task greet
  take name, like number
  take count, like number
  like number
  send back
    
```

**Action:** put the cursor on the indented empty line and type `re`.
**Check:** completion lists `read` (keyword) and in-scope `name`, `count`. Accepting inserts the name.

---

## 7. Completion — members after `/`

```
form point
  link x, like number
  link y, like number

task get-x
  take p, like point
  like number
  send back
    read p/
```

**Action:** type after `read p/`.
**Check:** completion offers `x` and `y` (the record's fields, each showing its type), and nothing else. A form's methods appear here too.

---

## 8. Completion — keyword snippets

**Action:** on a blank line, type `task` and accept the completion.
**Check:** it expands to a full skeleton with tab stops:

```
task name
  take arg, like type
  like type
  send back
    
```

`form`, `mask`, `fork`, and `walk` expand similarly.

---

## 8b. Completion — import path + exports

```
load @cluesurf/base/code/
```

**Action:** type after the trailing `/`.
**Check:** completion lists the stdlib modules (`text`, `list`, `number`, …). Pick `text`, add an indented `find ` line, and trigger completion → it lists `text`'s definitions (`split`, `to-upper-case`, …).

---

## 9. Go to definition (same file and across files)

```
task square
  take n, like number
  like number
  send back
    call multiply
      read n
      read n

task use-it
  take n, like number
  like number
  send back
    call square
      read n
```

**Action:** F12 (Go to Definition) on `square` inside `use-it`.
**Check:** jumps to the `task square` definition.

**Cross-file:** in a file that does `load @cluesurf/base/code/text` / `find to-upper-case` and then `call to-upper-case`, F12 on the call jumps into `deck/base/code/text.tree` at the `task to-upper-case` definition. Works for an imported `task`, `form`, or `mask` alike.

---

## 10. Find references

**Action:** in the snippet above, Shift+F12 on `square` (either the definition or the call).
**Check:** lists both the definition and the call site.

---

## 11. Rename

**Action:** F2 on `square`, type `area`.
**Check:** every `square` (definition + call) becomes `area` in one edit.

---

## 12. Document symbols / outline

```
form point
  link x, like number

mask sizer
  task measure
    take self
    like number

task main-thing
  send back
    code 0
```

**Action:** Cmd/Ctrl+Shift+O.
**Check:** outline lists `point`, `sizer`, `main-thing` with the right kinds (struct / interface / function).

---

## 13. Signature help

```
task add-three
  take a, like number
  take b, like number
  take c, like number
  like number
  send back
    call add
      read a
      read b

task run
  like number
  send back
    call add-three
      
```

**Action:** with the cursor in `call add-three`'s argument area, trigger signature help (it pops automatically, or Cmd/Ctrl+Shift+Space).
**Check:** shows `add-three(a: number, b: number, c: number)` with the current argument highlighted. Works for imported functions too.

---

## 14. Completion — argument-type ranking

```
task double
  take value, like number
  like number
  send back
    call add
      read value
      read value

task use
  take amount, like number
  take label, like text
  like number
  send back
    call double
      a
```

**Action:** in `call double`'s argument, type `a` and look at the completion order.
**Check:** `amount` (a `number`, the expected type) ranks above `label` (a `text`).

---

## 15. Auto-import (code action)

```
task shout
  take m, like text
  like text
  send back
    call to-upper-case
      read m
```

**Action:** `to-upper-case` is undefined (red squiggle). Open the lightbulb / Quick Fix (Cmd/Ctrl+`.`) on it.
**Check:** offers **"Import to-upper-case from @cluesurf/base/code/text"**. Applying it inserts `load @cluesurf/base/code/text` / `find to-upper-case` (added under an existing `load` of that module if one is present), and the squiggle clears.

---

## 16. Code lens — reference counts

**Action:** open any file with a few `task` / `form` / `mask` definitions.
**Check:** a small `N references` lens sits above each definition.

---

## 17. Inlay hints — inferred types

```
task demo
  like number
  save x
    code 5
  send back
    read x
```

**Check:** an inline `: number` hint appears after `x` (an un-annotated binding). A binding written `save x, like number` shows no hint.

---

## 18. Semantic tokens — precise coloring

**Action:** open any file (semantic highlighting is automatic).
**Check:** identifiers are colored by meaning — a `task` name as a function, a `form` as a type, a `mask` as an interface, parameters and locals distinctly — beyond what the TextMate grammar alone can tell apart.

---

## Working now (everything)

Highlighting, diagnostics, **rich markdown hover** (signatures + types), completion (**scope, members after `/`, keyword snippets, imported callables, import-path, exports, argument-type ranking**), go-to-definition (**same file and cross-file**), find references, rename, document symbols (**document-scoped — no import leak**), signature help (**incl. imported functions**), the **auto-import code action**, **code lens** reference counts, **inlay hints** for inferred types, and **semantic tokens**. Stdlib imports resolve. The server is incremental (warm per-document, re-checks only changed definitions) so it stays live on every keystroke.

## Beyond this sheet

- **Workspace-wide references / rename** — today they are correct but single-file; searching uses across *other* files is a later phase.

All tracked in `note/seed/language-server-plan.md`.
