Was `draft.tree`, whose mere presence shelves the whole directory regardless of content
(`deck/call/code/make.ts`'s `existsSync(path.join(full, 'draft.tree'))`). Renamed out of the way, not deleted,
now that `glyf` has real code for simple glyphs — see `form.tree`/`code.tree` and
`note/term/feed/07-implementation.md`. Composite glyphs stay explicitly unsupported (`otf-glyph-composite-
unsupported`), the same deliberate-scope pattern `cmap` uses for formats it doesn't decode.
