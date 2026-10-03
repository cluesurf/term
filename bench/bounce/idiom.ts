// Bounce, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic TypeScript (ours,
// 2026-10-03): AWFY's own shape, a generator object and a ball object whose fields `bounce` changes in place
class Random {
  seed = 74755

  next(): number {
    this.seed = (this.seed * 1309 + 13849) & 65535
    return this.seed
  }
}

class Ball {
  x: number
  y: number
  dx: number
  dy: number

  constructor(random: Random) {
    this.x = random.next() % 500
    this.y = random.next() % 500
    this.dx = (random.next() % 300) - 150
    this.dy = (random.next() % 300) - 150
  }

  bounce(): boolean {
    let bounced = false
    this.x += this.dx
    this.y += this.dy

    if (this.x > 500) {
      this.x = 500
      this.dx = -Math.abs(this.dx)
      bounced = true
    }

    if (this.x < 0) {
      this.x = 0
      this.dx = Math.abs(this.dx)
      bounced = true
    }

    if (this.y > 500) {
      this.y = 500
      this.dy = -Math.abs(this.dy)
      bounced = true
    }

    if (this.y < 0) {
      this.y = 0
      this.dy = Math.abs(this.dy)
      bounced = true
    }

    return bounced
  }
}

function run(): number {
  const random = new Random()
  const balls = Array.from({ length: 100 }, () => new Ball(random))
  let bounces = 0

  for (let round = 0; round < 50; round++) {
    for (const ball of balls) {
      if (ball.bounce()) {
        bounces++
      }
    }
  }

  return bounces
}

const n = Number(process.argv[2] ?? 2)
let total = 0

for (let i = 0; i < n; i++) {
  total += run()
}

console.log(total)
