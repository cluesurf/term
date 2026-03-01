# Package Manager Internals in TermTree

This is the package manager section basically, the first prototype
implemented in TypeScript. The goal is to eventually have it built using
term.tree in link text itself.

This should find the package first and foremost.

- check the current directory for a special file called `link/deck.tree`
  and a file called `term.tree`.
  - if it doesn't exist, then try going up one.

When you encounter a path, you resolve the path.

- https://www.freecodecamp.org/news/requiring-modules-in-node-js-everything-you-need-to-know-e7fbd119be8/

../../../load.js

This loads a file at that path relative to the current path. No module
resolution is necessary.

../../../load

The linking to the global store stores it at:

```
~/.tree
  /deck
    /link # global dependency store
      /<host>
        /<deck>
          /...files
    /tree # file store
      /<hash-base>
        /<hash>
```

When you install packages, it hard symlinks them to your `./note`
folder.

You can have "workspaces" by adding a `deck` folder (or wherever you put
it).

```
./deck
  /deck-1
  /deck-2
```

You specify "workspaces" as "slots" where decks live.

```
deck @my/deck
  link @another/deck
  deck ./deck/deck-1
  deck ./deck/deck-2
```

When it searches for files, it searches like this:

```
/something/deeply/nested/term.tree
/something/deeply/nested/link

/something/deeply/term.tree
/something/deeply/link

/something/term.tree
/something/link

/term.tree
/link
```

## Role Files

There are special files which specify how the rest of the files in the
deck are parsed. It says essentially what parser should be used on a set
of files matching a path.

```
role ./**/test.tree
  mint test

role ./task/**/term.tree
  mint task
```

The path to this is specified in the deck file:

```
deck <@foo/bar>
  role ./dock/role
```

So the process is, the base loader first loads the deck file, then finds
the mint files, then uses this information to resolve how the file is
handled.

Eventually this will all be defined in link code directly, but for now
it is just built into the compiler, the specific ways different file
types are handled.

```
https://clue.surf/@cluesurf/term/head/deck.tree
https://clue.surf/@cluesurf/term/1.2.3/deck.tree
```

Limit to 256mb decks.

The decks are stored on google cloud.

```
deck <host/name>
  mark <0.0.1> # term.tree version
  lock mit # required for publishing
  head <Required summary of the package in 64 characters or less.>
  site <repo>
```

To publish:

```
note host deck
```

Stored on google cloud like:

```
deck.tree.surf/@cluesurf/term/1.2.3/deck.tar.gz
deck.tree.surf/@cluesurf/term/1.2.3/term.tree
```

The `term.tree` gives us the metadata associated with the deck:

```
{
  "shasum": "392617f69a947e40cec7848d85fcc3dd29d74bc5",
  "tarball": "https://registry.npmjs.org/lodash/-/lodash-0.1.0.tgz",
  "integrity": "sha512-ufIfwX7g5obXKaJhzbnAJBNf5Idxqty+AHaNadWFxtNKjGmF/ZO8ptSEjQRQRymBPZtLa0NV9sbrsH87Ae2R1A==",
  "signatures": [
    {
      "keyid": "SHA256:jl3bwswu80PjjokCgh0o2w5c2U4LhQAE57gj9cz1kzA",
      "sig": "MEQCIBB7pdqPfBFUsZQhVr3woDJ7/bbRWV3tlXQZNp3ivosbAiBMhwfq9fqaJvFFX1/scqPbIywUUZCQkfJaISqaJbZX2Q=="
    }
  ]
}

hash sha, <392617f69a947e40cec7848d85fcc3dd29d74bc5>
hash integrity
```

If there are more than 256 downloads, it can't be deleted without
reaching out to support at meet@clue.surf.

On publish to term.tree, once the package hits the server and streams
the upload to google cloud, it generates the hash and saves the
`term.tree`.

```js
// open file stream
var fstream = fs.createReadStream('./test/hmac.js')
var hash = crypto.createHash('sha512', key)
hash.setEncoding('hex')

// once the stream is done, we read the values
fstream.on('end', () => {
  hash.end()
  // print result
  console.log(hash.read())
})

// pipe file to hash generator
fstream.pipe(hash)
```

The lockfile then loads the data:

```
base <0.0.1>

load @cluesurf/moon
  mark <*>
  lock <0.0.1>
load @cluesurf/term
  mark <*>
  lock <0.0.1>
load @cluesurf/wolf
  mark <*>
  lock <0.0.1>

link <@cluesurf/wolf:0.0.1>
  hash <sha512-O8jcjabXaleOG9DQ0+ARXWZBTfnP4WNAqzuiJK7ll44AmxGKv/J2M4TPjxjY3znBCfvBXFzucm1twdyFybFqEA==>
  load @cluesurf/term
    mark <0.0.1>
```

The website is pinged:

```
PATCH https://clue.surf/deck
```

With the payload:

```
hint code, nick false
```

It streams the file to google cloud. It streams a local zip file to
remote.

It stores a copy of the package readme.md and the deck file metadata for
display in the UI.

```
https://clue.surf/@cluesurf/term
```

Shows readme, with link to source.

```
call host-deck
call test-deck # does it exist?
```

Can check directly with google cloud if it exists.

```
stats = storage.Blob(bucket=bucket, name=name).exists(storage_client)
```

For each version, it stores the readme and the metadata on the site in
postgres, to render the website.

```
https://clue.surf/@cluesurf/term/1.2.3
```

The registry chooses to not use URLs and instead use the `@` at sign to
keep things simple. A host is required to manage a deck, to provide a
namespace as well.

---

The sandbox is basically a deck.

https://codepen.io/ettrics/pen/WRbGRN

```
clue.surf/@cluesurf/:deck/code/:file+
clue.surf/@cluesurf/buck-1212 (4 letter word followed by numbers)
clue.surf/@cluesurf/buck-1212/mark/:mark/code/:file+ (just the code)
clue.surf/@cluesurf/buck-1212/mark/:mark/hint/:file+/task/create-something
```

Then the sandbox decks are marked as "sort make".

    sort make (playground)
    sort load (library)
    sort task (cli tool)
    sort site (application)

When you add new dependencies, it runs a new vercel build. Otherwise it
runs against the vercel code.

```
TermTreeShow (project name)

MakeTermTree (project name)

make.tree.surf/@cluesurf/buck-1234
  Shows the rendering
make.tree.surf/@cluesurf/buck-1234/hint/:file+
make.tree.surf/@cluesurf/buck-1234/code/:file+
make.term.tree
  Try and share code
clue.surf/dock/vercel/back
```

Those are `sort make` decks under the hood, or `make true`.

For now, it links to GitHub projects and deploys directly through
vercel. You don't host the code on term.tree.

show true (to your deck, so it gets published to the world)

The decks that you publish to term.tree are basically tools for the most
part, though they can be apps / sites.

```
base link make deck
```

You can only publish 20 versions of a deck per day, unless you upgrade
to "verified".

You can only create 20 decks per day, unless you upgrade to verified.

---

Get word like `bird-1234`

```js
const MAX = 2097151

function splitInt(int) {
  if (int > MAX) {
    throw new Error('Too large a number')
  }
  let roughly10k = (int >> 8) & 0xffff
  let terms256 = int & 0xff
  return [terms256, roughly10k]
}

function log(int) {
  const [a, b] = splitInt(int)
  console.log(int, '=> [', a, b, ']')
}
```

To find the commands from other projects, the other projects need to be
installed in the local deck in the current directory. These are defined
under the `hook` term in the deck definition.

```
deck @foo/bar
  hook ./hook
```

After installation, they get added to the generated JS/etc.. so it is
easy to find them.

So the ./hook folder for all the decks gets compiled into a single CLI.

- https://github.com/pkgjs/parseargs/blob/main/index.js#L175

This is basically a `hook.js` file that gets created, which handles the
CLI without importing anything, and only imports things lazily.

Then for each deck, we have a `deck.js` that gets created, which
resolves circular dependencies and such within the deck. This gets
loaded dynamically after the command is parsed.

So each deck becomes a separate file. But then we can combine some of
them into bundles, for minimizing HTTP requests on changed files.

The bolt.tree project is all types, it is not needed at runtime. So
there is type-annotated and type-free versions of the output JS.

So we have the term.tree "compiler" form of the output JS, which is
basically a direct port of the code to the compiler AST in JS. Then we
have the compiled AST output file, without any types. The JS term.tree
code is used to generate the output JS. This outputs stuff without the
types, if the types aren't directly referenced. If there is any code
directly or indirectly referencing types, it perhaps includes all the
types, or it returns null, either one.

The special top-level `seal` command will force include the types.

```
seal form user
seal task create
```

So the compiler generates JS one per deck. And the JS is used to
generate a build, where the files are grouped based on some heuristic.

It saves it into:

```
~/Library/note
  /note # global dependency store
    /<host+deck>
      /...files
      /link
        /note.js
        /package.json
  /tree # file store
    /<hash-base>
      /<hash>.{js,link}
```

The source maps are like this:

```
/make
  /browser
    /link
      /band.base.js
        //# sourceMappingURL=band.base.js.map
      /band.rest.js
        //# sourceMappingURL=band.rest.js.map
    /deck.js
```

There is a server which loads the source maps under `/link`:

```
/make
  /link
    /cluesurf
      /crow
        /1.0.23
          /code
            /term.tree
          /link
            /cluesurf
              /wolf => /wolf/0.1.0
      /wolf
        /0.1.0
          /code
            /term.tree
```

The server aliases to `./link` on the file system, as in:

```
/link
  /cluesurf
    /crow
      /1.0.23
        /code
          /term.tree
        /link
          /cluesurf
            /wolf => /wolf/0.1.0
```

The `note.js` is compiled with types. Then that gets run and compiles to
output JS/Swift/etc..

Specify the bundle groups with:

```
deck @foo/bar
  band base
    link @cluesurf/term
    link @cluesurf/nest
    link @cluesurf/crow
```

Map [multiple sources](https://www.bugsnag.com/blog/source-maps/) to one
JS file.

https://developer.mozilla.org/en-US/docs/Web/Manifest

There are source maps for Node.js too, and the compiler.

So:

- loading from ./code loads ./link/cluesurf/crow
- loading from ./link/cluesurf/crow loads from
  - /link/.tree/cluesurf/crow/1.0.23
- that gets compiled into
  - /link/.work/node_modules/cluesurf/crow/index.js
- and that is actually a symlink to
  - /link/.work/node_modules/.tree/cluesurf+crow@1.0.23/node_modules/cluesurf/crow/index.js
- so when we load ./link/.work/index.js, it loads from that last long
  path.
- and the source map path is always relative to that long path.

Code loads from browser/server alias (which is accessible through
sourcemaps):

```
/tree
  /cluesurf
    /crow
      /1.0.23

# or

/base
  /tree
    /cluesurf
      /crow
        /1.0.23
```

And the source code in JavaScript is at:

```
/site
  /band.base.<hash>.js
  /band.rest.<hash>.js

# or

/base
  /make
    /javascript
      /browser
        /band
          /band.base.<hash>.js
          /band.rest.<hash>.js
```

A hard link converts the path into something usable.

Then when it loads a symlinked module, it still is loading from the
base, recursively.

You can hide the sourcemaps behind a login wall, via:

```
hook /site/:file+
  task load-make

hook /tree/:file+
  task load-tree
```

```
deck @foo/bar
  make browser, ./make/site/browser
  make node, ./make/site/node
```

It builds to the base directory, and you have to grab it and make it
public for the browser.

```
/host
  /bind.tree
  /lock.tree
/link
  /hint.tree
  /head
    /cluesurf
      /crow # symlink to 1.0.23
  /tree
    /cluesurf
      /crow
        /1.0.23
          /code
            /term.tree
          /base
            /link
              /cluesurf
                /wolf => wolf/0.1.3
      /wolf
        /0.1.3
          /code
            /term.tree
/make
  # this folder changes a lot
  /bake # prepare the code
    /javascript
      /browser
        /base.<hash>.js # final output
        /base.<hash>.js.map
          => link to crow@1.0.23
      /node # symlink to node folder
  /rake # organize the code
    /javascript
      /package.json
        name: @cluesurf/term
        browser: ./browser/index.js
      /browser
        /hash.json
        /node_modules
          /.tree
            /@cluesurf
              /nest
                /2.2.23
          /@cluesurf
            /nest
          /@cluesurf
            /base+shared
        /roll
          /hash+<hash-of-names>.js
          /<name>.js
      /shared
        /hash.json
        /node_modules
          /.tree
            /@cluesurf
              /nest
                /2.2.23
          /@cluesurf
            /nest
        /roll
          /hash+<hash-of-names>.js
          /<name>.js
      /node
        /hash.json
        /hook.js
        /test.js
        /index.js
        /node_modules
          /.tree
            /cluesurf+nest@2.2.23
              /node_modules
                /@cluesurf
                  /crow
          /@cluesurf
            /nest
        /roll
          /hash+<hash-of-names>.js
          /<name>.js
  /take # gather the code
    /rust
      /linux
    /javascript
      /browser
      /shared
        /hash.json
      /node
        /hash.json
          {
            [hash]: [link]
          }
        /index.js
        /node_modules
          /.tree
            /cluesurf+crow@1.0.23
              /node_modules
                /@cluesurf
                  /crow
                    /index.js
                      //# sourceMappingURL=index.js.map
                    /index.js.map
                      => ../../../../../../../tree/cluesurf/crow/1.0.23
                  /wolf
                    /index.js
          /cluesurf
            /crow
              /index.js # symlink to cluesurf+crow@1.0.23/node_modules/cluesurf/crow/base.js
```

You could periodically check and clean the cache, every 16th change,
otherwise use file watching.

```js
hash([file, name].join('#'))
```

There is an in-memory cache of the modules. It saves the modules

https://betterprogramming.pub/a-memory-friendly-way-of-reading-files-in-node-js-a45ad0cc7bb6

On TermTreet the dev server, read each file's hash using streaming API
or fs.read directly with shared memory buffer. Find all the old files
using each hash, those files you don't have to recompile. Find the new
files because they didn't exist in the cache, and compile those. Find
the removed files because the cache contained extra files that weren't
found in the new hash set. Remove those from the cache.

TermTreet the dev server, when a file renamed, clear the cache and add
the new value.

link: hash

When file is renamed, find all the files that import that file, and
change the import. Can do this on the AST for the import. Then write out
the changed file.

The JS files can all be named after codes, not hashes. Each deck gets a
file. Then the current deck gets a set of rolls. Each deck is named
after the deck in JS. The file is index.js. Each roll is named after the
file if non-circular, otherwise the file names hash.

```
sinkFileHash (link files)
takeFileHash (js files for compiler)
rakeFileHash (js files for preliminary pass)
bakeFileHash (js published file interface)
```

First read the tree files and check the hashes, invalidate any that have
changed. Then read the work file hashes, invalidate any that have
changed. Then read the make file hashes, invalidate any that have
changed.

The roll gets imported into the rest of the files so circular
dependencies get resolved internally, but can be imported externally
through JS.

```js
// foo.js
import * as circularStuff from './hash+<hash>.js'

export const foo = circularStuff.foo

// bar.js
import * as circularStuff from './hash+<hash>.js'

export const bar = circularStuff.bar
```

## Max File Size

The max link file size is 16mb.

```js
import crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import pkg from 'glob'
const { glob } = pkg

const MB_16 = Math.pow(2, 24)
const MB_1 = MB_16 / 16

const fileSharedBuffer = Buffer.alloc(MB_1)

async function readBytes(fh, sharedBuffer) {
  return await fh.read(sharedBuffer, 0, sharedBuffer.length, null)
}

const TermTreet = new Date()

const str = []

main().then(() => {
  const end = new Date()
  console.log(end - TermTreet)
})

async function main() {
  const paths = glob.sync('../term.tree/code/**/*.tree')
  for (const path of paths) {
    const hash = await getFileHash(path)
    str.push(hash)
  }
}

async function getFileHash(link) {
  const hash = crypto.createHash('sha512')
  hash.setEncoding('hex')

  for await (const chunk of generateChunksFromFile(
    link,
    MB_1,
    fileSharedBuffer,
  )) {
    hash.update(chunk)
  }

  hash.end()
  return hash.read()
}

async function* generateChunksFromFile(filePath, size, sharedBuffer) {
  const stats = await fs.stat(filePath) // file details

  if (stats.size > MB_16) {
    throw new Error(`File too big: ${stats.size} > ${MB_16}`)
  }

  const fh = await fs.open(filePath) // file descriptor
  let bytesRead = 0 // how many bytes were read
  let end = size
  let n = Math.ceil(stats.size / size)

  for (let i = 0; i < n; i++) {
    await readBytes(fh, sharedBuffer)
    bytesRead = (i + 1) * size
    if (bytesRead > stats.size) {
      // When we reach the end of file,
      // we have to calculate how many bytes were actually read
      end = size - (bytesRead - stats.size)
      yield sharedBuffer.slice(0, end)
    } else {
      yield sharedBuffer
    }
  }

  await fh.close()
}
```

```js
function loadFileHashBase(path) {
  const paths = glob.sync(path)
  const hashes = {}
  for (const path of paths) {
    const hash = await getFileHash(path)
    hashes[hash] = [path]
  }
}

function testFileHashList(hashList, fileHashList) {
  const deleted = {}
  for (const hash in fileHashList) {
    if (!hashList[hash]) {
      // it was deleted or renamed
      deleted[hash] = true
    }
  }
  const added = {}
  for (const hash in hashList) {
    if (!fileHashList[hash]) {
      // it was added or changed
      added[hash] = true
    }
  }
  return { added, deleted }
}

function tossFileHead(path) {
  // propagate all removals
  // rebuild the tailing files that were dependent on this.
}

function makeFileHead(path) {
  compileFile(path)
}
```

You make the files and they become baked, which you can then publish as
a Node module or Swift package or Rust crate.

- `node/hook.js` is the `bin`
- `node/index.js` is the node main
- `browser/index.js` is the browser main
- `browser/band/*.js` is the build for the public assets

Based on if it is `sort tool` or `sort site`:

- `tool`: It exports a package.json for the node.js and the browser.
- `site`: It exports standalone JS files ready to be loaded like how
  webpack builds things.

## Peer Dependencies

```
link @cluesurf/crow, mark <0.*>
  have 1 # singleton policy
```

## Semver Cheatsheet

https://github.com/semver/semver/issues/833

## Cyclic Dependency Resolution

So there are things that depend on other things being ready.

Sometimes it doesn't know how many are going to eventually be ready.

The bear needs to wait for all the linked module things to be exposed.
Once they are complete, then the bear can be complete.

The bear dependencies don't need to be fully complete, just
_recognizable_. Once all of them are recognizable, the bear can be
considered recognizable. Once the bear is recognizable, its usages as a
circular import can become recognizable.

A thing doesn't have a "recognizable" property, things use a schema to
determine if it is recognizable to them.

    when('recognizable', {
      type: 'bear',
      path: true,
      classes: {
        name: true,
      }
    }, () => {

    })

So you watch a set of paths, you need to know when a new path is added,
and when the path is fully matched.

For each item that is encountered, it has a specific path. We then use
this path to update anything depending on that path.

Until it can't progress any further.

    handle_deck_bear() {
      createBlue
      createRed

      enqueue(handler, data)
      trigger(change)
    }

So you enqueue things to happen next, and you watch for things to
trigger your awareness and take action. You change gears when you get
notified of an event, when a path matches a criteria.

This is all just to resolve the initial structures, not to evaluate
them, or check their types.

    createObserver({
      prop1: {
        state: [],
        props: {
          propa: {
            state: []
          },
          propb: {
            state: []
          }
        }
      }
    }, onmatch)

## Dependency resolution

- [Rust / Cargo](https://doc.rust-lang.org/cargo/reference/resolver.html)
- [Yarn workspaces](https://classic.yarnpkg.com/blog/2017/08/02/introducing-workspaces/)
