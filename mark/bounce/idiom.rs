// Bounce, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic Rust (ours,
// 2026-10-03): AWFY's own shape, a generator and a Vec of balls whose fields `bounce` changes in place
struct Random {
    seed: i64,
}

impl Random {
    fn next(&mut self) -> i64 {
        self.seed = (self.seed * 1309 + 13849) & 65535;
        self.seed
    }
}

struct Ball {
    x: i64,
    y: i64,
    dx: i64,
    dy: i64,
}

impl Ball {
    fn new(random: &mut Random) -> Self {
        let x = random.next() % 500;
        let y = random.next() % 500;
        let dx = random.next() % 300 - 150;
        let dy = random.next() % 300 - 150;

        Ball { x, y, dx, dy }
    }

    fn bounce(&mut self) -> bool {
        let mut bounced = false;
        self.x += self.dx;
        self.y += self.dy;

        if self.x > 500 {
            self.x = 500;
            self.dx = -self.dx.abs();
            bounced = true;
        }

        if self.x < 0 {
            self.x = 0;
            self.dx = self.dx.abs();
            bounced = true;
        }

        if self.y > 500 {
            self.y = 500;
            self.dy = -self.dy.abs();
            bounced = true;
        }

        if self.y < 0 {
            self.y = 0;
            self.dy = self.dy.abs();
            bounced = true;
        }

        bounced
    }
}

fn run() -> i64 {
    let mut random = Random { seed: 74755 };
    let mut balls: Vec<Ball> = (0..100).map(|_| Ball::new(&mut random)).collect();
    let mut bounces = 0;

    for _ in 0..50 {
        for ball in balls.iter_mut() {
            if ball.bounce() {
                bounces += 1;
            }
        }
    }

    bounces
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(2);
    let total: i64 = (0..n).map(|_| run()).sum();

    println!("{}", total);
}
