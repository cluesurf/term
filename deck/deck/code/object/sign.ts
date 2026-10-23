// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/object/sign.ts's exports, with
// their shapes, answered by deck/deck/code/object/id-signing.tree. The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-object-sign.
import * as port from '@term/deck/code/object/id-signing'


export type Keypair = { publicKey: string; privateKey: string }

export const generateKeypair = (): Keypair => port.generateKeypair() as Keypair
export const signId = (input: { id: string; privateKey: string }): string => port.signId(input.id, input.privateKey) as string
export const verifyId = (input: { id: string; sig: string; publicKey: string }): boolean => port.verifyId(input.id, input.sig, input.publicKey) as boolean
