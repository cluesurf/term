<br/>
<br/>
<br/>
<br/>
<br/>
<br/>
<br/>

<h3 align='center'>deck.tree</h3>
<p align='center'>
  The Seed Package Manager
</p>

<br/>
<br/>
<br/>

## Theory

It is built upon
[`@cluesurf/deck`](https://github.com/cluesurf/deck.js), which aims to
be a language-agnostic package manager in the long run.

### Specification

```tree
deck @cluesurf/seed
  head <A TreeCode Framework>

  mark <0.0.1>
  sort tool

  lock apache-2

  site <https://github.com/cluesurf/base>
  view ./view/tree.gif

  term tree-code
  term computation
  term information
  term philosophy
  term platform
  term white-label
  term compiler

  deck ./deck/load
  deck ./deck/line

  # defaults to https://registry.npmjs.org registry
  link @cluesurf/bind, mark <0.0.x>
  link @cluesurf/moon, mark <0.0.x>
  link @cluesurf/bead, mark <0.0.x>
  link @cluesurf/chew, mark <0.0.x>
  link @cluesurf/move, mark <0.0.x>
  link @cluesurf/seed, site <git://github.com/user/project.git#commit-ish>

  # use a custom registry
  host <https://npm.pkg.github.com>
    link @cluesurf/seal, mark <0.0.x>
    link @cluesurf/cone, mark <0.0.x>
    link @cluesurf/buzz, mark <0.0.x>
    link @cluesurf/crow, mark <0.0.x>

  task ./task # the task loader
  read ./book # also a default
  role ./role # also a default
  line ./line
  test ./test

  mind <Lance Pollard>, site <lp@elk.fm>
```

### Fetching

Get the package metadata here:

```
https://registry.npmjs.org/lodash/4.17.21
https://registry.npmjs.org/@cluesurf/tree/1.1.0
```

Get the `.tgz` zip file of the NPM package here:

```
https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz
https://registry.npmjs.org/@cluesurf/tree/-/tree-1.1.0.tgz
```

```bash
shasum lodash-4.17.21.tgz === metadata.dist.shasum
```

To login to the GitHub registry, this is how it looks:

```bash
npm login --scope=@NAMESPACE --auth-type=legacy --registry=https://npm.pkg.github.com
```

### Storage

When you install packages, it hard symlinks them from your
`~/Library/base` folder to your `./link` folder.

```
~/Library/base/v000
  # global dependencies
  /hook
    /deck
      /<host+deck>
        /...files
        /link
          /base.js
          /package.json
  # shared dependencies
  /deck
    /<host+deck>
      /...files
      /link
        /base.js
        /package.json
  /file # file store
    /<hash-code>
      /<hash>.{js,tree}
```

```
./link
  /:host
    /:deck
      /:mark
```

Then, `/:host/:deck/:mark` is hard linked from:

```
~/Library/base/deck/:host+deck
```

And inside `~/Library/base/deck/*`, the files are hard linked to
`~/Library/base/file/:code/:hash`.

When you `base link <deck>`, it symlinks from the symlink inside of
`~/Library/base/deck/*`.

This handles:

- Globally installed decks go into `hook/link`.
- The rest of the installed decks get shared in `link`.

#### Using `package.json`

It installs them from any available NPM compatible hosting service, like
npmjs.org or github.com.

Here is the `package.json` that gets generated for the package.

```json
{
  "name": "@cluesurf/seed",
  "base": true,
  "version": "0.0.1"
}
```

It simply uses the NPM ecosystem as a generic package hosting system.

#### Package size

Max package size is **8mb**, for packages published to NPM. This is
basically the same as what NPM enforces (they say they support 20mb, but
people have encountered errors publishing 10mb packages, so we choose
8mb).

Repos though, can be up to 1GB in size, and you can download these
through the `site <git://...>` directive.

### Searching

When it searches for files, it assumes the `CWD` is the deck base
folder, and so looks for the `./base.tree` file for that deck. It then
uses this information to determine the `role` of each nested file. Some
nested folders can also be nested decks, so those are determined too at
this point.

It then looks for the `link/lock.tree` file to make sure it is a folder
which contains installed decks. The `link` folder can be customized
using the `hold link` tree code.

```
/something/deeply/nested.tree
/something/deeply/nested/base.tree
```

### Lockfile

This is saved as `link/lock.tree`:

```tree
base <0.0.1>

load @cluesurf/moon
  mark <*>
  lock <0.0.1>
load @cluesurf/seed
  mark <*>
  lock <0.0.1>
load @cluesurf/wolf
  mark <*>
  lock <0.0.1>

link <@cluesurf/wolf:0.0.1>
  hash <sha512-O8jcjabXaleOG9DQ0+ARXWZBTfnP4WNAqzuiJK7ll44AmxGKv/J2M4TPjxjY3znBCfvBXFzucm1twdyFybFqEA==>
  load @cluesurf/seed
    mark <0.0.1>
```

### Linkfile

This is saved as `link/base.tree`

```tree
# says which ones are symlinks
link <@cluesurf/wolf:0.0.1>
link <@cluesurf/bind:0.0.1>
```

## License

Copyright 2023 <a href='https://clue.surf'>ClueSurf</a>

Licensed under the Apache License, Version 2.0 (the "License"); you may
not use this file except in compliance with the License. You may obtain
a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.

## ClueSurf

Made by [ClueSurf](https://clue.surf), meditating on the universe ¤.
Follow the work on [YouTube](https://youtube.com/@cluesurf),
[X](https://x.com/cluesurf),
[Instagram](https://instagram.com/cluesurf),
[Substack](https://cluesurf.substack.com),
[Facebook](https://facebook.com/cluesurf), and
[LinkedIn](https://linkedin.com/company/cluesurf), and browse more of
our open-source work here on [GitHub](https://github.com/cluesurf).
