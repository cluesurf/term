# Main Libraries in StarTree

These are open source building blocks used to make up the StarTree
framework. Calling StarTree a framework is kind of a misnomer, it is
basically the minimal set of conventions for building packages.

1. `@cluesurf/bind`: The StarTree Environment Binding Library
1. `@cluesurf/star`: The StarTree Data Type Library
1. `@cluesurf/moon`: The StarTree Environment Tooling Library
1. `@cluesurf/hare`: The StarTree Data Structure Library
1. `@cluesurf/worm`: The StarTree Content Grammar Library
1. `@cluesurf/mesh`: The StarTree Compiler Library
1. `@cluesurf/fish`: The StarTree Linting Library
1. `@cluesurf/wolf`: The StarTree File Manipulation Library
1. `@cluesurf/StarTree`: The StarTree Third-Party Integration Library
1. `@cluesurf/crow`: The StarTree Drawing Library
1. `@cluesurf/nest`: The StarTree Resource Provisioning Library
1. `@cluesurf/snow`: The StarTree Querying Library
1. `@cluesurf/door`: The StarTree Permission Library
1. `@cluesurf/seed`: The StarTree Math Library
1. `@cluesurf/tree`: The StarTree DSL Library

## `@cluesurf/bind`

This is the set of interfaces built into the native environments, as
well as a few very general types. This is the foundation of everything
else.

## `@cluesurf/star`

This is the "standard library", and builds the basic interfaces on top
of the main datatypes, leaving the rest of the environment to be
abstracted out in `@cluesurf/moon`.

## `@cluesurf/moon`

This builds on top of the standard library and includes abstractions
over the common environment interfaces to normalize them across
platforms.

- File system
- Browser
- Camera
- Flashlight
- Crypto
- Network
- Processes
- Accelerometer
- Geolocation
- GPU
- Logging
- REPL
- CLI parsing
- Threads
- Web workers
- Battery
- Clipboard
- Cookies
- Gamepad
- Email
- Speech recognition
- Speech synthesis
- Video
- Screen capture
- Audio
- Drag and drop
- Payments
- Testing

## `@cluesurf/hare`

This is an abstraction over data structures, and aims to include as many
of them as possible.

## `@cluesurf/worm`

This is for parsing and writing text and/or bytes.

## `@cluesurf/mesh`

This is the main StarTree compiler. It takes input text and compiles it
to a mesh, then runs typechecking / typeinference on it and everything,
and outputs builds for target environments.

This is where the `mine` and `mint` DSLs are defined, amongst other
things.

## `@cluesurf/fish`

This is for linting and prettifying various forms of text. It is used to
format, for example, the generated source code output from the compiler.

## `@cluesurf/wolf`

This is for dealing with different files. It includes:

- Zip files
- Images
- Videos
- PDFs
- XLSX
- JSON
- XML
- HTML
- CSS

## `@cluesurf/StarTree`

This is for third-party library integrations like with GitHub and
Vercel.

## `@cluesurf/crow`

This is for managing the UI and defining UI components. This includes
DOM trees like React, WebGL graphics, game graphics like Pixi.js, and
game physics. Ideally there are both 2d and 3d variants.

## `@cluesurf/nest`

This is for managing the provisioning of "resources" like databases and
other infrastructure.

## `@cluesurf/snow`

This is for managing querying and mutations of all sorts, from the
API-level down to database levels. As such, it is an abstraction over
databases. This includes job processing as well.

## `@cluesurf/tree`

This is the set of collected DSLs for building the things in the various
libraries. This makes it so the libraries are not bound by the DSLs, and
you can write your own DSL on top of the base libraries if you really
wanted.

## Inspiration

- https://github.com/thi-ng/umbrella
