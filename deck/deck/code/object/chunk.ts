/**
 * Content-defined chunking (FastCDC) for the object registry.
 *
 * A file of any size is split into content-defined slices so that a small
 * edit to a large file changes only the chunk containing it, and every
 * other chunk keeps its identity. This is what makes large binaries
 * dedup and delta-transfer well, uniformly for every file (see
 * note/term/registry/11 and 02).
 *
 * The algorithm is FastCDC: a rolling gear hash, normalized chunking (a
 * stricter mask before the average size, a looser one after, to tighten
 * the size distribution), and cut-point skipping (never evaluate a
 * boundary before the minimum size). Both the gear table and the masks
 * are generated deterministically from fixed seeds, so the same bytes
 * always chunk the same way. The exact parameters are an internal tuning
 * knob, never user-facing (see note/term/registry/10 and 11).
 */

// A deterministic 32-bit PRNG (splitmix32) so the gear table and masks are
// fixed forever without a hardcoded blob and without Math.random.
function splitmix32(seed: number): () => number {
  let state = seed >>> 0

  return () => {
    state = (state + 0x9e3779b9) >>> 0
    let z = state
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0

    return (z ^ (z >>> 15)) >>> 0
  }
}

// The 256-entry gear table, one 32-bit value per byte value.
const GEAR: Uint32Array = (() => {
  const next = splitmix32(0x1a2b3c4d)
  const table = new Uint32Array(256)

  for (let i = 0; i < 256; i += 1) {
    table[i] = next()
  }

  return table
})()

// Build a 32-bit mask with `bits` one-bits placed in the well-mixed high
// positions (8..31). More one-bits means a rarer cut (a larger expected
// chunk), because the boundary test is `(fp & mask) === 0`.
function buildMask(bits: number, seed: number): number {
  const next = splitmix32(seed)
  const positions: number[] = []

  for (let p = 8; p <= 31; p += 1) {
    positions.push(p)
  }

  // deterministic partial shuffle, then take the first `bits` positions
  for (let i = positions.length - 1; i > 0; i -= 1) {
    const j = next() % (i + 1)
    const tmp = positions[i]!
    positions[i] = positions[j]!
    positions[j] = tmp
  }

  let mask = 0

  for (let i = 0; i < bits && i < positions.length; i += 1) {
    mask = (mask | (1 << positions[i]!)) >>> 0
  }

  return mask >>> 0
}

/** Chunking parameters. Defaults target ~1 MiB chunks; tests may shrink them. */
export type ChunkParams = {
  min: number
  avg: number
  max: number
}

export const DEFAULT_CHUNK_PARAMS: ChunkParams = {
  min: 256 * 1024,
  avg: 1024 * 1024,
  max: 4 * 1024 * 1024,
}

// Normalization level 2: maskS (stricter, before avg) has bits+2 ones,
// maskL (looser, after avg) has bits-2 ones, where bits = log2(avg).
function masksFor(avg: number): { maskS: number; maskL: number } {
  const bits = Math.max(1, Math.round(Math.log2(avg)))

  return {
    maskS: buildMask(Math.min(24, bits + 2), 0x51ed270b),
    maskL: buildMask(Math.max(1, bits - 2), 0x27220a95),
  }
}

/**
 * Split `data` into content-defined chunks. Returns each chunk's [start,
 * end) offsets in order. Concatenating the slices reproduces `data`
 * exactly, so chunking is always losslessly reversible.
 */
export function chunkBuffer(input: {
  data: Buffer
  params?: ChunkParams
}): { start: number; end: number }[] {
  const params = input.params ?? DEFAULT_CHUNK_PARAMS
  const { min, avg, max } = params
  const { maskS, maskL } = masksFor(avg)
  const data = input.data
  const n = data.length
  const cuts: { start: number; end: number }[] = []

  let offset = 0

  while (offset < n) {
    const end = nextCut({ data, start: offset, min, avg, max, maskS, maskL })
    cuts.push({ start: offset, end })
    offset = end
  }

  return cuts
}

function nextCut(input: {
  data: Buffer
  start: number
  min: number
  avg: number
  max: number
  maskS: number
  maskL: number
}): number {
  const { data, start, min, avg, max, maskS, maskL } = input
  const n = data.length
  const remaining = n - start

  if (remaining <= min) {
    return n
  }

  const hardEnd = Math.min(start + max, n)
  const normalEnd = Math.min(start + avg, hardEnd)

  let fp = 0
  // cut-point skipping: do not evaluate a boundary before the minimum size
  let i = start + min

  // phase 1: [min, avg) uses the stricter mask (fewer cuts)
  while (i < normalEnd) {
    fp = ((fp << 1) + GEAR[data[i]!]!) >>> 0

    if ((fp & maskS) === 0) {
      return i + 1
    }

    i += 1
  }

  // phase 2: [avg, max) uses the looser mask (more cuts)
  while (i < hardEnd) {
    fp = ((fp << 1) + GEAR[data[i]!]!) >>> 0

    if ((fp & maskL) === 0) {
      return i + 1
    }

    i += 1
  }

  return hardEnd
}
