// Queens, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic Rust (ours,
// 2026-10-03): the board in one struct's arrays, placement by backtracking, a checksum of each placement added
struct Queens {
    rows: [bool; 8],
    maxs: [bool; 16],
    mins: [bool; 16],
    queens: [i64; 8],
}

impl Queens {
    fn new() -> Self {
        Queens { rows: [true; 8], maxs: [true; 16], mins: [true; 16], queens: [-1; 8] }
    }

    fn is_free(&self, r: usize, c: usize) -> bool {
        self.rows[r] && self.maxs[c + r] && self.mins[c + 7 - r]
    }

    fn mark(&mut self, r: usize, c: usize, free: bool) {
        self.rows[r] = free;
        self.maxs[c + r] = free;
        self.mins[c + 7 - r] = free;
    }

    fn place(&mut self, c: usize) -> bool {
        for r in 0..8 {
            if self.is_free(r, c) {
                self.queens[r] = c as i64;
                self.mark(r, c, false);

                if c == 7 || self.place(c + 1) {
                    return true;
                }

                self.mark(r, c, true);
            }
        }

        false
    }

    fn solve(&mut self) -> i64 {
        if self.place(0) {
            self.queens.iter().enumerate().map(|(r, q)| (r as i64 + 1) * q).sum()
        } else {
            0
        }
    }
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(10);
    let total: i64 = (0..n).map(|_| Queens::new().solve()).sum();

    println!("{}", total);
}
