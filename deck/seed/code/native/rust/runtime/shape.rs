// Runtime shape checks. Rust erases types at compile time and has no value-level introspection, so each answer comes
// from the runtime's own tagged representation rather than from the language.
mod shape {
    use crate::seed::Value;

    pub fn is_list(value: &Value) -> bool {
        matches!(value, Value::List(_))
    }

    pub fn is_text(value: &Value) -> bool {
        matches!(value, Value::Text(_))
    }

    pub fn is_null(value: &Value) -> bool {
        matches!(value, Value::Null)
    }

    pub fn type_of(value: &Value) -> String {
        match value {
            Value::Null => "null",
            Value::List(_) => "list",
            Value::Text(_) => "text",
            Value::Boolean(_) => "boolean",
            Value::Number(_) => "number",
            _ => "object",
        }
        .to_string()
    }
    pub fn is_present(value: &Value) -> bool { !matches!(value, Value::Null) }
}
