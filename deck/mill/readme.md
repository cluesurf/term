<h3 align='center'>mill.tree</h3>
<p align='center'>
  The Seed DSL Library
</p>

<br/>

## Overview

mill.tree contains the DSL definitions for the Seed language's parsing
and compilation system. It provides the declarative grammars that drive
how `.tree` source is parsed, analyzed, and transformed.

### DSL Roles

Each directory under `code/` defines a DSL vocabulary (role).

| role   | note                                                                                                |
| ------ | :-------------------------------------------------------------------------------------------------- |
| `code` | Main programming language terms (task, form, call, fork, walk, etc.)                                |
| `form` | Simple struct definitions without methods or tasks                                                  |
| `bind` | Native binding declarations for code generation (form with `name`, task signatures, seed constants) |
| `mill` | Parser grammar definitions (mine, mint, mill)                                                       |
| `seed` | Configuration and settings (key-value constants)                                                    |
| `view` | UI component definitions                                                                            |
| `tune` | Audio processing definitions                                                                        |
| `flow` | Animation and transition definitions                                                                |
| `host` | Server route definitions (extends code with route hooks and port bindings)                          |
| `line` | CLI command definitions (extends code with argument handling)                                       |
| `base` | Database definitions (migrations with move next/back, queries with find)                            |
| `book` | Text content markup that generates to HTML, Markdown, or LaTeX                                      |
| `deck` | Package manifest definitions (name, version, dependencies, etc.)                                    |
| `lock` | Lockfile definitions (resolved dependency graph)                                                    |
| `text` | Internationalization string definitions (text term, string pairs)                                   |
| `tool` | CLI tool definitions (take, seed, show, send, hook, mill)                                           |

## License

Copyright 2021-2026+ <a href='https://clue.surf'>ClueSurf</a>

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
