// Machine facts for node. The names are node's own, so every other backend maps onto them. Reached only through the
// public machine API.
import { cpus as machineCpus } from 'node:os'

const machine = {
  // `os.cpus()` is empty where the platform hides its processors, and a pool of none runs nothing
  cores: (): number => Math.max(1, machineCpus().length),
  platform: (): string => process.platform,
  architecture: (): string => process.arch,
}
