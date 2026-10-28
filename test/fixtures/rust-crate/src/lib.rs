pub mod geometry;

pub const UNIT: f64 = 1.0;
pub static ORIGIN_NAME: &str = "origin";
pub type Area = f64;

pub trait Shape {
    fn area(&self) -> Area;
    fn name(&self) -> String {
        String::from("shape")
    }
}

pub struct Circle {
    pub radius: f64,
}

pub struct Square {
    pub side: f64,
}

pub enum Kind {
    Round,
    Angular,
}

impl Shape for Circle {
    fn area(&self) -> Area {
        3.0 * self.radius * self.radius
    }
}

impl Shape for Square {
    fn area(&self) -> Area {
        self.side * self.side
    }
}

impl Circle {
    pub fn new(radius: f64) -> Self {
        Circle { radius }
    }
}

macro_rules! square_of {
    ($x:expr) => {
        $x * $x
    };
}

pub fn total_area(shapes: &[Box<dyn Shape>]) -> Area {
    shapes.iter().map(|s| s.area()).sum()
}

pub fn describe() -> Area {
    let c = Circle::new(UNIT);
    c.area() + square_of!(UNIT)
}
