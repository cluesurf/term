// Towers, from Are We Fast Yet, written by hand as plain idiomatic Rust (ours, 2026-10-03): AWFY's own shape, disks
// linked into three piles and relinked as they move (each pile owns its stack, `Option<Box<Disk>>`), the moves counted
struct Disk {
    size: i64,
    next: Option<Box<Disk>>,
}

struct Towers {
    piles: [Option<Box<Disk>>; 3],
    moves: i64,
}

impl Towers {
    fn push_disk(&mut self, mut disk: Box<Disk>, pile: usize) {
        if let Some(top) = &self.piles[pile] {
            if disk.size >= top.size {
                panic!("Cannot put a big disk onto a smaller one");
            }
        }

        disk.next = self.piles[pile].take();
        self.piles[pile] = Some(disk);
    }

    fn pop_disk(&mut self, pile: usize) -> Box<Disk> {
        let mut top = self.piles[pile].take().expect("Attempting to remove a disk from an empty pile");
        self.piles[pile] = top.next.take();

        top
    }

    fn move_top(&mut self, from: usize, to: usize) {
        let disk = self.pop_disk(from);
        self.push_disk(disk, to);
        self.moves += 1;
    }

    fn build_tower(&mut self, pile: usize, disks: i64) {
        for i in (0..=disks).rev() {
            self.push_disk(Box::new(Disk { size: i, next: None }), pile);
        }
    }

    fn move_disks(&mut self, disks: i64, from: usize, to: usize) {
        if disks == 1 {
            self.move_top(from, to);
        } else {
            let other = 3 - from - to;
            self.move_disks(disks - 1, from, other);
            self.move_top(from, to);
            self.move_disks(disks - 1, other, to);
        }
    }
}

fn main() {
    let n: usize = std::env::args().nth(1).and_then(|a| a.parse().ok()).unwrap_or(2);
    let mut total = 0;

    for _ in 0..n {
        let mut towers = Towers { piles: [None, None, None], moves: 0 };
        towers.build_tower(0, 13);
        towers.move_disks(13, 0, 1);
        total += towers.moves;
    }

    println!("{}", total);
}
