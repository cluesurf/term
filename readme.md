<br/>
<br/>
<br/>
<br/>
<br/>
<br/>
<br/>

<p align='center'>
  <img src='https://github.com/cluesurf/term.tree/blob/make/view/tree.gif?raw=true' height='192'/>
</p>

<h3 align='center'>term</h3>
<p align='center'>
  A Reactive Language
</p>

<br/>
<br/>
<br/>

## Introduction

TermTree is a cross-platform programming/application/compiler framework
built with [TreeCode](https://github.com/cluesurf/tree) syntax, and it is still
in the _super prototype_ stage. It is far from being working, so mainly
just a collection of packages with API ideas. The long term goal is to
now get this working :).

Think of it as a "reactive compiler", basically you model stuff in
TreeCode (a simple structured language), and TermTree compiles that code
into applications or software.

_Check out the
"[Book](https://github.com/cluesurf/term.tree/tree/make/book)" for the
most up-to-date examples and outlines of how this might end up working._

## Installation

```
pnpm add @cluesurf/term -g
```

## Dependencies

TermTree is aimed to be built as a set of APIs, which you can swap out
the implementation for (as ones figure out more optimal approaches, like
how normal software tools evolve generation after generation). But we
will have a default set of implementations to start.

| Package                                              | Description                                                                                                                                                                                                                                                                                                                  |
| :--------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`case.tree`](https://github.com/cluesurf/case.tree) | **Environment Binding Library.** This library will provide all the types for the base native runtimes (JavaScript, Swift, etc.).                                                                                                                                                                                             |
| [`term.tree`](https://github.com/cluesurf/term.tree) | **Environment Tooling Library.** This will provide the main data types on top of the environment and all the standard functions. This will also include APIs for all the extra interfaces of the environment (cameras, flashlight, etc.).                                                                                    |
| [`link.tree`](https://github.com/cluesurf/link.tree) | **Third-Party API Integration Library.** This will provide integration with common third-party REST APIs and the like.                                                                                                                                                                                                       |
| [`feed.tree`](https://github.com/cluesurf/feed.tree) | **Data Management Library.** This will manage GraphQL/SQL-like querying and manipulation of database records. As well as handling caching, messaging, queueing, logging, etc.. Basically all data transfer.                                                                                                                  |
| [`text.tree`](https://github.com/cluesurf/text.tree) | **Parsing Library.** These will be grammars used to parse text into ASTs, and generate text from ASTs.                                                                                                                                                                                                                       |
| [`view.tree`](https://github.com/cluesurf/view.tree) | **View Library.** This will be combined 2D and 3D graphics rendering for the web.                                                                                                                                                                                                                                            |
| [`make.tree`](https://github.com/cluesurf/make.tree) | **Compiler.** This will do typechecking and compile the code to output runtimes. This will also do regular code linting and formatting (like prettier and ESLint). And it will allow for debugging and setting breakpoints, all from within the same AST and compilation scope. Finally, it will contain the runtime module. |
| [`deck.tree`](https://github.com/cluesurf/deck.tree) | **Package Management Library.** This will handle resolving, fetching, and publishing packages.                                                                                                                                                                                                                               |
| [`host.tree`](https://github.com/cluesurf/host.tree) | **Resource Provisioning Framework.** This will be like working with terraform modules to deploy and manage infrastructure.                                                                                                                                                                                                   |
| [`test.tree`](https://github.com/cluesurf/test.tree) | **Testing Library.** The framework and tooling to run unit and integration tests.                                                                                                                                                                                                                                            |
| [`form.tree`](https://github.com/cluesurf/form.tree) | **Math Definition Library.** This will ideally contain models for the foundations of math.                                                                                                                                                                                                                                   |
| [`lock.tree`](https://github.com/cluesurf/lock.tree) | **Security Framework**. All auth and security protocols go here.                                                                                                                                                                                                                                                             |
| [`site.tree`](https://github.com/cluesurf/site.tree) | **Application Framework**. A web application framework like Next.js or Ruby on Rails.                                                                                                                                                                                                                                        |
| `chat.tree`                                          | **Natural Language Library.** This will contain tools for working with spoken languages and writing systems.                                                                                                                                                                                                                 |

All of these are wrapped into the singular `term.tree` library, and you
import from that.

## Folder Structure

Ignore the key folders in `.gitignore`:

```.gitignore
/.term  # compiled helper folder
/bind   # environment variables
/hold   # temporary folder
/host   # generated content folder
/link   # downloaded packages folder
```

Here is how a monolithic app might be structured:

```
/.gitignore
/.term
/term.tree
/bind # env variables, don't commit
  /test.tree
  /term.tree
  /work.tree # dev
  /moon.tree # staging
  /term.tree # prod
/hold # scratchpad/tmp folder
/host
  /javascript
    /browser
    /node
  /log # logs
    /work.tree # dev logs
    /test.tree # test logs
/note # guides
/link
/deck
  /form # schema
    /code
      /user.tree
  /line # command line processing
  /back # backend
    /deck
      /site-1
      /site-2
      /hook # REST and webhook handlers
        /task # handle API calls
        /take
        /save
      /note # mailers
      /work # jobs
        /time # cron jobs
      /form # schema
        /user.tree
      /call
        /take # query allowance
      /rule # policies/permissions
  /face # frontend
    /deck
      /test
      /dock # ui components
      /vibe # styles/themes
      /site-1
        /wall # pages
          /host
            /term.tree
            /case.tree
            /deck
              /term.tree
              /case.tree
        /text # copy
      /kink # errors
      /file # public directory
        /text # fonts
        /view # images
  /base # database
    /seed # seeding data
    /move # migrations
  /site # infrastructure
    /hold.tree # don't commit this
    /move # migrations
/task # dev helpers
/text # copy
  /en.tree
  /fr.tree
  /zh.tree
```

For libraries, you might only have:

```
/term.tree
/code
/task
/hold
/host
/link
/note
```

## Interfaces

The package manager and several other components can possibly be swapped
out potentially in the future, each just depends on a small interface.

### Package Manager Interface

```ts
const deck = new Deck({ home: '.' })

// save global package
Deck.save()

// remove global package
Deck.toss()

// verify global package
Deck.test()

// link global package
Deck.link()

// install defined packages
deck.load()

// add a package
deck.save({ link, mark, site })

// remove a package
deck.toss({ link, mark, site })

// verify a deck
deck.test({ link, mark, site })

// link a package
deck.link({ link, mark, site })

// resolve file link
deck.find({ file, base })
```

### Compiler Interface

```ts
class Code {
  make() {
    this.load()
    this.mesh()
    this.lint()
    this.tree()
    this.text()
    this.bind()
  }

  bind() {
    code.on('file', code.make)
  }

  // load from the entrypoint of the project
  load() {}

  // do type-checking, variable resolution, optimizations, etc..
  mesh() {}

  // do linting and fix up code
  lint() {}

  // make output AST in target language
  make() {}

  // write the AST to string
  text() {}
}
```

### Output Generator Interface

```ts
const host = new Host({ code })

const ts = host.make({ form: 'typescript' })
const rust = host.make({ form: 'rust' })
```

The output is typed as a standard AST in each language.

## TODO

- parse mine/mind files (mint)
  - parse tree-role file types
  - parse chat-talk-link tree
  - convert into json

## License

Copyright 2021-2024 <a href='https://clue.surf'>ClueSurf</a>

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
