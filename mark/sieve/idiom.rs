// Sieve, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic Rust (ours,
// 2026-10-03): a Vec of flags made full, each prime's multiples cleared, the count run `n` times and added
fn count_primes(flags: &mut [bool], size: usize) -> i64 {
    let mut primes = 0;

    for i in 2..=size {
        if flags[i - 1] {
            primes += 1;

            let mut k = i + i;

            while k <= size {
                flags[k - 1] = false;
                k += i;
            }
        }
    }

    primes
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(3);
    let mut total = 0;

    for _ in 0..n {
        let mut flags = vec![true; 5000];
        total += count_primes(&mut flags, 5000);
    }

    println!("{}", total);
}
