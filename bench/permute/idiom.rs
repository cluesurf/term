// Permute, from Are We Fast Yet, written by hand as plain idiomatic Rust (ours, 2026-10-03): AWFY's own shape, a
// benchmark struct holding the counter and the six items, `permute` recursive and `swap` in place
struct Permute {
    count: i64,
    v: Vec<i64>,
}

impl Permute {
    fn permute(&mut self, n: usize) {
        self.count += 1;

        if n != 0 {
            let n1 = n - 1;
            self.permute(n1);

            for i in (0..=n1).rev() {
                self.v.swap(n1, i);
                self.permute(n1);
                self.v.swap(n1, i);
            }
        }
    }
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(2);
    let mut total = 0;

    for _ in 0..n {
        let mut run = Permute { count: 0, v: vec![0; 6] };
        run.permute(6);
        total += run.count;
    }

    println!("{}", total);
}
