# {3,4,3,4} lattice render

Viewable output of the vibe-computer lattice view (`../vibe.tree`). The 24-cell, the D4 coin of 24 directions, drawn as its **F4 Coxeter-plane shadow**: two concentric dodecagons, 96 edges, twelve-fold symmetric. Fully deterministic.

## What's here

- **`lattice.png`** - rasterized preview. Open it to see the shadow.
- **`lattice.svg`** - the same drawing as scalable vector. Open in any browser or editor.
- **`index.html`** - the **live WebGL2 render**. Open in a browser. It runs the exact call sequence `../vibe.tree` compiles to (`createShader -> shaderSource -> compileShader -> createProgram -> attachShader -> linkProgram -> createBuffer -> bufferData -> drawArrays(LINES)`).
- **`lattice.data.js`** - the baked geometry (vertices, edge count, shader sources) that `index.html` reads.

## Source of truth

The geometry lives in `../runtime/lattice.ts`. It builds the 24 vertices (every permutation of `(±1,±1,0,0)`), the 96 nearest-neighbor edges (Euclidean distance `√2`), and the Coxeter-plane projection via the F4 Coxeter element (order 12). The `.tree` render, the SVG, and the HTML all draw the same numbers.

To regenerate after changing the geometry, re-run the export that emits `lattice.svg` and `lattice.data.js` from `../runtime/lattice.ts`.

## To view

Open `index.html` for the live GPU render, or `lattice.png` / `lattice.svg` for the static drawing. Hosting on code.surf serves `index.html` (compiled from `../vibe.tree`) the same way.
