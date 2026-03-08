# Debugging

## Breakpoints (`halt code`)

Insert a breakpoint that pauses execution:

```tree
task debug-add
  take a, like u64
  take b, like u64
  halt code
  send back
    call add
      bind a, read a
      bind b, read b
```

When the debugger hits `halt code`, it pauses and lets you inspect
variables. This is equivalent to the `debugger` statement in
JavaScript.

## Debugging Modes

The compiler supports two debugging modes:

**Interpreted mode**: Step through the program in the Seed
interpreter. Slower but more detailed.

**Compiled mode**: Debug the compiled output using the target
platform's debugger (e.g., Node.js inspector, lldb for Rust).
