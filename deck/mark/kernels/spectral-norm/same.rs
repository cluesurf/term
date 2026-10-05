// spectral-norm, single-threaded. Ours: a line-for-line transliteration of the Benchmarks Game's
// spectralnorm.swift-8.swift (upstream/), "naive transliteration from Sebastien Loisel's C program", contributed by
// Isaac Gouy. Revised BSD, upstream/LICENSE. The Benchmarks Game's Rust entries are multi-threaded or SIMD.

fn eval_a(i: usize, j: usize) -> f64 {
    1.0 / ((i + j) * (i + j + 1) / 2 + i + 1) as f64
}

fn eval_a_times_u(n: usize, u: &[f64], au: &mut [f64]) {
    for i in 0..n {
        au[i] = 0.0;
        for j in 0..n {
            au[i] += eval_a(i, j) * u[j];
        }
    }
}

fn eval_at_times_u(n: usize, u: &[f64], au: &mut [f64]) {
    for i in 0..n {
        au[i] = 0.0;
        for j in 0..n {
            au[i] += eval_a(j, i) * u[j];
        }
    }
}

fn eval_ata_times_u(n: usize, u: &[f64], atau: &mut [f64]) {
    let mut v = vec![0.0; n];
    eval_a_times_u(n, u, &mut v);
    eval_at_times_u(n, &v, atau);
}

fn main() {
    let n: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(100);
    let mut u = vec![1.0; n];
    let mut v = vec![0.0; n];
    for _ in 0..10 {
        eval_ata_times_u(n, &u, &mut v);
        eval_ata_times_u(n, &v, &mut u);
    }
    let mut vbv = 0.0;
    let mut vv = 0.0;
    for i in 0..n {
        vbv += u[i] * v[i];
        vv += v[i] * v[i];
    }
    println!("{:.9}", (vbv / vv).sqrt());
}
