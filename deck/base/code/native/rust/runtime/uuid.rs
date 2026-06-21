mod uuid {
    pub fn version4() -> String { ::uuid::Uuid::new_v4().to_string() }
}
