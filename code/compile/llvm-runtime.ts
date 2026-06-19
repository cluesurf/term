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
`
