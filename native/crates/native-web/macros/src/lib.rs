//! Opt-in native ABI adjustment. Canonical WASM declarations and source locations stay intact.
use proc_macro::{Literal, TokenStream, TokenTree};

/// `extern "C"` aborts on panic before catch_unwind can observe it. The native transport invokes
/// these exports from Rust, so permit unwinding there; WASM never enables this attribute.
#[proc_macro_attribute]
pub fn unwind(_attribute: TokenStream, item: TokenStream) -> TokenStream {
    let mut tokens = item.into_iter();
    let mut output = TokenStream::new();
    let mut adjusted = false;
    while let Some(token) = tokens.next() {
        let is_extern = matches!(&token, TokenTree::Ident(ident) if ident.to_string() == "extern");
        output.extend([token]);
        if is_extern {
            let Some(TokenTree::Literal(abi)) = tokens.next() else {
                return "compile_error!(\"native export must declare extern C\");"
                    .parse()
                    .unwrap();
            };
            if adjusted || abi.to_string() != "\"C\"" {
                return "compile_error!(\"native export must declare exactly one extern C ABI\");"
                    .parse()
                    .unwrap();
            }
            let mut replacement = Literal::string("C-unwind");
            replacement.set_span(abi.span());
            output.extend([TokenTree::Literal(replacement)]);
            adjusted = true;
        }
    }
    if !adjusted {
        return "compile_error!(\"native export must declare extern C\");"
            .parse()
            .unwrap();
    }
    output
}
