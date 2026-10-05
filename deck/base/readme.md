<br/>
<br/>
<br/>

<h3 align='center'>@term/base</h3>
<p align='center'>
  The Term standard library
</p>

<br/>
<br/>
<br/>

Every module is `.tree` source compiled with the program, for TypeScript
(node and the browser), Rust, Swift and Kotlin. A module either is pure
Term, the same code on every target, or delegates to one native file
per platform under `code/native/<platform>/`.

**One meaning, every target.** Where platforms disagree, the library
picks one answer and every target gives it:

| question | answer |
| --- | --- |
| text positions and lengths | Unicode code points |
| text order and equality | by code point |
| map and set iteration | the order keys were first set |
| a number as text | the shortest digits that read back, laid out as ECMAScript does (`2`, `1e+21`, `NaN`) |
| `clock/now` | monotonic milliseconds; `time/now` is the wall clock |
| a list read past the end | the program stops |
| invalid JSON | `json-mismatch`, with the position and the reason |
| a sort | stable |

## Modules

| area | modules |
| --- | --- |
| values | `boolean`, `integer/*`, `float`, `decimal`, `rational`, `complex`, `math`, `bit`, `bytes`, `uuid` |
| collections | `list` (with `sort`, `zip`, `group-by`, `chunk` and more), `hash`, `set`, `pair`, `maybe`, `result`, `ordering`, `range`, `walk`, `list/{deque,queue,stack,heap}`, `bitset` |
| text | `text`, `text/unicode`, `text/string`, `rune`, `regex`, `text/base64`, `text/hex` |
| data | `json`, `json/check`, `csv`, `url` |
| time | `time`, `clock`, `calendar`, `plain-date`, `duration`, `timezone` |
| system | `file`, `file/directory`, `path`, `environment`, `process`, `process/current`, `process/run`, `console`, `log` |
| network | `network/http`, `network/server`, `network/tcp`, `network/udp`, `network/websocket`, `network/dns` |
| concurrency | `task`, `channel`, `mutex`, `atomic` |
| security | `cryptography/{digest,hmac,cipher,signature,key-agreement,random}` |
| randomness | `random` (host generator), `random/seeded` (the same sequence everywhere for a seed) |
| errors | `exception`, `hive` |

A module carrying `note draft` is shelved: kept in the tree, out of
every build.

## License

Copyright <a href='https://clue.surf'>ClueSurf</a>

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
