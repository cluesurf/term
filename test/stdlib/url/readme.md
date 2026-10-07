# WHATWG URL corpus

Vendored from web-platform-tests, commit
`c48d58747e1f211527fb695fd60548a997fae617` (2026-09-19), directory
`url/resources/`. Fetched with `pnpm save:fetch`, which sends the generic
user-agent through `agentFor`.

| file | cases | sha256 |
| --- | --- | --- |
| `urltestdata.json` | 896 (269 failures) | `81e85fd3c199c08ef9c34cf651b3580eeedd080316493bfaf277a6b5ff8cf652` |
| `toascii.json` | 87 | `644eba9d5b593df8095cfa307222f3014542ff9cc02d555f8e5660059d80470f` |
| `IdnaTestV2.json` | 2,671 | `338192b9815dbdace6c035cb1acd50cd737070cd67d6e3f620d2543f63eb0cbb` |

Raw URL shape:
`https://raw.githubusercontent.com/web-platform-tests/wpt/c48d58747e1f211527fb695fd60548a997fae617/url/resources/<file>`

The harness is `../url.ts`. `known.json` is its ratchet: per backend and
corpus file, the case indexes still failing. It only shrinks.

## License

web-platform-tests is under the 3-Clause BSD License
(`LICENSE.md` at the same commit, sha256
`5fac07febb0e2a97fb0d7b0def149ec08b642e1ba4b9c345283ab1cbd2af6570`).

Copyright © web-platform-tests contributors

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice,
   this list of conditions and the following disclaimer.
2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.
3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from this
   software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
