// Polygon, ours, the same structure as term.tree, written by hand as plain idiomatic Rust (2026-10-03): 200 polygons a
// run, each a struct holding its corners' coordinates, built fresh and then measured, the taxicab perimeters added
struct Polygon {
    sides: usize,
    points: Vec<i64>,
}

fn make_polygon(k: i64) -> Polygon {
    let sides = 3 + (k % 13) as usize;
    let mut points = Vec::new();
    let mut x = k % 17;
    let mut y = (k * 7) % 23;

    for c in 0..sides as i64 {
        points.push(x);
        points.push(y);
        x = (x + c + k) % 50;
        y = (y + c * 3) % 50;
    }

    Polygon { sides, points }
}

fn perimeter(p: &Polygon) -> i64 {
    let mut total = 0;

    for c in 0..p.sides {
        let next = (c + 1) % p.sides;
        total += (p.points[c * 2] - p.points[next * 2]).abs() + (p.points[c * 2 + 1] - p.points[next * 2 + 1]).abs();
    }

    total
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(3);
    let mut total = 0;

    for _ in 0..n {
        let shapes: Vec<Polygon> = (0..200).map(make_polygon).collect();

        for p in &shapes {
            total += perimeter(p);
        }
    }

    println!("{}", total);
}
