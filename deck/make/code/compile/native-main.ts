// THE MAIN THAT CALLS A PROGRAM, written once for every backend: what `term make --emit X --build` appends and what the
// test harnesses append, so a program runs the same way under both (note/term/plan/backends-complete.md, step 1).
//
// It drives the entry the way its signature asks: an asynchronous one on the program's executor (Rust's
// `__term_block_on`, Kotlin's `termLoop`, Swift's top-level `await`), a raising one to its raise on stderr and exit 1,
// and prints what it answered with no line break after it, or nothing for an entry that answers nothing (`boot`).
//
// AND IT RUNS THE ENTRY ON A THREAD WITH A LARGE STACK on Rust, Swift and Kotlin, as GHC's and OCaml's runtimes give
// theirs. A recursive form is released recursively by Swift (an `indirect enum` has no `deinit` to unlink it in a loop),
// so a linked list of 200,000 nodes ended the program when it was dropped, with no message, where Rust and Kotlin went
// on (test/stdlib/ordered-collections.ts, 2026-10-05). The same stack holds a deep recursion in the program's own code
// alike on all three. 1 GiB is reserved address space, not memory: a page is committed only when it is touched.
// TypeScript runs on node's own stack, which a program cannot widen safely.

export type MainBackend = 'rust' | 'swift' | 'kotlin'

export const ENTRY_STACK_BYTES = 1 << 30

// the entries a program is run by, in the order one is chosen when none is named
export const ENTRY_NAMES = ['run', 'boot', 'main']

// a Term task name as each backend spells it: `run-all` is `run_all` on Rust and `runAll` elsewhere. `main` is `main_`
// on Rust and Kotlin, which reserve it for the main this module writes (compile/rust.ts `RUST_RESERVED`, kotlin.ts `camel`)
export function entrySpelling(backend: MainBackend | 'node', name: string): string {
  const spelled = backend === 'rust' ? name.replace(/-/g, '_') : name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())

  return spelled === 'main' && (backend === 'rust' || backend === 'kotlin') ? 'main_' : spelled
}

// the entry `emitted` defines: `named`, or the first of ENTRY_NAMES it has, as the backend spells it
export function entryOf(backend: MainBackend | 'node', emitted: string, named?: string): string | undefined {
  const declares = (spelled: string): boolean => {
    const word = spelled.replace(/[$]/g, '\\$')

    return backend === 'rust'
      ? new RegExp(`\\bfn ${word}\\(\\)`).test(emitted)
      : backend === 'swift'
        ? new RegExp(`\\bfunc ${word}\\(\\)`).test(emitted)
        : backend === 'kotlin'
          ? new RegExp(`\\bfun ${word}\\(\\)`).test(emitted)
          : new RegExp(`\\bfunction ${word}\\(\\)`).test(emitted)
  }

  for (const name of named ? [named] : ENTRY_NAMES) {
    const spelled = entrySpelling(backend, name)

    if (declares(spelled)) {
      return spelled
    }
  }

  return undefined
}

// the main for `entry` (already spelled for the backend) in `emitted`, a backend's output, to be appended to it.
// `threads` false is a Rust main with no thread of its own, for a target that has none: WebAssembly under WASI
export function nativeMain(backend: MainBackend, emitted: string, entry = 'run', threads = true): string {
  if (backend === 'rust' && !threads) {
    const signature = new RegExp(`(async )?fn ${entry}\\(\\)( -> ([^{]+))?\\s*\\{`).exec(emitted)
    const answers = signature?.[3]?.trim()
    const raises = answers?.startsWith('std::result::Result') ?? false
    const called = signature?.[1] ? `__term_block_on(${entry}())` : `${entry}()`
    const finished = raises ? `${called}.unwrap_or_else(|e| { eprintln!("{}", e); std::process::exit(1) })` : called
    const silent = answers === undefined || answers === '()' || /^std::result::Result<\(\),/.test(answers ?? '')

    return silent ? `fn main() { ${finished}; }` : `fn main() { print!("{}", ${finished}); }`
  }

  if (backend === 'rust') {
    const signature = new RegExp(`(async )?fn ${entry}\\(\\)( -> ([^{]+))?\\s*\\{`).exec(emitted)
    const answers = signature?.[3]?.trim()
    const raises = answers?.startsWith('std::result::Result') ?? false
    const called = signature?.[1] ? `__term_block_on(${entry}())` : `${entry}()`
    const finished = raises ? `${called}.unwrap_or_else(|e| { eprintln!("{}", e); std::process::exit(1) })` : called
    // an entry that answers nothing, or only `()` through its Result, prints nothing
    const silent = answers === undefined || answers === '()' || /^std::result::Result<\(\),/.test(answers ?? '')
    const body = silent ? `{ ${finished}; String::new() }` : `format!("{}", ${finished})`

    return [
      'fn main() {',
      `    let answer = std::thread::Builder::new().stack_size(${ENTRY_STACK_BYTES}).spawn(|| ${body}).unwrap().join();`,
      '    match answer { Ok(text) => print!("{}", text), Err(_) => std::process::exit(101) }',
      '}',
    ].join('\n')
  }

  if (backend === 'swift') {
    const signature = new RegExp(`func ${entry}\\(\\)( async)?( throws)?( -> ([^{]+))?\\s*\\{`).exec(emitted)
    const raises = Boolean(signature?.[2])
    const silent = signature?.[4] === undefined || signature[4].trim() === 'Void'

    // an asynchronous entry runs on Swift's own executor, whose threads it does not let a program size: awaited at the
    // top level, as before
    if (signature?.[1]) {
      return silent ? `${raises ? 'try ' : ''}await ${entry}()` : `print(${raises ? 'try ' : ''}await ${entry}(), terminator: "")`
    }

    const value = silent ? `${raises ? 'try ' : ''}${entry}()` : `__termAnswer = "\\(${raises ? 'try ' : ''}${entry}())"`
    const call = raises ? `do { ${value} } catch { FileHandle.standardError.write("\\(error)\\n".data(using: .utf8)!); exit(1) }` : value

    return [
      'var __termAnswer = ""',
      'let __termDone = DispatchSemaphore(value: 0)',
      `let __termThread = Thread { ${call}; __termDone.signal() }`,
      `__termThread.stackSize = ${ENTRY_STACK_BYTES}`,
      '__termThread.start()',
      '__termDone.wait()',
      'print(__termAnswer, terminator: "")',
    ].join('\n')
  }

  const suspending = new RegExp(`suspend fun ${entry}\\(\\)`).test(emitted)
  const answers = new RegExp(`fun ${entry}\\(\\)\\s*:\\s*([^={]+)`).exec(emitted)?.[1]?.trim()
  const silent = answers === undefined || answers === 'Unit'
  const called = suspending ? `termLoop.block { ${entry}() }` : `${entry}()`

  return [
    'fun main() {',
    '    var answer = ""',
    '    var failure: Throwable? = null',
    `    val thread = Thread(null, { try { ${silent ? called : `answer = "" + ${called}`} } catch (e: Throwable) { failure = e } }, "term", ${ENTRY_STACK_BYTES}L)`,
    '    thread.start()',
    '    thread.join()',
    '    failure?.let { throw it }',
    '    print(answer)',
    '}',
  ].join('\n')
}

// the stdlib's crates (`cargoToml` is deck/base/code/native/rust/Cargo.toml) a Rust source names, each as its manifest
// line: a program that names one is a cargo project with those crates alone
export function cratesNamed(source: string, cargoToml: string): string[] {
  const table = (cargoToml.split('[dependencies]')[1] ?? '').split(/\n\[/)[0] ?? ''

  return table.split('\n').filter(line => {
    const crate = /^([A-Za-z0-9_-]+)\s*=/.exec(line)?.[1]

    return crate !== undefined && source.includes(`${crate.replaceAll('-', '_')}::`)
  })
}
