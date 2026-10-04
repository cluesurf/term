// The blog with no WebView (native-dom-0014): the blog app's own page entry (deck/site/test/site/face/base.tree, the
// same `boot` its cask runs inside a WebView) compiled with the toolkit host, so its views are AppKit views on macOS,
// UIKit views on the iOS simulator and Android views on the emulator, and its database is SQLite in the same process,
// with no bridge between them. The program opens a native window, launches `boot` (which opens the database in the
// app's data directory, reads the posts and mounts the blog on the window's root), types a post into the platform's
// own text fields, presses the platform's own button, and prints the tree as read back FROM THE VIEWS before and after,
// then writes a PNG of the screen. Built and run on each platform by ./shared/toolkit-run.ts.
//
// The check: the new post's title is in the tree after the press and not before, so the store (SQLite) and the
// renderer (the toolkit host) both ran natively. SNAPSHOT_BLOG, SNAPSHOT_BLOG_IOS and SNAPSHOT_BLOG_ANDROID name where
// each PNG goes; they are how the screenshots in note/term/project/native-dom/ are made. The same program also runs as
// Jetpack Compose on the emulator (compose-target-0005), SNAPSHOT_BLOG_COMPOSE_ANDROID its PNG. BLOG_ONLY=macos (or ios,
// android, compose-android) runs one platform. Run: npx tsx test/compile/blog-native.ts

import { runDir } from './run-dir'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runToolkits } from './shared/toolkit-run'
import type { Leg } from './shared/toolkit-run'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

// a title no earlier run wrote: the database persists in the app's data directory between runs
const RUN = Date.now()
const title = (leg: Leg): string => `Native post ${leg} ${RUN}`

const program = (leg: Leg, shot: string): string => `load @term/site/test/site/face/base
  find boot

load @term/site/code/dom/dom
  find view
  find page-body

load @term/site/code/dom/native/toolkit/dom
  find open-root
  find launch
  find run-app
  find exit-app
  find show-window
  find serialize
  find child-at
  find type-text
  find press
  find later
  find snapshot
  find say

task check
  note async
  like void
  call boot
    wait true
  save root
    call page-body
  call show-window
  call say
    text <before {{serialize(read root)}}>
  save blog
    call child-at
      read root
      code 0
  call type-text
    call child-at
      read blog
      code 0
    text <${title(leg)}>
  call type-text
    call child-at
      read blog
      code 1
    text <Written natively, kept in SQLite>
  call press
    call child-at
      read blog
      code 2
  # the store is asynchronous: the post is drawn once it is kept, so the tree is read on a later turn
  call later
    task after
      save shown
        call serialize
          read root
      call say
        text <after {{shown}}>
      call snapshot
        text <${shot}>
      call exit-app
        code 0

task main
  call open-root
    text <Term blog>
    code 640
    code 480
  call launch
    read check
  call run-app
`

// what every platform must print: the blog read back from its own views, before and after the post
function judge(leg: Leg, toolkit: string, output: string, shot: string): void {
  const heading = title(leg)
  // the blog's own lines are `before <tree>` and `after <tree>`: a log shared with another app on the device (the
  // toolkit suite's `turn before compact`) must not pass for one
  const tree = (word: string): string => {
    const line = output.split('\n').find(l => l.includes(`${word} <`)) ?? ''

    return line.slice(line.indexOf(`${word} <`)).trim()
  }
  const before = tree('before')
  const after = tree('after')
  ok(`${leg}: the blog mounted on the window, inputs and a button read back from ${toolkit}`, /<input/.test(before) && /<button/.test(before), before.slice(0, 300))
  ok(`${leg}: the new post was not there before`, !before.includes(heading))
  ok(`${leg}: the post typed into the native fields and added by the native button is drawn`, after.includes(heading), after.slice(0, 400))
  ok(`${leg}: a PNG of the screen was written`, existsSync(shot) && readFileSync(shot).subarray(1, 4).toString() === 'PNG', shot)
}

runToolkits(
  {
    root: process.cwd(),
    dir: runDir('term-blog-native-'),
    name: 'Blog',
    iosIdentifier: 'surf.term.blog-native-test',
    androidIdentifier: 'surf.term.blognative',
    program,
    judge,
    ok,
    shots: {
      macos: process.env.SNAPSHOT_BLOG,
      ios: process.env.SNAPSHOT_BLOG_IOS,
      android: process.env.SNAPSHOT_BLOG_ANDROID,
      'compose-android': process.env.SNAPSHOT_BLOG_COMPOSE_ANDROID,
      compose: process.env.SNAPSHOT_BLOG_COMPOSE,
    },
    compose: true,
    composeAndroid: true,
  },
  process.env.BLOG_ONLY ?? '',
)

console.log(`\nblog-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
