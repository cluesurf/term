import { signal } from '@/code/zone/reactive'

export function counter() {
  const [count, setCount] = signal(0)
  function onClick() {
    setCount(count() + 1)
  }
  return { count, onClick }
}
