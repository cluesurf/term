// The managed runtime the LLVM backend's emitted IR links against. It provides the few operations that need heap
// allocation or libc: string concatenation, length, equality, and printing. Written in Rust and exported with the C
// ABI (`extern "C"` + `#[no_mangle]`), so the symbol names match the `declare`s the backend emits (see compile/llvm.ts)
// and the emitted IR links against it. Compile to a staticlib and link into the emitted object:
//   rustc --edition 2021 --crate-type staticlib -O llvm-runtime.rs -o libseed_runtime.a
//   clang -x ir program.ll libseed_runtime.a -o program
// Returned strings are leaked C strings (never freed) — adequate for an ahead-of-time program; a real deployment
// would thread an allocator through.
export const LLVM_RUNTIME_RUST = `// Seed LLVM runtime (Rust, C ABI).
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::collections::HashMap;

unsafe fn read<'a>(p: *const c_char) -> &'a str {
    if p.is_null() { return ""; }
    CStr::from_ptr(p).to_str().unwrap_or("")
}

#[no_mangle]
pub extern "C" fn seed_str_concat(a: *const c_char, b: *const c_char) -> *mut c_char {
    let joined = unsafe { format!("{}{}", read(a), read(b)) };
    CString::new(joined).unwrap().into_raw()
}

#[no_mangle]
pub extern "C" fn seed_str_length(s: *const c_char) -> i64 {
    unsafe { read(s).len() as i64 }
}

#[no_mangle]
pub extern "C" fn seed_str_equal(a: *const c_char, b: *const c_char) -> i64 {
    unsafe { if read(a) == read(b) { 1 } else { 0 } }
}

#[no_mangle]
pub extern "C" fn seed_print_str(s: *const c_char) {
    unsafe { println!("{}", read(s)); }
}

#[no_mangle]
pub extern "C" fn seed_print_int(n: i64) {
    println!("{}", n);
}

// Lists: a growable buffer of 8-byte words behind an opaque handle. Every scalar element (integer, float, bool, or a
// string pointer) is stored as its i64 bit pattern, so one runtime serves every element type; the backend bitcasts a
// double or a pointer to / from the word at the boundary. Leaked like the strings above (adequate ahead-of-time).
#[no_mangle]
pub extern "C" fn seed_list_new() -> *mut Vec<i64> {
    Box::into_raw(Box::new(Vec::new()))
}

#[no_mangle]
pub extern "C" fn seed_list_push(p: *mut Vec<i64>, value: i64) -> i64 {
    let list = unsafe { &mut *p };
    list.push(value);
    list.len() as i64
}

#[no_mangle]
pub extern "C" fn seed_list_at(p: *mut Vec<i64>, index: i64) -> i64 {
    let list = unsafe { &*p };
    list[index as usize]
}

#[no_mangle]
pub extern "C" fn seed_list_length(p: *mut Vec<i64>) -> i64 {
    let list = unsafe { &*p };
    list.len() as i64
}

#[no_mangle]
pub extern "C" fn seed_list_pop(p: *mut Vec<i64>) -> i64 {
    let list = unsafe { &mut *p };
    list.pop().unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn seed_list_includes(p: *mut Vec<i64>, value: i64) -> i64 {
    let list = unsafe { &*p };
    if list.contains(&value) { 1 } else { 0 }
}

#[no_mangle]
pub extern "C" fn seed_list_index_of(p: *mut Vec<i64>, value: i64) -> i64 {
    let list = unsafe { &*p };
    list.iter().position(|e| *e == value).map(|i| i as i64).unwrap_or(-1)
}

// the closure-taking list ops. A Seed closure is its code pointer plus its environment handle; the runtime calls back
// through the C ABI, threading the env as the leading argument (exactly how the backend lowers an indirect call, and
// why a lifted closure always takes a leading env pointer). Element words are i64, serving integer lists.
type Unary = extern "C" fn(*mut Vec<i64>, i64) -> i64;
type Binary = extern "C" fn(*mut Vec<i64>, i64, i64) -> i64;

#[no_mangle]
pub extern "C" fn seed_list_map(p: *mut Vec<i64>, f: Unary, env: *mut Vec<i64>) -> *mut Vec<i64> {
    let list = unsafe { &*p };
    let out: Vec<i64> = list.iter().map(|&e| f(env, e)).collect();
    Box::into_raw(Box::new(out))
}

#[no_mangle]
pub extern "C" fn seed_list_filter(p: *mut Vec<i64>, f: Unary, env: *mut Vec<i64>) -> *mut Vec<i64> {
    let list = unsafe { &*p };
    let out: Vec<i64> = list.iter().copied().filter(|&e| f(env, e) != 0).collect();
    Box::into_raw(Box::new(out))
}

#[no_mangle]
pub extern "C" fn seed_list_reduce(p: *mut Vec<i64>, f: Binary, env: *mut Vec<i64>, init: i64) -> i64 {
    let list = unsafe { &*p };
    list.iter().fold(init, |acc, &e| f(env, acc, e))
}

#[no_mangle]
pub extern "C" fn seed_list_some(p: *mut Vec<i64>, f: Unary, env: *mut Vec<i64>) -> i64 {
    let list = unsafe { &*p };
    if list.iter().any(|&e| f(env, e) != 0) { 1 } else { 0 }
}

#[no_mangle]
pub extern "C" fn seed_list_every(p: *mut Vec<i64>, f: Unary, env: *mut Vec<i64>) -> i64 {
    let list = unsafe { &*p };
    if list.iter().all(|&e| f(env, e) != 0) { 1 } else { 0 }
}

// Maps: a hash from a canonical key (bytes) to (original key word, value word). The key word and value word are i64
// (the backend bitcasts a float / ptr at the boundary, like lists). A key is canonicalized by KIND so equality is by
// value: an integer key by its bytes, a string key by its content (kind 1, the word is a C-string pointer). Storing
// the original key word lets \`keys\` rebuild the list (a string key's pointer stays valid -- strings are leaked).
type Map = HashMap<Vec<u8>, (i64, i64)>;

fn map_key(kind: i64, key: i64) -> Vec<u8> {
    if kind == 1 {
        unsafe { read(key as *const c_char) }.as_bytes().to_vec()
    } else {
        key.to_le_bytes().to_vec()
    }
}

#[no_mangle]
pub extern "C" fn seed_map_new() -> *mut Map {
    Box::into_raw(Box::new(HashMap::new()))
}

#[no_mangle]
pub extern "C" fn seed_map_set(p: *mut Map, kind: i64, key: i64, value: i64) -> *mut Map {
    let map = unsafe { &mut *p };
    map.insert(map_key(kind, key), (key, value));
    p
}

#[no_mangle]
pub extern "C" fn seed_map_get(p: *mut Map, kind: i64, key: i64) -> i64 {
    let map = unsafe { &*p };
    map.get(&map_key(kind, key)).map(|pair| pair.1).unwrap_or(0)
}

#[no_mangle]
pub extern "C" fn seed_map_has(p: *mut Map, kind: i64, key: i64) -> i64 {
    let map = unsafe { &*p };
    if map.contains_key(&map_key(kind, key)) { 1 } else { 0 }
}

#[no_mangle]
pub extern "C" fn seed_map_delete(p: *mut Map, kind: i64, key: i64) -> i64 {
    let map = unsafe { &mut *p };
    if map.remove(&map_key(kind, key)).is_some() { 1 } else { 0 }
}

#[no_mangle]
pub extern "C" fn seed_map_size(p: *mut Map) -> i64 {
    let map = unsafe { &*p };
    map.len() as i64
}

#[no_mangle]
pub extern "C" fn seed_map_keys(p: *mut Map) -> *mut Vec<i64> {
    let map = unsafe { &*p };
    Box::into_raw(Box::new(map.values().map(|pair| pair.0).collect()))
}

#[no_mangle]
pub extern "C" fn seed_map_values(p: *mut Map) -> *mut Vec<i64> {
    let map = unsafe { &*p };
    Box::into_raw(Box::new(map.values().map(|pair| pair.1).collect()))
}

// ---- reference counting (Perceus) ----
// A side table mapping a pointer address to its reference count. Additive: the existing allocators do not yet route
// through it (that is the codegen step, which inserts seed_rc_init at each allocation). These primitives let the
// backend insert precise dup/drop. The AOT programs here are single-threaded, but the mutex keeps the table sound.
fn seed_refcounts() -> &'static std::sync::Mutex<HashMap<usize, i64>> {
    static T: std::sync::OnceLock<std::sync::Mutex<HashMap<usize, i64>>> =
        std::sync::OnceLock::new();
    T.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

// register a freshly-allocated pointer with refcount 1
#[no_mangle]
pub extern "C" fn seed_rc_init(ptr: *mut std::ffi::c_void) {
    seed_refcounts().lock().unwrap().insert(ptr as usize, 1);
}

// a dup: a second owner takes a reference, so increment the count
#[no_mangle]
pub extern "C" fn seed_dup(ptr: *mut std::ffi::c_void) {
    let mut m = seed_refcounts().lock().unwrap();
    *m.entry(ptr as usize).or_insert(1) += 1;
}

// a drop: decrement; at zero, remove from the table and free the object by its type tag (0 = string, 1 = list,
// 2 = map). A pointer not in the table (e.g. a static string literal) is left alone.
#[no_mangle]
pub extern "C" fn seed_drop(ptr: *mut std::ffi::c_void, tag: i64) {
    let reached_zero = {
        let mut m = seed_refcounts().lock().unwrap();
        match m.get_mut(&(ptr as usize)) {
            Some(c) => {
                *c -= 1;
                if *c <= 0 {
                    m.remove(&(ptr as usize));
                    true
                } else {
                    false
                }
            }
            None => false,
        }
    };

    if reached_zero {
        unsafe {
            match tag {
                0 => {
                    let _ = CString::from_raw(ptr as *mut c_char);
                }
                1 => {
                    let _ = Box::from_raw(ptr as *mut Vec<i64>);
                }
                2 => {
                    let _ = Box::from_raw(ptr as *mut Map);
                }
                _ => {}
            }
        }
    }
}

`
