// Runtime shape checks. Rust erases types at compile time and has no value-level introspection, so a list is
// recognised through the runtime's own tagged representation rather than by asking the language.
mod shape {
    use crate::seed::Value;

    pub fn is_list(value: &Value) -> bool {
        matches!(value, Value::List(_))
    }
}
