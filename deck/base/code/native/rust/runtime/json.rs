mod json {
    use serde_json::Value;
    pub fn parse(text: String) -> Value { serde_json::from_str(&text).unwrap_or(Value::Null) }
    fn json_of(v: &dyn std::any::Any) -> Value {
        let v: &dyn std::any::Any = match v.downcast_ref::<std::rc::Rc<dyn std::any::Any>>() {
            Some(boxed) => boxed.as_ref(),
            None => v,
        };
        if let Some(json) = v.downcast_ref::<Value>() { return json.clone() }
        if let Some(s) = v.downcast_ref::<String>() { return Value::String(s.clone()) }
        if let Some(n) = v.downcast_ref::<i64>() { return Value::from(*n) }
        if let Some(n) = v.downcast_ref::<f64>() { return Value::from(*n) }
        if let Some(b) = v.downcast_ref::<bool>() { return Value::Bool(*b) }
        Value::Null
    }

    pub fn stringify<T: 'static>(value: T) -> String {
        let v: &dyn std::any::Any = &value;
        let v: &dyn std::any::Any = match v.downcast_ref::<std::rc::Rc<dyn std::any::Any>>() {
            Some(boxed) => boxed.as_ref(),
            None => v,
        };
        if let Some(json) = v.downcast_ref::<Value>() { return serde_json::to_string(json).unwrap_or_default() }
        if let Some(s) = v.downcast_ref::<String>() { return serde_json::to_string(s).unwrap_or_default() }
        if let Some(n) = v.downcast_ref::<i64>() { return n.to_string() }
        if let Some(n) = v.downcast_ref::<f64>() { return n.to_string() }
        if let Some(b) = v.downcast_ref::<bool>() { return b.to_string() }
        "null".to_string()
    }
    pub fn get_field<T: 'static>(value: T, key: String) -> Value { json_of(&value).get(&key).cloned().unwrap_or(Value::Null) }
    pub fn get_item<T: 'static>(value: T, index: i64) -> Value { json_of(&value).get(index as usize).cloned().unwrap_or(Value::Null) }
    pub fn as_number<T: 'static>(value: T) -> f64 { json_of(&value).as_f64().unwrap_or(0.0) }
    pub fn as_text<T: 'static>(value: T) -> String { json_of(&value).as_str().map(|s| s.to_string()).unwrap_or_default() }
    pub fn as_boolean<T: 'static>(value: T) -> bool { json_of(&value).as_bool().unwrap_or(false) }
    pub fn is_null<T: 'static>(value: T) -> bool { json_of(&value).is_null() }
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
    // the shape questions: what a parsed value is, so a reader can walk it without guessing
    pub fn is_array(value: Value) -> bool { value.is_array() }
    pub fn is_object(value: Value) -> bool { value.is_object() }
    pub fn is_text(value: Value) -> bool { value.is_string() }
    pub fn is_boolean(value: Value) -> bool { value.is_boolean() }
    pub fn array_size(value: Value) -> i64 { value.as_array().map(|items| items.len() as i64).unwrap_or(0) }
    pub fn array_item(value: Value, index: i64) -> Value { get_item(value, index) }
    pub fn object_keys(value: Value) -> Vec<String> {
        value.as_object().map(|map| map.keys().cloned().collect()).unwrap_or_default()
    }
}
