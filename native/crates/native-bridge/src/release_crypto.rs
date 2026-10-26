//! Release verification is independent of game state and safe on download workers.
use std::{ffi::{c_char, c_int, CStr}, io::Read, panic::{catch_unwind, AssertUnwindSafe}, ptr};
use ed25519_dalek::{Signature, VerifyingKey};
use sha2::{Digest, Sha256};

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_verify_release_signature(key: *const u8, signature: *const u8, bytes: *const u8, byte_count: usize) -> c_int {
    catch_unwind(AssertUnwindSafe(|| {
        if key.is_null() || signature.is_null() || byte_count > 65536 || (bytes.is_null() && byte_count != 0) { return 0; }
        let key_bytes = unsafe { &*(key as *const [u8;32]) };
        let signature = Signature::from_bytes(unsafe { &*(signature as *const [u8;64]) });
        let Ok(key) = VerifyingKey::from_bytes(key_bytes) else { return 0; };
        let message = if byte_count == 0 { &[] } else { unsafe { std::slice::from_raw_parts(bytes, byte_count) } };
        i32::from(key.verify_strict(message, &signature).is_ok())
    })).unwrap_or(0)
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bh_sha256_file(path: *const c_char, max_bytes: u64, out_hex: *mut c_char) -> c_int {
    catch_unwind(AssertUnwindSafe(|| {
        if path.is_null() || out_hex.is_null() || max_bytes > 512*1024*1024 { return 0; }
        let Ok(path) = (unsafe { CStr::from_ptr(path) }).to_str() else { return 0; };
        let Ok(mut file) = std::fs::File::open(path) else { return 0; };
        let mut digest = Sha256::new(); let mut buffer = [0u8;65536]; let mut total = 0u64;
        loop { let Ok(n) = file.read(&mut buffer) else { return 0; }; if n == 0 { break; }
            total += n as u64; if total > max_bytes { return 0; } digest.update(&buffer[..n]); }
        let hex: String = digest.finalize().iter().map(|byte| format!("{byte:02x}")).collect();
        unsafe { ptr::copy_nonoverlapping(hex.as_ptr(), out_hex.cast::<u8>(), 64); out_hex.add(64).write(0); }
        1
    })).unwrap_or(0)
}

#[cfg(test)] mod tests {
    use super::*;
    use ed25519_dalek::{SigningKey, Signer};
    #[test] fn strict_signature_and_bounds() {
        // A deterministic test-only key, never included in release trust.
        let key = SigningKey::from_bytes(&[7;32]); let message = b"release fixture";
        let public = key.verifying_key().to_bytes(); let mut signature = key.sign(message).to_bytes();
        unsafe {
            assert_eq!(bh_verify_release_signature(public.as_ptr(),signature.as_ptr(),message.as_ptr(),message.len()),1);
            signature[8] ^= 1;
            assert_eq!(bh_verify_release_signature(public.as_ptr(),signature.as_ptr(),message.as_ptr(),message.len()),0);
            assert_eq!(bh_verify_release_signature(ptr::null(),signature.as_ptr(),message.as_ptr(),message.len()),0);
            assert_eq!(bh_verify_release_signature(public.as_ptr(),signature.as_ptr(),message.as_ptr(),65537),0);
        }
    }
    #[test] fn streaming_hash_checks_limits() {
        let path = std::env::temp_dir().join(format!("bunnyhop-hash-{}",std::process::id()));
        std::fs::write(&path,b"abc").unwrap();
        let cpath = std::ffi::CString::new(path.to_str().unwrap()).unwrap(); let mut out = [0i8;65];
        unsafe { assert_eq!(bh_sha256_file(cpath.as_ptr(),3,out.as_mut_ptr()),1);
            assert_eq!(CStr::from_ptr(out.as_ptr()).to_str().unwrap(),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
            assert_eq!(bh_sha256_file(cpath.as_ptr(),2,out.as_mut_ptr()),0); }
        std::fs::remove_file(path).unwrap();
    }
}
