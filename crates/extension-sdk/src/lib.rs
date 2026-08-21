//! Public Rust guest bindings for Linked Info node extensions.
//!
//! The SDK deliberately exposes only the versioned WIT contract. It does not
//! depend on the desktop application, Tauri, React, or the host runtime.

/// Bindings generated from the versioned `node-extension` WIT world.
pub mod bindings {
    wit_bindgen::generate!({
        world: "node-extension",
        path: "wit",
        additional_derives: [PartialEq, Eq, Clone],
        export_macro_name: "export_extension_component",
        pub_export_macro: true,
        default_bindings_module: "linked_info_extension_sdk::bindings",
    });
}

/// Types and the guest trait implemented by a Rust extension.
pub use bindings::exports::linked_info::extension::guest;

/// Export an extension implementation as the `node-extension` component ABI.
///
/// The supplied type must implement [`guest::Guest`].
#[macro_export]
macro_rules! export_extension {
    ($extension:ident) => {
        $crate::bindings::export_extension_component!(
            $extension with_types_in $crate::bindings
        );
    };
}

/// Exact WIT source used to generate this SDK.
pub const EXTENSION_WIT: &str = include_str!("../wit/extension.wit");
