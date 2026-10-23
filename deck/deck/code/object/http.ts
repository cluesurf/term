// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/http.ts's exports, with
// their shapes, answered by deck/deck/code/object/registry-client.tree. The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-http.
import * as port from '@term/deck/code/object/registry-client'


export const httpRegistry = (input: { baseUrl: string; token?: string }): never => port.httpRegistry(input.baseUrl, input.token) as never
