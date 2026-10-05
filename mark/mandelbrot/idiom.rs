// mandelbrot, the same iteration as term.tree, written by hand as plain idiomatic Rust (ours, 2026-10-03): it counts
// the points in the set where the Benchmarks Game writes a bitmap
fn inside(cr: f64, ci: f64) -> bool {
    let (mut zr, mut zi, mut tr, mut ti) = (0.0, 0.0, 0.0, 0.0);

    for _ in 0..50 {
        if tr + ti > 4.0 {
            break;
        }

        zi = 2.0 * zr * zi + ci;
        zr = tr - ti + cr;
        tr = zr * zr;
        ti = zi * zi;
    }

    tr + ti <= 4.0
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(200);
    let size = n as f64;
    let mut count = 0;

    for y in 0..n {
        let ci = 2.0 * y as f64 / size - 1.0;

        for x in 0..n {
            let cr = 2.0 * x as f64 / size - 1.5;

            if inside(cr, ci) {
                count += 1;
            }
        }
    }

    println!("{count}");
}
