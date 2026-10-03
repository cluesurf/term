// fannkuch-redux, single-threaded. Ours: a line-for-line transliteration of the Benchmarks Game's
// fannkuchredux.java-8.java (upstream/), "naive transliteration from Rex Kerr's Scala program", contributed by
// Isaac Gouy. Revised BSD, upstream/LICENSE. No plain single-threaded Rust entry exists in the Benchmarks Game.

fn fannkuch(n: usize) -> i32 {
    let mut perm1 = vec![0usize; n];
    for i in 0..n {
        perm1[i] = i;
    }
    let mut perm = vec![0usize; n];
    let mut count = vec![0usize; n];
    let mut f: i32;
    let mut flips: i32 = 0;
    let mut nperm: i32 = 0;
    let mut checksum: i32 = 0;
    let mut i: usize;
    let mut k: usize;
    let mut r: usize;

    r = n;
    while r > 0 {
        i = 0;
        while r != 1 {
            count[r - 1] = r;
            r -= 1;
        }
        while i < n {
            perm[i] = perm1[i];
            i += 1;
        }

        // Count flips and update max and checksum
        f = 0;
        k = perm[0];
        while k != 0 {
            i = 0;
            while 2 * i < k {
                let t = perm[i];
                perm[i] = perm[k - i];
                perm[k - i] = t;
                i += 1;
            }
            k = perm[0];
            f += 1;
        }
        if f > flips {
            flips = f;
        }
        if (nperm & 0x1) == 0 {
            checksum += f;
        } else {
            checksum -= f;
        }

        // Use incremental change to generate another permutation
        let mut more = true;
        while more {
            if r == n {
                println!("{}", checksum);
                return flips;
            }
            let p0 = perm1[0];
            i = 0;
            while i < r {
                let j = i + 1;
                perm1[i] = perm1[j];
                i = j;
            }
            perm1[r] = p0;

            count[r] -= 1;
            if count[r] > 0 {
                more = false;
            } else {
                r += 1;
            }
        }
        nperm += 1;
    }
    flips
}

fn main() {
    let n: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(7);
    println!("Pfannkuchen({}) = {}", n, fannkuch(n));
}
