import './test/shim'
import { readFileSync } from 'node:fs'
const { tonePack, toneUnpack } = await import('./host/link/@term/seed/code/tone')
const { makeKey } = await import('./host/code/seal/base')
const key = await makeKey()
console.log('makeKey bytes:', key.length)
const packed = tonePack(key)
console.log('packed chars:', packed.length)
const back = toneUnpack(packed)
console.log('unpacked bytes:', back.length)
const onDisk = readFileSync('/tmp/testkey', 'utf8')
console.log('file chars:', onDisk.length, '-> unpacks to', toneUnpack(onDisk).length, 'bytes')
