// Particle, ours, the same structure as term.tree, written by hand as plain idiomatic Rust (2026-10-03): 100 structs
// each holding 8 coordinates, every coordinate rewritten in place for 50 steps, then all added
struct Particle {
    #[allow(dead_code)]
    id: i64,
    xs: Vec<i64>,
}

fn make_particle(k: i64) -> Particle {
    Particle { id: k, xs: (0..8).map(|i| (k * 7 + i) % 1000).collect() }
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(3);
    let mut total = 0;

    for _ in 0..n {
        let mut ps: Vec<Particle> = (0..100).map(make_particle).collect();

        for step in 0..50 {
            for p in ps.iter_mut() {
                for (i, x) in p.xs.iter_mut().enumerate() {
                    *x = (*x * 31 + i as i64 + step) % 1000;
                }
            }
        }

        total += ps.iter().map(|p| p.xs.iter().sum::<i64>()).sum::<i64>();
    }

    println!("{}", total);
}
