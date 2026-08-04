// Host machine facts for the Web platform. Both counts are best-effort: `hardwareConcurrency` is capped by the
// browser for fingerprinting reasons, and `deviceMemory` is coarse-grained and absent outside Chromium, so each falls
// back rather than failing. Reached only through the public environment API.
const machine = {
  name: (): string => navigator.userAgent,
  cores: (): number => navigator.hardwareConcurrency || 1,
  memory: (): number =>
    ((navigator as { deviceMemory?: number }).deviceMemory || 0) *
    1073741824,
}
