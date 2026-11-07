// projectResolver for STAGE0 (task/stage0.ts STAGE0_SOURCES, item term-self-host-001-1026): the port's project
// resolver, face-project-resolver over make-project-resolver (deck/call/code/work/build/host-faces.tree and
// project-resolving.tree), in the shape deck/call/code/make.ts's projectResolver answers, which is the shape port-build
// calls. It is the resolver host/line.js uses already. Taken from make.ts, the stage0 bundle carried that driver's whole
// closure (roll, reach, feed-mill, analyze and 16 more deck/call files) into term/host/compile.mjs, which ships.
import { makeProjectResolver } from '@term/call/code/work/build/project-resolving'
import { faceProjectResolver } from '@term/call/code/work/build/host-faces'
import type { Resolver } from '@term/make/code/compile/load'
import type { NativeEnv } from '@term/make/code/compile/native'

export function projectResolver(root: string, env: NativeEnv = 'node', fallbackLinkRoot?: string): Resolver {
  return faceProjectResolver(makeProjectResolver(root, env, fallbackLinkRoot ?? '')) as Resolver
}
