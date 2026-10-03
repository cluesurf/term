// Graph, ours, the same structure as term.tree, written by hand as plain idiomatic Rust (2026-10-03): a grid's
// adjacency lists built fresh each run and searched breadth-first from the corner, the distances added
fn neighbors(side: usize) -> Vec<Vec<usize>> {
    let mut cells = Vec::new();

    for at in 0..side * side {
        let (row, column) = (at / side, at % side);
        let mut near = Vec::new();

        if row > 0 {
            near.push(at - side);
        }
        if column > 0 {
            near.push(at - 1);
        }
        if column < side - 1 {
            near.push(at + 1);
        }
        if row < side - 1 {
            near.push(at + side);
        }

        cells.push(near);
    }

    cells
}

fn search(cells: &[Vec<usize>]) -> i64 {
    let mut distance = vec![-1i64; cells.len()];
    let mut queue = vec![0usize];
    distance[0] = 0;
    let mut total = 0;
    let mut head = 0;

    while head < queue.len() {
        let at = queue[head];
        head += 1;
        let here = distance[at];
        total += here;

        for &next in &cells[at] {
            if distance[next] == -1 {
                distance[next] = here + 1;
                queue.push(next);
            }
        }
    }

    total
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(3);
    let mut total = 0;

    for _ in 0..n {
        total += search(&neighbors(40));
    }

    println!("{}", total);
}
