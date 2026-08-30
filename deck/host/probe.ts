import * as S from './host/code/stream'
const anyS = S as any
const input = 'host a, -3.5\nhost b, true\nhost c, void\nhost d, <a \\<b\\> {c}>\nhost e, 0x1f\nhost f, 2.0\n'
const file = anyS.read ? anyS.read(input) : anyS.readRaw(input)
const got = anyS.write(file)
console.log('got :', JSON.stringify(got))
console.log('scalar of a text with braces:', JSON.stringify(anyS.scalar({ form: 'text', content: '<a \\<b\\> {c}>' })))
