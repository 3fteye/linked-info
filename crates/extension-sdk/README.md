# linked-info-extension-sdk

Rust Guest SDK for constrained Linked Info node extensions.

The crate contains only the versioned WIT bindings and the component export macro. It does not depend on the desktop application, Tauri, React, the workspace model, or the host runtime.

Build extensions for `wasm32-unknown-unknown`; the host intentionally rejects WASI and every other component import. The complete Chinese development guide and signed example are maintained in the [SDK guide](https://github.com/3fteye/linked-info/blob/main/docs/extension-sdk.md) and [example extension](https://github.com/3fteye/linked-info/tree/main/examples/rust-extension).
