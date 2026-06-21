mod json {
    use serde_json::Value;
    pub fn parse(text: String) -> Value { serde_json::from_str(&text).unwrap_or(Value::Null) }
    pub fn stringify(value: Value) -> String { serde_json::to_string(&value).unwrap_or_default() }
    pub fn get_field(value: Value, key: String) -> Value { value.get(&key).cloned().unwrap_or(Value::Null) }
    pub fn get_item(value: Value, index: i64) -> Value { value.get(index as usize).cloned().unwrap_or(Value::Null) }
    pub fn as_number(value: Value) -> f64 { value.as_f64().unwrap_or(0.0) }
    pub fn as_text(value: Value) -> String { value.as_str().map(|s| s.to_string()).unwrap_or_default() }
    pub fn as_boolean(value: Value) -> bool { value.as_bool().unwrap_or(false) }
    pub fn is_null(value: Value) -> bool { value.is_null() }
    pub fn make_object() -> Value { Value::Object(serde_json::Map::new()) }
    pub fn set_field(mut value: Value, key: String, field: Value) -> Value {
        if let Value::Object(map) = &mut value { map.insert(key, field); }
        value
    }
    pub fn make_array() -> Value { Value::Array(Vec::new()) }
    pub fn push_item(mut value: Value, item: Value) -> Value {
        if let Value::Array(items) = &mut value { items.push(item); }
        value
    }
    pub fn from_text(value: String) -> Value { Value::String(value) }
    pub fn from_number(value: f64) -> Value { serde_json::json!(value) }
    pub fn from_boolean(value: bool) -> Value { Value::Bool(value) }
    pub fn make_null() -> Value { Value::Null }
}
