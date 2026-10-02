/**
 * One compiler-fuzzing campaign, as a standalone child-process entry point for running from SOURCE (the demo and
 * the vitest suite spawn it under tsx). The built CLI does not use this file: it carries `runFuzzCampaign` in its
 * own bundle and forks itself, because a path beside the running module does not exist inside host/line.js.
 *
 * Usage (normally spawned, not run by hand):
 *   tsx fuzz-campaign.ts <report-out> <probe-file> <runs> <seed> [<corpus.json>]
 */

import { runFuzzCampaign } from './compiler-fuzz'

runFuzzCampaign(process.argv.slice(2))
