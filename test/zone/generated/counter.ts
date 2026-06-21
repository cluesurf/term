import { signal } from '@cluesurf/make/code/zone/reactive'

export function counter() {
  const [count, setCount] = signal(undefined)
  function onClick() {
    setCount(count() + undefined)
  }
  return { count, onClick }
}
