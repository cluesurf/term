// spectral-norm, the same algorithm as term.tree, written by hand as plain idiomatic Rust (ours, 2026-10-02)
fn a(i: usize, j: usize) -> f64 {
    1.0 / (((i + j) * (i + j + 1) / 2 + i + 1) as f64)
}

fn times_a(v: &[f64], out: &mut [f64]) {
    for (i, o) in out.iter_mut().enumerate() {
        *o = v.iter().enumerate().map(|(j, x)| a(i, j) * x).sum();
    }
}

fn times_at(v: &[f64], out: &mut [f64]) {
    for (i, o) in out.iter_mut().enumerate() {
        *o = v.iter().enumerate().map(|(j, x)| a(j, i) * x).sum();
    }
}

fn times_ata(v: &[f64], out: &mut [f64], between: &mut [f64]) {
    times_a(v, between);
    times_at(between, out);
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(100);
    let mut u = vec![1.0; n];
    let mut v = vec![0.0; n];
    let mut between = vec![0.0; n];

    for _ in 0..10 {
        times_ata(&u, &mut v, &mut between);
        times_ata(&v, &mut u, &mut between);
    }

    let vbv: f64 = u.iter().zip(&v).map(|(a, b)| a * b).sum();
    let vv: f64 = v.iter().map(|b| b * b).sum();
    println!("{}", ((vbv / vv).sqrt() * 1_000_000_000.0).floor() as i64);
}
