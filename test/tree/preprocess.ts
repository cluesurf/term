// The `test` preprocessor now lives in the compiler tree (reusable by the `seed test` CLI). This re-exports it so the
// dev harness (test/tree/run.ts) keeps working. See code/call/test-preprocess.ts and note/library/seed/test-dsl.md.
export { preprocessTests } from '@cluesurf/call/code/test-preprocess'
export type { Preprocessed } from '@cluesurf/call/code/test-preprocess'
