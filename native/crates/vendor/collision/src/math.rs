//! The native client can opt into the same portable transcendental routines as Rust's WASM
//! compiler builtins. System libm implementations can differ by one ULP, which changes replays.
//! Defaults and WASM builds retain their existing floating-point methods.
//! Validation is toolchain-specific: Rust 1.99.1's wasm32 builtins matched libm 0.2.16
//! for 60,000 sampled rows of f32/f64 trig, inverse trig and f32 pow. Re-run native/WASM
//! replay parity when updating the Rust toolchain or this pinned dependency.

macro_rules! portable {
    ($name:ident, $ty:ty, $libm:ident, $method:ident) => {
        #[inline]
        pub fn $name(x: $ty) -> $ty {
            #[cfg(all(feature = "native-wasm-math", not(target_arch = "wasm32")))]
            {
                libm::$libm(x)
            }
            #[cfg(not(all(feature = "native-wasm-math", not(target_arch = "wasm32"))))]
            {
                x.$method()
            }
        }
    };
}
portable!(sin, f32, sinf, sin);
portable!(cos, f32, cosf, cos);
portable!(asin, f32, asinf, asin);
portable!(acos, f32, acosf, acos);
portable!(asin64, f64, asin, asin);

#[inline]
pub fn sin_cos(x: f32) -> (f32, f32) {
    #[cfg(all(feature = "native-wasm-math", not(target_arch = "wasm32")))]
    {
        (libm::sinf(x), libm::cosf(x))
    }
    #[cfg(not(all(feature = "native-wasm-math", not(target_arch = "wasm32"))))]
    {
        x.sin_cos()
    }
}

#[inline]
pub fn sin_cos64(x: f64) -> (f64, f64) {
    #[cfg(all(feature = "native-wasm-math", not(target_arch = "wasm32")))]
    {
        (libm::sin(x), libm::cos(x))
    }
    #[cfg(not(all(feature = "native-wasm-math", not(target_arch = "wasm32"))))]
    {
        x.sin_cos()
    }
}

#[inline]
pub fn atan2(y: f32, x: f32) -> f32 {
    #[cfg(all(feature = "native-wasm-math", not(target_arch = "wasm32")))]
    {
        libm::atan2f(y, x)
    }
    #[cfg(not(all(feature = "native-wasm-math", not(target_arch = "wasm32"))))]
    {
        y.atan2(x)
    }
}

#[inline]
pub fn atan264(y: f64, x: f64) -> f64 {
    #[cfg(all(feature = "native-wasm-math", not(target_arch = "wasm32")))]
    {
        libm::atan2(y, x)
    }
    #[cfg(not(all(feature = "native-wasm-math", not(target_arch = "wasm32"))))]
    {
        y.atan2(x)
    }
}

#[inline]
pub fn pow(x: f32, y: f32) -> f32 {
    #[cfg(all(feature = "native-wasm-math", not(target_arch = "wasm32")))]
    {
        libm::powf(x, y)
    }
    #[cfg(not(all(feature = "native-wasm-math", not(target_arch = "wasm32"))))]
    {
        x.powf(y)
    }
}

#[cfg(all(test, feature = "native-wasm-math", not(target_arch = "wasm32")))]
mod tests {
    #[test]
    fn sin_cos_matches_wasm_builtin_regression_values() {
        // Captured from a Rust 1.99.1 wasm32-unknown-unknown sin_cos probe. Darwin's
        // system sinf/cosf round one ULP differently for these inputs.
        for (x, sin, cos) in [
            (-6.2242751121521_f32, 1030826008, 1065324113),
            (-2.966160774230957_f32, 3190995171, 3212579355),
            (-1.6350349187850952_f32, 3212802260, 3179509853),
            (1.6350349187850952_f32, 1065318612, 3179509853),
            (2.966160774230957_f32, 1043511523, 3212579355),
        ] {
            let (s, c) = super::sin_cos(x);
            assert_eq!((s.to_bits(), c.to_bits()), (sin, cos));
        }
    }
}
