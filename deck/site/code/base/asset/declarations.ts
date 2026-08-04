/**
 * Per-asset configuration consumed by the sync script
 * (`the asset sync task`).
 *
 * This is the Term (`@term/site`) port of the React
 * the React site-asset declarations. The
 * shape, the two collections, and the CrowMark @font-face
 * declaration are identical -- Term sites serve their
 * hashed assets from the SAME host (`site.clue.surf`) and
 * the SAME `cluesurfsite` R2 bucket as the React sites, so
 * the declarations stay in lockstep.
 *
 * Two collections:
 *   - `ASSET_DECLARATIONS` -- CSS that needs to be emitted
 *     into `assets.css` referencing the hashed URL of an
 *     asset. Today only `@font-face`; extensible to other
 *     @-rules that can't use CSS variables.
 *   - `NO_HASH_PATHS` -- logical paths that must serve at
 *     a stable, unhashed URL on `site.clue.surf`. These
 *     are files external systems fetch by exact name
 *     (web crawlers, FedCM, OAuth providers, etc.).
 *
 * Spec: `note/platform/infrastructure/site-asset-sync.md`.
 */

export type FontFaceDeclaration = {
  kind: 'font-face'
  /** Logical asset path key, e.g. `/CrowMark.otf`. */
  asset: string
  /** CSS `font-family` name. */
  fontFamily: string
  /** CSS `src ... format(...)` argument. */
  format: 'opentype' | 'truetype' | 'woff' | 'woff2'
  /** CSS `font-display` value. Defaults to `'swap'`. */
  fontDisplay?: 'auto' | 'block' | 'swap' | 'fallback' | 'optional'
  /** CSS `font-weight`. Optional. */
  fontWeight?: string
  /** CSS `font-style`. Optional. */
  fontStyle?: string
}

export type AssetDeclaration = FontFaceDeclaration

export const ASSET_DECLARATIONS: AssetDeclaration[] = [
  {
    kind: 'font-face',
    asset: '/CrowMark.otf',
    fontFamily: 'CrowMark',
    format: 'opentype',
    /* `optional` (not `swap`).
     *
     * `html, body { font-family: CrowMark }` in the site's
     * `look` stylesheet makes every un-`<text-*>`-wrapped
     * element inherit the brand font directly. With
     * `font-display: swap`, the browser renders an immediate
     * fallback and then swaps to the real font once loaded --
     * a visible jolt that happens independently of the Type
     * component's visibility state machine.
     *
     * With `optional` plus the `CrowMark.otf` preload in each
     * site's document shell, the typical path is: font is in
     * cache by paint, real font from the first frame. If the
     * preload doesn't finish within the browser's ~100 ms
     * block window, the browser commits to the system fallback
     * for the lifetime of this page render (no swap, no jolt)
     * and uses the cached real font on the next navigation.
     *
     * Spec endorsement under "Robustness improvements" in
     * `note/platform/plan/text-component-optimization.md`. */
    fontDisplay: 'optional',
  },
]

/**
 * Logical paths that must be served at a stable, unhashed
 * URL on site.clue.surf. For files in this set:
 *
 *   - R2 key is the logical path itself, no hash prefix.
 *     `/robots.txt` -> R2 key `robots.txt`.
 *   - URL is `https://site.clue.surf/<logical-path>`.
 *   - assets.json still records a `hash` for change
 *     detection (sync only re-uploads on hash change),
 *     but the hash never appears in the URL.
 *   - assets.previous.json never gets entries for these.
 *     There's only ever one live URL per logical path;
 *     re-uploads overwrite in place.
 *
 * Files NOT in this set get the standard tone-hashed
 * URL treatment.
 *
 * Add to this set deliberately. Every addition is a
 * promise to keep the URL stable forever.
 */

export const NO_HASH_PATHS: ReadonlySet<string> = new Set([
  '/robots.txt',
  '/security.txt',
  // FedCM's well-known file for Google One Tap.
  '/.well-known/web-identity',
])

/**
 * Convenience predicate. Lives here so callers don't
 * have to remember the constant name.
 */

export function isNoHashPath(logicalPath: string): boolean {
  return NO_HASH_PATHS.has(logicalPath)
}
