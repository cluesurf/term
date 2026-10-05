// binary-trees, the same algorithm as term.tree, written by hand as plain idiomatic Rust (ours, 2026-10-02): a node per
// allocation, as the Benchmarks Game requires (no arena, no free list)
enum Tree {
    Leaf,
    Branch(Box<Tree>, Box<Tree>),
}

fn bottom_up(depth: i64) -> Tree {
    if depth > 0 {
        Tree::Branch(Box::new(bottom_up(depth - 1)), Box::new(bottom_up(depth - 1)))
    } else {
        Tree::Leaf
    }
}

fn item_check(tree: &Tree) -> i64 {
    match tree {
        Tree::Leaf => 1,
        Tree::Branch(left, right) => 1 + item_check(left) + item_check(right),
    }
}

fn main() {
    let n: i64 = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(10);
    let max_depth = n.max(6);
    let stretch_depth = max_depth + 1;
    let mut out = format!("stretch tree of depth {}\t check: {}", stretch_depth, item_check(&bottom_up(stretch_depth)));
    let long_lived = bottom_up(max_depth);
    let mut depth = 4;
    while depth <= max_depth {
        let iterations = 1i64 << (max_depth - depth + 4);
        let check: i64 = (0..iterations).map(|_| item_check(&bottom_up(depth))).sum();
        out.push_str(&format!("\n{}\t trees of depth {}\t check: {}", iterations, depth, check));
        depth += 2;
    }
    out.push_str(&format!("\nlong lived tree of depth {}\t check: {}", max_depth, item_check(&long_lived)));
    println!("{}", out);
}
