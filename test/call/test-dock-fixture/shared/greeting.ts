// a TypeScript module the fixture's tsconfig `paths` maps (`@probe/shared/*`): no node_modules holds it, so a test
// docking it runs only when the bundle inlines it from source
export function greet(name: string): string {
  return `hello ${name}`
}
