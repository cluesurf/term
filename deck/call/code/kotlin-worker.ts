// One WARM Kotlin compiler for a session (live-reload). `kotlinc` starts a JVM and the compiler for every build, and on
// this Mac that alone is 13 seconds of a 30 second Compose build: an empty file takes 13.2s. A session that rebuilds on
// every edit keeps one compiler running instead: a JVM holding `K2JVMCompiler` with `kotlin.environment.keepalive`, the
// switch the Kotlin daemon itself uses to keep the compiler's environment between compilations.
//
// The worker is a few lines of Java run by the JDK's single-file source launcher, so it needs no build of its own and no
// library beyond the compiler jar it is started with, which it reaches by reflection. A request is the argument count on
// one line and then one argument a line; the reply is the compiler's messages and then a line `@@term-kotlin-done
// <exit>`. The compiler is given its messages stream, so nothing it prints can be mistaken for the reply.
//
// The builders (deck/call/code/compose.ts) call a compiler SYNCHRONOUSLY, as they call `kotlinc`, so the worker answers
// synchronously too: a worker thread owns the pipe to the JVM, and the caller waits on a shared flag (`Atomics.wait`)
// until the thread has the reply. One request at a time, which is what one dev loop makes.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads'

// what one compilation said: the exit status and the compiler's messages
export type KotlinRun = { status: number; output: string }

// a Kotlin compiler as the builders use one: `kotlinc`'s arguments in, its status and messages out
export type KotlinCompiler = (args: string[]) => KotlinRun

// `kotlinc` itself, a JVM per call: what a one-off build (`term make`, a test) uses
export const kotlinc: KotlinCompiler = args => {
  const ran = spawnSync('kotlinc', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

  return { status: ran.status ?? 1, output: `${ran.stdout}${ran.stderr}` }
}

const DONE = '@@term-kotlin-done '

const WORKER_JAVA = `import java.io.*;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;

// one warm Kotlin compiler: deck/call/code/kotlin-worker.ts writes this file and starts it
public class KotlinWorker {
  public static void main(String[] ignored) throws Exception {
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    PrintStream reply = new PrintStream(new FileOutputStream(FileDescriptor.out), true, "UTF-8");
    // anything else that prints goes to standard error, never into a reply
    System.setOut(System.err);
    Class<?> compiler = Class.forName("org.jetbrains.kotlin.cli.jvm.K2JVMCompiler");
    Method exec = compiler.getMethod("exec", PrintStream.class, String[].class);
    String count;
    while ((count = in.readLine()) != null) {
      String[] args = new String[Integer.parseInt(count.trim())];
      for (int i = 0; i < args.length; i++) args[i] = in.readLine();
      ByteArrayOutputStream said = new ByteArrayOutputStream();
      int status;
      try (PrintStream messages = new PrintStream(said, true, "UTF-8")) {
        Object exit = exec.invoke(compiler.getDeclaredConstructor().newInstance(), messages, args);
        status = (Integer) exit.getClass().getMethod("getCode").invoke(exit);
      } catch (Throwable thrown) {
        Throwable cause = thrown.getCause() != null ? thrown.getCause() : thrown;
        said.write(("error: the compiler threw " + cause + "\\n").getBytes(StandardCharsets.UTF_8));
        status = 2;
      }
      reply.print(said.toString("UTF-8"));
      reply.println();
      reply.println("${DONE}" + status);
    }
  }
}
`

// the thread that owns the pipe: it starts the JVM, writes each request, and hands back each reply through the port,
// raising the shared flag the caller is waiting on
const THREAD = `
const { spawn } = require('node:child_process')
const { workerData } = require('node:worker_threads')
const { java, args, cwd, port, flag } = workerData
const signal = new Int32Array(flag)
const child = spawn(java, args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] })
let buffer = ''
let ended = false
const answer = reply => {
  port.postMessage(reply)
  Atomics.store(signal, 0, 1)
  Atomics.notify(signal, 0)
}
child.stdout.setEncoding('utf8')
child.stdout.on('data', chunk => {
  buffer += chunk
  let at
  while ((at = buffer.indexOf(${JSON.stringify(DONE)})) >= 0) {
    const end = buffer.indexOf('\\n', at)
    if (end < 0) break
    const status = Number(buffer.slice(at + ${DONE.length}, end))
    answer({ status, output: buffer.slice(0, at) })
    buffer = buffer.slice(end + 1)
  }
})
child.on('exit', code => {
  ended = true
  answer({ status: 2, output: 'error: the Kotlin worker ended (exit ' + code + ')' })
})
port.on('message', request => {
  if (request === 'close') {
    child.stdin.end()
    port.close()
    return
  }
  if (ended) {
    answer({ status: 2, output: 'error: the Kotlin worker has ended' })
    return
  }
  child.stdin.write(request.length + '\\n' + request.join('\\n') + '\\n')
})
`

// the Kotlin home the `kotlinc` on the PATH belongs to, whose lib/ holds the compiler jar
function kotlinHome(): string {
  const found = spawnSync('which', ['kotlinc'], { encoding: 'utf8' }).stdout.trim()

  if (!found) {
    throw new Error('kotlinc is not installed')
  }

  // Homebrew's bin/kotlinc links into <cellar>/bin, whose libexec is the home; an unpacked release's bin is the home's
  const bin = dirname(realpathSync(found))
  const home = [join(bin, '..', 'libexec'), join(bin, '..')].find(dir => existsSync(join(dir, 'lib', 'kotlin-compiler.jar')))

  if (!home) {
    throw new Error(`no lib/kotlin-compiler.jar beside ${found}`)
  }

  return home
}

// the major version of the `java` on the PATH: `openjdk version "25.0.2"` is 25, `"1.8.0"` is 8
function javaMajor(): number {
  const said = spawnSync('java', ['-version'], { encoding: 'utf8' }).stderr ?? ''
  const found = /version "(\d+)(?:\.(\d+))?/.exec(said)

  return !found ? 0 : found[1] === '1' ? Number(found[2] ?? 0) : Number(found[1])
}

// a warm compiler, its source written into `dir`, which is also where it runs. `close` ends the JVM; a compile after
// it answers as failed
export function startKotlinWorker(dir: string): { compile: KotlinCompiler; close(): void } {
  const home = kotlinHome()
  mkdirSync(dir, { recursive: true })
  const source = join(dir, 'KotlinWorker.java')
  writeFileSync(source, WORKER_JAVA)

  const flag = new SharedArrayBuffer(4)
  const signal = new Int32Array(flag)
  const { port1: mine, port2: theirs } = new MessageChannel()
  const args = [
    '-Xmx3g',
    // what `kotlinc` passes from Java 24, which knows these flags: native access for the compiler, and no
    // `sun.misc.Unsafe` deprecation warnings printed into the session's output (KT-76799)
    ...(javaMajor() >= 24 ? ['--enable-native-access=ALL-UNNAMED', '--sun-misc-unsafe-memory-access=allow'] : []),
    `-Dkotlin.home=${home}`,
    '-Dkotlin.environment.keepalive=true',
    '-cp',
    join(home, 'lib', 'kotlin-compiler.jar'),
    source,
  ]
  const thread = new Worker(THREAD, { eval: true, workerData: { java: 'java', args, cwd: dir, port: theirs, flag }, transferList: [theirs] })
  thread.unref()

  return {
    compile: request => {
      Atomics.store(signal, 0, 0)
      mine.postMessage(request)
      // ten minutes, far past any build: a compiler that never answers fails the build rather than hanging the session
      Atomics.wait(signal, 0, 0, 600_000)

      return (receiveMessageOnPort(mine)?.message as KotlinRun | undefined) ?? { status: 2, output: 'error: the Kotlin worker gave no answer in ten minutes' }
    },
    close: () => {
      mine.postMessage('close')
      mine.close()
    },
  }
}
