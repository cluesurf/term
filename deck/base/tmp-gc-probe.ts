import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'
import { record, text, integer } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import { form, property, roleBase } from '@term/base/code/form/form'
const f = form('word', [property('term', { base: 'text' }), property('turn', { base: 'integer' })])
const repo = new Repository(new MemoryChunkStore(), new MemoryRefStore(), roleBase([f]))
const ds = datasetOf([record({ type: 'word', mark: '0195f0e6-1c4a-7bd3-9f2e-000000000000', fields: { term: text('a'), turn: integer(1) } })])
const done = repo.commit('main', { author: 'x', time: 1, message: 'm' }, ds)
console.log(JSON.stringify(done, null, 1).slice(0, 900))
