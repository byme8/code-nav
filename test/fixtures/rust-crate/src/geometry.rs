use crate::{total_area, Circle, Shape, Square};

pub mod units {
    pub const SCALE: f64 = 2.0;
}

pub fn scaled_total() -> f64 {
    let shapes: Vec<Box<dyn Shape>> = vec![Box::new(Circle::new(1.0)), Box::new(Square { side: 2.0 })];
    total_area(&shapes) * units::SCALE
}
