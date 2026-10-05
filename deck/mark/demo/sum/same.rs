// The sum of 1 to size, the same algorithm as term.tree: the numbers into a vector, then folded.
fn main() {
    let size: i64 = std::env::args().nth(1).expect("size").parse().expect("size");
    let mut items: Vec<i64> = Vec::new();

    for i in 1..size + 1 {
        items.push(i);
    }

    let total = items.iter().fold(0i64, |sum, item| sum + item);

    println!("{}", total);
}
