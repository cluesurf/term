// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): the exports deck/deck/code/hash.ts had, with
// their shapes, answered by deck/deck/code/package/content-hash.tree. The logic is Term; this file only converts shapes for TypeScript callers.
import * as port from '@term/deck/code/package/content-hash'


export const hashFile = async (input: { path: string }): Promise<string> => port.hashFile(input.path)
export const hashBuffer = async (input: { data: Buffer }): Promise<string> => port.hashBuffer(input.data)
export const hashText = async (input: { text: string }): Promise<string> => port.hashText(input.text)
export const verifyHash = (input: { data: Buffer; expected: string }): boolean => port.verifyHash(input.data, input.expected)
