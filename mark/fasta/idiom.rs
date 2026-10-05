// fasta, the same generator, tables and line building as term.tree, written by hand as plain idiomatic Rust (ours,
// 2026-10-03): every character the Benchmarks Game would print, newlines too, folded into a hash, then the count and
// the hash printed
const ALU: &str = "GGCCGGGCGCGGTGGCTCACGCCTGTAATCCCAGCACTTTGGGAGGCCGAGGCGGGCGGATCACCTGAGGTCAGGAGTTCGAGACCAGCCTGGCCAACATGGTGAAACCCCGTCTCTACTAAAAATACAAAAATTAGCCGGGCGTGGTGGCGCGCGCCTGTAATCCCAGCTACTCGGGAGGCTGAGGCAGGAGAATCGCTTGAACCCGGGAGGCGGAGGTTGCAGTGAGCCGAGATCGCGCCACTGCACTCCAGCCTGGGCGACAGAGCGAGACTCCGTCTCAAAAA";
const MOD: i64 = 1_000_000_007;

struct State {
    seed: i64,
    hash: i64,
    count: i64,
}

impl State {
    fn fold(&mut self, line: &str) {
        for b in line.bytes() {
            self.hash = (self.hash * 31 + b as i64) % MOD;
        }

        self.hash = (self.hash * 31 + 10) % MOD;
        self.count += line.len() as i64 + 1;
    }

    fn repeated(&mut self, total: usize) {
        let alu = ALU.as_bytes();
        let mut line = String::with_capacity(60);

        for i in 0..total {
            line.push(alu[i % alu.len()] as char);

            if line.len() == 60 {
                self.fold(&line);
                line.clear();
            }
        }

        if !line.is_empty() {
            self.fold(&line);
        }
    }

    fn random(&mut self, letters: &[u8], cumulative: &[f64], total: usize) {
        let mut line = String::with_capacity(60);

        for _ in 0..total {
            self.seed = (self.seed * 3877 + 29573) % 139968;
            let r = self.seed as f64 / 139968.0;
            let mut pick = 0;

            while pick < letters.len() - 1 && r >= cumulative[pick] {
                pick += 1;
            }

            line.push(letters[pick] as char);

            if line.len() == 60 {
                self.fold(&line);
                line.clear();
            }
        }

        if !line.is_empty() {
            self.fold(&line);
        }
    }
}

fn accumulate(probabilities: &[f64]) -> Vec<f64> {
    let mut sum = 0.0;

    probabilities
        .iter()
        .map(|p| {
            sum += p;
            sum
        })
        .collect()
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(1000);
    let mut iub = vec![0.27, 0.12, 0.12, 0.27];
    iub.extend([0.02; 11]);
    let iub = accumulate(&iub);
    let homo = accumulate(&[0.3029549426680, 0.1979883004921, 0.1975473066391, 0.3015094502008]);
    let mut at = State { seed: 42, hash: 0, count: 0 };

    at.repeated(n * 2);
    at.random(b"acgtBDHKMNRSVWY", &iub, n * 3);
    at.random(b"acgt", &homo, n * 5);
    println!("{} {}", at.count, at.hash);
}
