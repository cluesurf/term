# Defining a Server in TermTree

```
load @cluesurf/base
  find host, like task

call host, size 3773
  hook request
    take request
    call request/write, text <hello world>
```

This is the most basic approach to defining a server.

That internally _creates a server_ and binds it to the port.

## Inspiration

- https://github.com/websockets/ws
