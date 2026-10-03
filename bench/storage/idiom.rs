// Storage, from Are We Fast Yet, the same structure as term.tree, written by hand as plain idiomatic Rust (ours,
// 2026-10-03): a tree of Vecs seven levels deep built by recursion, AWFY's generator sizing each leaf, the Vecs counted
// and every leaf's length read back, run `n` times and added
enum Tree {
    Leaf(Vec<i64>),
    Node(Vec<Tree>),
}

struct Random {
    seed: i64,
}

impl Random {
    fn next(&mut self) -> i64 {
        self.seed = (self.seed * 1309 + 13849) & 65535;
        self.seed
    }
}

fn build(depth: i64, random: &mut Random, count: &mut i64) -> Tree {
    *count += 1;

    if depth == 1 {
        return Tree::Leaf(vec![0; (random.next() % 10 + 1) as usize]);
    }

    Tree::Node((0..4).map(|_| build(depth - 1, random, count)).collect())
}

fn leaves(tree: &Tree) -> i64 {
    match tree {
        Tree::Leaf(items) => items.len() as i64,
        Tree::Node(kids) => kids.iter().map(leaves).sum(),
    }
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(3);
    let mut total = 0;

    for _ in 0..n {
        let mut random = Random { seed: 74755 };
        let mut count = 0;
        let tree = build(7, &mut random, &mut count);
        total += count + leaves(&tree);
    }

    println!("{}", total);
}
