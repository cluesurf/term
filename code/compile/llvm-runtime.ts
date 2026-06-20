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

// the closure-taking list ops. A Seed closure is passed as its raw code pointer plus its environment handle; the
// runtime calls back through the C ABI, threading the env as the leading argument (exactly how the backend lowers an
// indirect call). Element words are i64, so these serve integer lists; a typed-element variant would pass the element
// through the closure's own parameter type.
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
`
