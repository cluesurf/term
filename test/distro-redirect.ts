// The package half of term.surf's apt and dnf repositories, as `pnpm run term:distro` writes the indexes: a package
// path names a version folder and a file of that same version, and is answered with that version's GitHub release
// asset. Nothing else is answered, so no path can point at an arbitrary release asset:
//
//   /apt/pool/<v>/term_<v>_<amd64|arm64>.deb
//   /rpm/<v>/term-<v>-1.<x86_64|aarch64>.rpm
//
// test/call/distro.ts serves its containers through this stand-in. The site's own Worker, which answers the same paths
// on term.surf, is written outside this repository, and the check that holds it to RELEASE_SHAPES runs where it is. A
// helper, not a suite: it sits beside temp.ts, where the gate looks for no suite.

/** Where a package is sent: the release downloads of `cluesurf/term`. */
export const RELEASE_DOWNLOADS = 'https://github.com/cluesurf/term/releases/download'

const DEB = /^\/apt\/pool\/(\d+\.\d+\.\d+)\/(term_(\d+\.\d+\.\d+)_(?:amd64|arm64)\.deb)$/

const RPM = /^\/rpm\/(\d+\.\d+\.\d+)\/(term-(\d+\.\d+\.\d+)-1\.(?:x86_64|aarch64)\.rpm)$/

/** The release asset a package path names, as a full URL under `downloads`, or null for any other path. */
export function releaseRedirect({
  pathname,
  downloads = RELEASE_DOWNLOADS,
}: {
  pathname: string
  downloads?: string
}): string | null {
  const match = DEB.exec(pathname) ?? RPM.exec(pathname)

  if (!match || match[1] !== match[3]) {
    return null
  }

  return `${downloads}/v${match[1]}/${match[2]}`
}

/** Every shape the indexes write, and the paths that must be answered with nothing, each with its answer */
export const RELEASE_SHAPES: [string, string | null][] = [
  [
    '/apt/pool/2.7.2/term_2.7.2_amd64.deb',
    `${RELEASE_DOWNLOADS}/v2.7.2/term_2.7.2_amd64.deb`,
  ],
  [
    '/apt/pool/2.7.2/term_2.7.2_arm64.deb',
    `${RELEASE_DOWNLOADS}/v2.7.2/term_2.7.2_arm64.deb`,
  ],
  [
    '/rpm/2.7.2/term-2.7.2-1.x86_64.rpm',
    `${RELEASE_DOWNLOADS}/v2.7.2/term-2.7.2-1.x86_64.rpm`,
  ],
  [
    '/rpm/2.7.2/term-2.7.2-1.aarch64.rpm',
    `${RELEASE_DOWNLOADS}/v2.7.2/term-2.7.2-1.aarch64.rpm`,
  ],
  ['/apt/pool/2.7.0/term_2.7.2_amd64.deb', null],
  ['/apt/pool/2.7.2/term_2.7.2_i386.deb', null],
  ['/apt/pool/2.7.2/term-2.7.2-windows-x64.zip', null],
  ['/apt/pool/2.7.2/../2.7.2/term_2.7.2_amd64.deb', null],
  ['/rpm/2.7.2/other-2.7.2-1.x86_64.rpm', null],
  ['/apt/dists/stable/InRelease', null],
]
