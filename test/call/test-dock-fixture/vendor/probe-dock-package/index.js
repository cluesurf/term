// an npm package the fixture project carries in its own node_modules (test/call/test-dock.ts installs it there): the
// install's node_modules does not hold it, so a test docking it resolves only from the project
export function shout(text) {
  return text.toUpperCase()
}
