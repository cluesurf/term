// Locale runtime for node. `Intl` is a JavaScript built-in rather than a node module, so it is reached here rather
// than through a `dock load` of a node namespace. Reached only through the public environment API.
const locale = {
  options: (): Intl.ResolvedDateTimeFormatOptions =>
    Intl.DateTimeFormat().resolvedOptions(),
}
