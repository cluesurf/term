// k-nucleotide, the same generator, table and counts as term.tree, written by hand as plain idiomatic Rust (ours,
// 2026-10-03): a HashMap of every k-mer per length, keyed by a slice of the sequence
use std::collections::HashMap;

fn sequence(n: usize) -> String {
    let mut seed: i64 = 42;
    let mut dna = String::with_capacity(n);

    for _ in 0..n {
        seed = (seed * 3877 + 29573) % 139968;
        let r = seed as f64 / 139968.0;
        dna.push(if r < 0.302954942668 { 'a' } else if r < 0.5009432431601 { 'c' } else if r < 0.6984905497992 { 'g' } else { 't' });
    }

    dna
}

fn frequencies(dna: &str, k: usize) -> HashMap<&str, i64> {
    let mut counts = HashMap::new();

    if dna.len() >= k {
        for i in 0..=dna.len() - k {
            *counts.entry(&dna[i..i + k]).or_insert(0) += 1;
        }
    }

    counts
}

fn summary(dna: &str, k: usize) -> String {
    let counts = frequencies(dna, k);

    format!("{}:{}", counts.len(), counts.values().copied().max().unwrap_or(0))
}

fn occurrences(dna: &str, part: &str) -> i64 {
    frequencies(dna, part.len()).get(part).copied().unwrap_or(0)
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(1000);
    let dna = sequence(n);
    let parts: Vec<String> = ["ggt", "ggta", "ggtatt", "ggtattttaatt", "ggtattttaatttatagt"]
        .iter()
        .map(|p| occurrences(&dna, p).to_string())
        .collect();

    println!("{} {} {}", summary(&dna, 1), summary(&dna, 2), parts.join(" "));
}
