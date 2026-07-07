// Root vitest config: each deck that carries vitest tests runs as its own project, under its OWN config, so
// per-package aliases (deck/deck's `@` -> code/) resolve and compiled artifacts under host/ are never collected.
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    projects: ['deck/deck/vitest.config.ts'],
  },
})
