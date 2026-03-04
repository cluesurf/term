# Debugging

## Breakpoints (`rest`)

Insert a breakpoint that pauses execution:

```tree
task debug-add
  take a, like u64
  take b, like u64
  rest
  send back
    call add
      bind a, read a
      bind b, read b
```

When the debugger hits `rest`, it pauses and lets you inspect
variables.

## Debugging Modes

The compiler supports two debugging modes:

**Interpreted mode**: Step through the program in the Seed
interpreter. Slower but more detailed.

**Compiled mode**: Debug the compiled output using the target
platform's debugger (e.g., Node.js inspector, lldb for Rust).

## REPL

The Seed REPL lets you evaluate expressions interactively:

```
seed repl
> mark 42
42
> call add, bind a, mark 1, bind b, mark 2
3
```
