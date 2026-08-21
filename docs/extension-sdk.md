# Rust 扩展 SDK 使用说明

## 1. 边界

`linked-info-extension-sdk` 是扩展作者唯一需要链接到 Guest Wasm 的 Rust crate。它只包含版本化 WIT 绑定和组件导出宏，不依赖桌面端、Tauri、React、工作区文件或宿主实现。

`linked-info-extension-tool` 是开发机工具，提供以下命令：

- `componentize`：把 `wasm32-unknown-unknown` 核心模块转换为 Component Model 组件。
- `keygen`：使用操作系统安全随机源生成 Ed25519 发布者私钥文件，只把公钥打印到标准输出。
- `pack`：规范化清单、计算逐文件 SHA-256、注入匹配的发布者公钥、签名并生成 `.liext`。
- `verify`：按与应用相同的包边界验证签名、哈希、WIT world、Schema、本地化资源和清单。
- `render` / `invoke`：用与应用相同的 Wasmtime 宿主限制在本地调用处理器或动作。

这些工具不会赋予扩展文件、网络、环境变量、子进程、稳定节点 ID 或原始秘密读取能力。动作只能返回声明式展示、自己的元数据和待宿主确认的修改提案。

## 2. 扩展工程

扩展使用 `cdylib`，目标是 `wasm32-unknown-unknown`。不要使用 `wasm32-wasip1` 或 `wasm32-wasip2`：当前宿主拒绝所有组件导入，包括 WASI。

```toml
[package]
name = "my-linked-info-extension"
version = "0.1.0"
edition = "2024"

[lib]
crate-type = ["cdylib"]

[dependencies]
linked-info-extension-sdk = "0.1.0"
```

实现 `linked_info_extension_sdk::guest::Guest` 的三个函数，然后导出组件 ABI：

```rust
struct MyExtension;

impl linked_info_extension_sdk::guest::Guest for MyExtension {
    // render、invoke、migrate_metadata
}

linked_info_extension_sdk::export_extension!(MyExtension);
```

完整、可构建的实现见 [`examples/rust-extension`](../examples/rust-extension)。扩展中的处理器 ID、动作 ID 和本地化 key 必须与 `manifest.json` 一致。

## 3. 构建与组件化

```powershell
rustup target add wasm32-unknown-unknown
cargo build --target wasm32-unknown-unknown --release
cargo run -p linked-info-extension-tool -- componentize `
  --module target\wasm32-unknown-unknown\release\my_linked_info_extension.wasm `
  --output build\extension.wasm
```

组件化步骤会验证核心模块中由 SDK 嵌入的 WIT 元数据。生成的组件仍会在打包、安装和每次宿主启动时重新验证。

## 4. 发布者密钥与签名包

```powershell
cargo run -p linked-info-extension-tool -- keygen `
  --output publisher.key

cargo run -p linked-info-extension-tool -- pack `
  --manifest manifest.json `
  --component build\extension.wasm `
  --metadata-schema metadata.schema.json `
  --locales-dir locales `
  --signing-key publisher.key `
  --output build\my-extension.liext
```

`publisher.key` 是 32 字节 Ed25519 私钥的 64 位小写十六进制形式。它不进入扩展包，不应提交到 Git、同步盘、日志或工作区；正式发布者应把它放在专用密钥管理或受保护的离线介质中。丢失私钥后无法以同一发布者身份更新已经安装的扩展。

当清单没有 `publisher.publicKey` 时，`pack` 会注入当前私钥对应的公钥；如果清单已经声明另一个公钥，打包会失败。省略 `--signing-key` 只会生成必须在应用开发者模式下安装的未签名测试包。

## 5. 验证与本地调用

```powershell
cargo run -p linked-info-extension-tool -- verify `
  --package build\my-extension.liext

cargo run -p linked-info-extension-tool -- render `
  --package build\my-extension.liext `
  --processor-id summary `
  --content "example content"

cargo run -p linked-info-extension-tool -- invoke `
  --package build\my-extension.liext `
  --action-id uppercase `
  --content "example content" `
  --base-revision 1
```

`render` 和 `invoke` 输出宿主已经重新验证的 JSON，不输出 Guest 返回的错误文字。它们适合开发测试，但不能代替应用内的安装授权、修改差异预览、用户确认、原子保存、撤销和卸载恢复测试。

## 6. CI 验收

仓库的 `test-rust-extension-sdk.ps1` 会把 SDK 和示例复制到检出目录之外，确保示例不能意外引用应用内部实现。随后依次验证：

1. 独立 Rust Guest 能构建为无 WASI 的核心 Wasm。
2. 核心 Wasm 能组件化为当前 `node-extension@1.0.0` world。
3. 临时 Ed25519 发布者密钥能生成签名 `.liext`。
4. 严格验证能复现同一包哈希和发布者身份。
5. 真实 Wasmtime 宿主能获得声明式展示。
6. 动作能返回节点元数据和绑定当前 revision 的修改提案。

应用内安装、启用、元数据持久化、修改确认和卸载保留继续由桌面生命周期测试覆盖；两组证据共同构成开放框架的完成门槛。
