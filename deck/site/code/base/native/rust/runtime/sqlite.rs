// SQLite runtime for the rust database native: one open connection, queries through rusqlite, rows as maps the
// `row` form carries as its opaque handle. Provided to Term via <global:sqlite>. Reached only through the public
// `base/db` API.
//
// Placeholders: SQLite wants `?`, the node impl was written against Postgres's `$1`, and one query text should
// serve both, so `$n` is rewritten to `?` in order. A parameter arrives as the boxed unknown a Term `like unknown`
// is on rust, holding a text, a number, a decimal, a boolean, or the json value the bridge carried; it binds by what
// it is, and anything else binds null. Every column reads back as text through `field`, the way the Postgres shim
// answers.
mod sqlite {
    use std::any::Any;
    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::rc::Rc;
    // the `row` form the Term program declares, emitted at the crate root
    use super::Row;

    thread_local! {
        static CONNECTION: RefCell<Option<rusqlite::Connection>> = RefCell::new(None);
    }

    // `url` is a file path, or empty for a database that lives only as long as the process
    pub fn connect(url: String) -> () {
        let opened = if url.is_empty() {
            rusqlite::Connection::open_in_memory()
        } else {
            rusqlite::Connection::open(&url)
        };
        match opened {
            Ok(connection) => CONNECTION.with(|slot| *slot.borrow_mut() = Some(connection)),
            Err(error) => println!("sqlite: {}", error),
        }
    }

    // `$1`, `$2` to `?`: SQLite binds positional `?` in order, which is the order the `$n` were numbered
    fn rewrite(sql: &str) -> String {
        let mut out = sql.to_string();
        let mut n = 1;
        while out.contains(&format!("${}", n)) {
            out = out.replace(&format!("${}", n), "?");
            n += 1;
        }
        out
    }

    // one bound parameter from a boxed unknown
    fn value_of(item: &Rc<dyn Any>) -> rusqlite::types::Value {
        use rusqlite::types::Value;
        if let Some(text) = item.downcast_ref::<String>() {
            return Value::Text(text.clone());
        }
        if let Some(number) = item.downcast_ref::<i64>() {
            return Value::Integer(*number);
        }
        if let Some(number) = item.downcast_ref::<f64>() {
            return Value::Real(*number);
        }
        if let Some(flag) = item.downcast_ref::<bool>() {
            return Value::Integer(if *flag { 1 } else { 0 });
        }
        if let Some(json) = item.downcast_ref::<serde_json::Value>() {
            return match json {
                serde_json::Value::String(text) => Value::Text(text.clone()),
                serde_json::Value::Bool(flag) => Value::Integer(if *flag { 1 } else { 0 }),
                serde_json::Value::Number(number) => match (number.as_i64(), number.as_f64()) {
                    (Some(whole), _) => Value::Integer(whole),
                    (None, Some(real)) => Value::Real(real),
                    _ => Value::Null,
                },
                _ => Value::Null,
            };
        }
        Value::Null
    }

    fn params_of(params: &Rc<RefCell<Vec<Rc<dyn Any>>>>) -> Vec<rusqlite::types::Value> {
        params.borrow().iter().map(value_of).collect()
    }

    // every row as a map of column name to text, wrapped in the `row` form. A plain Vec: the emitter wraps a list a
    // native answers into the shared handle a Term list is
    pub fn query(sql: String, params: Rc<RefCell<Vec<Rc<dyn Any>>>>) -> Vec<Row> {
        let rows: RefCell<Vec<Row>> = RefCell::new(Vec::new());
        CONNECTION.with(|slot| {
            let slot = slot.borrow();
            let Some(connection) = slot.as_ref() else {
                println!("sqlite: no connection. Call connect first");
                return;
            };
            let mut statement = match connection.prepare(&rewrite(&sql)) {
                Ok(statement) => statement,
                Err(error) => {
                    println!("sqlite: {} in {}", error, sql);
                    return;
                }
            };
            let names: Vec<String> = statement.column_names().iter().map(|name| name.to_string()).collect();
            let bound = params_of(&params);
            let mut answered = match statement.query(rusqlite::params_from_iter(bound.iter())) {
                Ok(answered) => answered,
                Err(error) => {
                    println!("sqlite: {} in {}", error, sql);
                    return;
                }
            };
            while let Ok(Some(row)) = answered.next() {
                let mut record: HashMap<String, String> = HashMap::new();
                for (index, name) in names.iter().enumerate() {
                    let text: String = match row.get_ref(index) {
                        Ok(rusqlite::types::ValueRef::Text(bytes)) => String::from_utf8_lossy(bytes).to_string(),
                        Ok(rusqlite::types::ValueRef::Integer(whole)) => whole.to_string(),
                        Ok(rusqlite::types::ValueRef::Real(real)) => real.to_string(),
                        _ => String::new(),
                    };
                    record.insert(name.clone(), text);
                }
                rows.borrow_mut().push(Row { handle: Rc::new(record) });
            }
        });
        rows.into_inner()
    }

    pub fn run(sql: String, params: Rc<RefCell<Vec<Rc<dyn Any>>>>) -> () {
        CONNECTION.with(|slot| {
            let slot = slot.borrow();
            let Some(connection) = slot.as_ref() else {
                println!("sqlite: no connection. Call connect first");
                return;
            };
            let bound = params_of(&params);
            if let Err(error) = connection.execute(&rewrite(&sql), rusqlite::params_from_iter(bound.iter())) {
                println!("sqlite: {} in {}", error, sql);
            }
        });
    }

    pub fn field(row: Row, name: String) -> String {
        row.handle
            .downcast_ref::<HashMap<String, String>>()
            .and_then(|record| record.get(&name).cloned())
            .unwrap_or_default()
    }

    pub fn close() -> () {
        CONNECTION.with(|slot| *slot.borrow_mut() = None);
    }
}
