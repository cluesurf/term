```
clue.surf
  /book/*
  /@:host
    /:deck
```

```
hook /, show note
  hook /love, show love
    # Values, mission, and brand
  hook /land, show land
    hook /code, show land-code
    hook /home, show land-home
  hook /find, show find
  hook /show, show show
    hook /:make, show show-make
  hook /host/:host, task link-host
    hook /deck, show host-deck
    hook /like, show host-like
    hook /lead, show host-lead
    hook /save, show host-save
      hook /bill, show host-save-bill
        hook /lead, show host-save-bill-lead
      hook /lock, show host-save-lock
        hook /lead, show host-save-lock-lead
      hook /face, show host-save-face
        hook /lock, show host-save-face-lock
  hook /@:host, show host
    hook /:deck, show deck
      hook /tree, task link-head-tree
        hook /:tree, show deck-tree
          hook /show, task link-head-deck-tree-file-show-read
            hook /:file+, show deck-tree-file-show
          hook /make, task link-head-deck-tree-file-make-read
            hook /:file+, show deck-tree-file-make
      hook /save, show deck-save
        hook /face, show deck-save-face
        hook /lock, show deck-save-lock
        hook /tool, show deck-save-tool
      hook /view, show deck-view
        hook /base, show deck-view-base
      hook /face, show deck-face
        hook /:face, show deck-face-face
  hook /dock, show dock
  hook /lock, show lock
    hook /:site, task lock-site
      hook /back, task lock-site-back
  hook /code, show code
    hook /lock, show code-lock
    hook /term, show code-term
    hook /void, show code-void
  hook /void, task link-void
  hook /read, show read
    hook /:read+, show read-leaf
  hook /call, show call
    hook /:call+, show call-leaf
  hook /note, show note
    hook /:note+, show note-leaf
  hook /make, show make
    hook /:make+, show make-leaf
      note <Jobs>
fork hack, note <Place where you can have code pens>
  hook /@:host
    hook /:hash
      hook /tree
        hook /:file+
      hook /show, note <The rendered form>

https://hack.tree.surf/@user/12321321233123
```
