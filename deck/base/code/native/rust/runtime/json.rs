mod json {
    // A JSON value is a boxed dynamic like any other (decision term/compiler/011). A text, number, boolean or null is the
    // Term value itself in the box, an array or object is the serde_json::Value in the box, read through these accessors.
    use serde_json::Value;
    use std::any::Any;
    use std::cell::RefCell;
    use std::rc::Rc;
    type Boxed = Rc<dyn Any>;
    fn boxed(value: Value) -> Boxed {
        match value {
            Value::Null => Rc::new(()),
            Value::Bool(b) => Rc::new(b),
            Value::String(s) => Rc::new(s),
            Value::Number(n) => match n.as_i64() {
                Some(i) => Rc::new(i),
                None => Rc::new(n.as_f64().unwrap_or(0.0)),
            },
            other => Rc::new(other),
        }
    }
    // a whole float writes as a whole number, as it does on TypeScript. Negative zero stays a float, so a read keeps its sign
    fn number_value(n: f64) -> Value {
        if n == 0.0 && n.is_sign_negative() { return Value::from(n) }
        if n.fract() == 0.0 && n.abs() < 9007199254740992.0 { return Value::from(n as i64) }
        Value::from(n)
    }
    // negative zero writes as 0 at any depth, as JSON.stringify writes it
    fn written(value: Value) -> Value {
        match value {
            Value::Number(n) if n.as_f64() == Some(0.0) => Value::from(0),
            Value::Array(items) => Value::Array(items.into_iter().map(written).collect()),
            Value::Object(map) => Value::Object(map.into_iter().map(|(key, item)| (key, written(item))).collect()),
            other => other,
        }
    }
    fn json_of(v: &dyn Any) -> Value {
        let v: &dyn Any = match v.downcast_ref::<Boxed>() {
            Some(inner) => inner.as_ref(),
            None => v,
        };
        if let Some(json) = v.downcast_ref::<Value>() { return json.clone() }
        if let Some(s) = v.downcast_ref::<String>() { return Value::String(s.clone()) }
        if let Some(n) = v.downcast_ref::<i64>() { return Value::from(*n) }
        if let Some(n) = v.downcast_ref::<f64>() { return number_value(*n) }
        if let Some(b) = v.downcast_ref::<bool>() { return Value::Bool(*b) }
        if let Some(items) = v.downcast_ref::<Rc<RefCell<Vec<Boxed>>>>() {
            return Value::Array(items.borrow().iter().map(|item| json_of(item)).collect())
        }
        if let Some(items) = v.downcast_ref::<Rc<RefCell<Vec<String>>>>() {
            return Value::Array(items.borrow().iter().map(|item| Value::String(item.clone())).collect())
        }
        if let Some(items) = v.downcast_ref::<Rc<RefCell<Vec<i64>>>>() {
            return Value::Array(items.borrow().iter().map(|item| Value::from(*item)).collect())
        }
        Value::Null
    }
    pub fn parse(text: String) -> Boxed { boxed(serde_json::from_str(&text).unwrap_or(Value::Null)) }
    pub fn stringify<T: 'static>(value: T) -> String { serde_json::to_string(&written(json_of(&value))).unwrap_or_default() }
    pub fn get_field<T: 'static>(value: T, key: String) -> Boxed { boxed(json_of(&value).get(&key).cloned().unwrap_or(Value::Null)) }
    pub fn get_item<T: 'static>(value: T, index: i64) -> Boxed { boxed(json_of(&value).get(index as usize).cloned().unwrap_or(Value::Null)) }
    pub fn as_number<T: 'static>(value: T) -> f64 { json_of(&value).as_f64().unwrap_or(0.0) }
    pub fn as_text<T: 'static>(value: T) -> String { json_of(&value).as_str().map(|s| s.to_string()).unwrap_or_default() }
    pub fn as_boolean<T: 'static>(value: T) -> bool { json_of(&value).as_bool().unwrap_or(false) }
    pub fn is_null<T: 'static>(value: T) -> bool { json_of(&value).is_null() }
    pub fn make_object() -> Boxed { Rc::new(Value::Object(serde_json::Map::new())) }
    pub fn set_field(value: Boxed, key: String, field: Boxed) -> Boxed {
        let mut held = json_of(&value);
        if let Value::Object(map) = &mut held { map.insert(key, json_of(&field)); }
        Rc::new(held)
    }
    pub fn make_array() -> Boxed { Rc::new(Value::Array(Vec::new())) }
    pub fn push_item(value: Boxed, item: Boxed) -> Boxed {
        let mut held = json_of(&value);
        if let Value::Array(items) = &mut held { items.push(json_of(&item)); }
        Rc::new(held)
    }
    pub fn from_text(value: String) -> Boxed { Rc::new(value) }
    pub fn from_number(value: f64) -> Boxed { Rc::new(value) }
    pub fn from_boolean(value: bool) -> Boxed { Rc::new(value) }
    pub fn make_null() -> Boxed { Rc::new(()) }
    // the shape questions: what a parsed value is, so a reader can walk it without guessing
    pub fn is_array(value: Boxed) -> bool { json_of(&value).is_array() }
    pub fn is_object(value: Boxed) -> bool { json_of(&value).is_object() }
    pub fn is_text(value: Boxed) -> bool { json_of(&value).is_string() }
    pub fn is_boolean(value: Boxed) -> bool { json_of(&value).is_boolean() }
    pub fn array_size(value: Boxed) -> i64 { json_of(&value).as_array().map(|items| items.len() as i64).unwrap_or(0) }
    pub fn array_item(value: Boxed, index: i64) -> Boxed { get_item(value, index) }
    pub fn object_keys(value: Boxed) -> Vec<String> {
        json_of(&value).as_object().map(|map| map.keys().cloned().collect()).unwrap_or_default()
    }
}
