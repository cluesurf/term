// Does a .tree file shelve itself? One answer for the build walk (make.ts), the test runner (test.ts) and every
// command that walks files (files.ts), so the three cannot disagree.
//
// A file is shelved by a TOP-LEVEL `mark draft` line, anywhere in it (`note draft` is the old spelling and still
// counts). It used to be found only in the first 2,000 characters, so a file whose leading comment ran longer shipped
// as code with its marker unread (guides: language/notes, 2026-10-03). An indented `mark draft` belongs to the
// definition it sits under, not to the file.

const DRAFT = /^(mark|note) draft\s*$/m

export function declaresDraft(text: string): boolean {
  return DRAFT.test(text)
}
