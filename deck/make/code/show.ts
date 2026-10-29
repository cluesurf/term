import * as banner from '@term/make/code/banner'

// The banner `term` prints with no verb, and the line `term show` prints. Both said `seed` (the language's old name)
// until 2026-10-02, and the banner listed `term show deck tree`, which the CLI does not accept. `move` and `show`
// take `mark`, the manifest's version field, since the version became `mark <1.4.2>` and `code` came to name the
// code root folder (note/project/term/manifest/manifest-mark-and-code-root.md). `code` is still taken as the old spelling.
//
// Each is TEXT first (`bannerText`, `infoText`): it is the answer the person asked for, so the CLI writes it as data
// on stdout through the terminal output library (call/code/output.ts, `printData`). The text is byte for byte what
// the `console.log` lines wrote, a newline after every line.
//
// The texts are Term, banner.tree (self-hosting, 2026-10-06), and so are their reads: the color, the platform, the
// runtime and the home come through @term/base (decision 064 section 3). This face only writes them out.

export function bannerText(): string {
  return banner.bannerShown()
}

export function infoText(version = '0.0.0'): string {
  return banner.infoShown(version)
}

export function showBanner(): void {
  process.stdout.write(bannerText())
}

export function showInfo(version = '0.0.0'): void {
  process.stdout.write(infoText(version))
}
