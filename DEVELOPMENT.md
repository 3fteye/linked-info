# 关联信息开发者说明

本文面向希望本地运行、修改、测试或扩展关联信息的开发者。产品使用方式见 [README.md](README.md)，已经确认的设计规则和阶段计划见 [DEVELOPMENT_PLAN.md](DEVELOPMENT_PLAN.md)，安全承诺和威胁模型见 [SECURITY.md](SECURITY.md)。

## 设计目标

- 数据模型保持通用：节点可以代表实体、标签或关系记录，不增加账号、服务等固定业务类型。
- 视图与数据解耦：无限画布只是第一种展示方式，领域数据不包含坐标、缩放和筛选状态。
- 本地保存始终可用：远端提供者失败不能阻断本地编辑。
- 后端提供者可替换：Cloudflare D1 是一个适配器，不进入领域层或桌面视图。
- 智能能力可替换：向量分析器依赖供应商无关接口，本地 ONNX 与远端嵌入 HTTP 只是适配器；派生向量和分数不进入领域模型。
- 加密由客户端掌握：密码保护模式中的本地文件、备份和未来远端同步都使用客户端密钥；存储提供者只接收密文。
- 内容使用方式可扩展：Markdown、TOTP 和脚本能力通过受控内容处理器加入，不把用途固化为节点类型，也不允许 WebView 任意执行节点文本。
- 边界严格校验：外部数据在导入、持久化和 API 边界完成验证，内部代码使用有效快照。

## 仓库结构

| 路径 | 作用 |
| --- | --- |
| `apps/desktop` | React、TypeScript、React Flow 和 Tauri 2 桌面应用 |
| `apps/desktop/src-tauri` | Rust 桌面壳、本地文件持久化和单实例生命周期 |
| `apps/cloudflare-worker` | 可选的 Cloudflare Worker HTTP 入口与 D1 绑定 |
| `apps/cloudflare-backup-worker` | 独立的密文备份 Worker 与 R2 绑定，不复用节点 API 权限 |
| `crates/domain` | 节点、引用和领域不变量 |
| `crates/application` | 与存储实现无关的应用用例 |
| `crates/contracts` | 供应商无关的 API DTO、错误码和 OpenAPI 契约 |
| `crates/storage-port` | 存储端口接口 |
| `crates/backup-port` | 供应商无关的密文快照与备份目标端口 |
| `crates/storage-memory` | 测试和本地用的内存适配器 |
| `crates/storage-d1` | Cloudflare D1 存储适配器 |

当前桌面应用不调用 Worker。两条路径分别演进：

```mermaid
flowchart LR
    UI["React 画布视图"] --> WP["WorkspacePersistence"]
    WP --> TF["Tauri Rust 本地文件"]
    WP --> ENC["Rust 可选加密封装"]
    ENC -.-> TF
    UI --> EA["EmbeddingAnalyzer"]
    EA --> LE["本地 FastEmbed / ONNX"]
    EA --> RE["远端嵌入接口"]
    UI -. "后续扩展" .-> CP["ContentProcessor 边界"]
    CP -.-> BUILTIN["内置 Markdown / TOTP / 受控脚本处理器"]
    ENC -. "未来异机密文备份" .-> BT["供应商无关 BackupTarget"]
    BT -.-> R2["Worker + R2 密文对象"]
    BT -.-> OTHER["S3 / WebDAV / 本地目录"]
    R2 -. "可选最少索引" .-> D1META["D1 账户 / 设备 / 版本元数据"]
    ENC -. "旧明文节点 API，桌面端未调用" .-> API["供应商无关节点 API 契约"]
    API --> APP["应用用例"]
    APP --> PORT["存储端口"]
    PORT --> MEM["内存适配器"]
    PORT --> D1["Cloudflare D1 适配器"]
```

## 工作区数据不变量

正式工作区、持久化快照和导出包共用同一组约束：

- 节点 ID 是规范化的小写 UUID，且全局唯一。
- 名称可以为空；非空名称规范化后唯一。
- 内容可以为空，当前为纯文本。
- 每个节点恰好有一个有效画布布局。
- 引用的源节点和目标节点必须存在，同一对引用不能重复。
- 画布视口属于工作区视图数据，不属于节点领域模型。

节点引用是有方向的。两个节点之间的专属信息应放入第三个普通关系节点，由关系节点同时引用所有参与方。多引用筛选使用 AND 语义。

## 本地持久化

桌面组件只依赖异步 `WorkspacePersistence`，不直接操作存储实现：

- 正式 Tauri 模式由 Rust 读写 `workspace.v1.json` 和 `workspace.recovery.v1.json`。
- 写入先落到同目录唯一临时文件，刷新内容后使用操作系统能力原子替换目标文件。
- 同一持久化实例中的写入按调用顺序串行执行，旧快照不能晚于新快照完成。
- 关闭窗口时先阻止默认关闭，等待完整工作区写入成功，再由 Rust `AppHandle::exit(0)` 退出应用。
- 写入失败时保持窗口打开并显示错误。
- 桌面端保持单实例；第二次启动只显示并聚焦已有主窗口。
- 浏览器开发模式使用 `localStorage`，并作为旧版桌面数据的一次性迁移来源。

桌面端现已在 `WorkspacePersistence` 与文件适配器之间实现 Rust 可选加密封装：随机数据密钥加密工作区，Argon2id 从用户密码派生密钥来保护数据密钥，XChaCha20-Poly1305 提供保密性和认证。未启用加密的工作区仍以明文保存；启用后，正式工作区、恢复副本、正常导出和不可读数据导出都写成版本化密文。React 会在解锁表单中短暂持有密码字符串，但不把密码或数据密钥持久化。桌面端仍未连接任何远端同步后端；现有 Worker/D1 节点 API 不能直接承载密码保护工作区的同步，后续需要独立的密文封装契约。

普通修改主密码只重新封装现有数据密钥；独立的数据密钥轮换会先推进 Rust 访问代次并卸载明文工作区，再生成新的随机数据密钥。Rust 在 `.workspace.data-key-rotation.v1.pending` 中准备新的正式文件、恢复副本、历史和 vault：`preparing` 阶段中断时删除待提交数据与新设备凭据，`ready` 阶段中断时由下次安全状态检查幂等完成提交。正式 vault 最后替换，是事务提交点；在此之前任何普通工作区命令看到待处理事务都会失败关闭，不能越过恢复流程。系统快速解锁启用时一并生成新设备密钥和凭据，只有新 vault 提交后才删除旧凭据。轮换命令成功或失败都不恢复已经撤销的明文会话。

设备本地自动备份历史由独立的 `WorkspaceBackupHistory` 前端端口和 Rust 文件适配器提供。Rust 只在主工作区原子写入成功后复制完整主文件，按一小时最小间隔、30 份、512 MiB 和 90 天上限轮换；应用每次解锁加载工作区时也会检查期限，避免长期不编辑时已删除秘密无限留在历史中。超过 90 天的历史全部回收；若当前内容没有变化，下一次快照检查会建立一份新的同内容快照。历史读取在 Rust 边界完成密文认证，再交给前端共用的工作区验证器。通过校验的目标工作区先进入独立的只读恢复画布，以当前与目标的同坐标叠加图展示节点、引用和布局差异；只有用户确认后才进入替换事务，取消则丢弃目标快照并返回原页面。启用加密时，既有历史先写入独立待提交目录并逐份验证，之后才与主文件和 vault 元数据一起提交，因此不会在已经宣称加密后留下旧的明文快照。自动历史、导入前恢复副本和可移植导出采用不同接口与生命周期，不能互相替代。

解锁方式限定为主密码与可选的“系统快速解锁”。主密码封装始终保留并随加密导出提供跨设备恢复；系统快速解锁只对当前设备有效，两者采用 OR 语义。Windows 适配器必须先通过 Windows Hello 的 PIN、指纹或人脸验证，随后才读取 Credential Manager 中的独立随机设备密钥。系统快速解锁不保存主密码、不进入导出或同步，也不被描述为第二因素；同一登录用户会话已经被恶意程序控制时，平台安全存储不能替代系统隔离。macOS 与 Linux 在实现可保证逐次用户验证的适配器前不开放该入口。

解锁后的授权仍属于 Rust 安全状态，不等于 React 界面可无限期读取明文。安全加固按三层边界实施：CSP 限制 WebView 可以加载和连接的来源，Tauri capability 限制窗口能调用的插件及 IPC，Rust 命令再校验工作区是否解锁、敏感操作是否刚完成重新认证以及异步任务代次是否仍有效。锁定必须先使 Rust 明文授权与旧任务代次失效，再停止模型、清理令牌和卸载界面；任一清理失败都不能恢复授权。

正式构建不加载远端脚本，远端备份和 AI 请求由 Rust 适配器执行。文件导入导出已经改为 Rust 命令逐次显示系统对话框并直接读写，主 WebView 不再拥有通用文件读写插件权限。开发服务器需要的热更新与调试来源使用独立 `devCsp`，不能放宽生产 CSP。完整规则见 [SECURITY.md](SECURITY.md)。

本机删除分成三个边界：节点删除走领域操作并清理引用与布局；历史清除只删除自动历史和恢复副本；工作区销毁则使用独立的限定用途授权，先使 Rust 明文访问代次失效并停止模型，再删除系统快速解锁凭据以及正式、待提交、恢复、历史和 vault 文件，成功后直接退出应用。销毁失败时仍保持锁定，不能让 React 因文件操作失败重新获得原有明文会话；外部手动导出不属于应用管理目录，不会被销毁命令扫描或删除。

秘密剪贴板通过独立 `SecretClipboard` 前端端口和 Rust 自定义命令接入，不给 WebView 通用剪贴板权限。首个 Windows 适配器使用 `CF_UNICODETEXT` 写入完整节点内容并记录系统剪贴板序列号；45 秒计时、锁定、数据密钥轮换或正常退出只在序列号仍相同时清空，因而不会删除用户随后复制的其他内容。并发写入在 Rust 中串行化，命令在写入前后检查工作区授权代次；若写入期间发生锁定，会立即转入清除重试。明文字符串和 UTF-16 临时缓冲使用 `Zeroizing` 清理。非 Windows 平台在有等价适配器前报告不可用。

`scripts/check-sensitive-logging.mjs` 对直接处理工作区明文、密码、令牌、模型输入与剪贴板内容的模块执行源码门禁，并在 CI 中禁止普通 Rust 输出/日志宏和浏览器 console 日志。新增受保护模块时必须加入清单；需要诊断时使用不包含用户数据的结构化错误码，并先扩展规则测试。

## 智能引用边界

- `embeddingService.ts` 负责文本组装、有界分段、内存派生缓存、余弦相似度和候选排序，只依赖 `EmbeddingGateway`。
- Tauri 本地适配器使用 `intfloat/multilingual-e5-small` 和 FastEmbed/ONNX。模型首次使用时下载到系统应用缓存目录，不进入仓库、工作区或导出包。
- 首个远端适配器使用可配置的兼容嵌入 HTTP 端点，Rust 负责网络请求以避免把供应商网络逻辑写进 React 视图。普通 HTTP 只允许本机回环地址，其他端点必须使用 HTTPS。
- 远端端点和模型名是设备设置；远端令牌只在 React 当前会话内存中存在，不得写入持久化存储或日志。
- 提供者配置指纹变化时同时清除会话令牌，避免旧端点凭据被误发到新端点。
- 名称和内容都为空的节点不参与向量分析。长文本最多抽取八个分段并覆盖文本不同位置，防止无限推理或远端费用失控。
- 自动引用默认关闭；开启后仍只在用户明确触发分析时添加达到阈值的普通 `Reference`。重新分析和切换模型不自动删除引用。
- 阈值与提供者、端点和模型配置绑定。配置指纹变化时必须清空派生缓存并关闭自动引用，等待用户重新校准。

### 本地 LLM 复核边界

- `llmReview.ts` 负责从第一层结果与正式引用中构建有界候选、分配临时编号并验证模型响应；React 不接触 llama.cpp 的端口或进程。
- `LlmGateway` 是视图依赖的供应商无关边界。本地 Tauri 适配器使用 `review_local_references` 命令；远端 LLM 仍是以后可选适配器，不进入本轮实现。
- Rust 只接受最多 24 个候选、每个候选最多两条示例和有限长度文本，并再次验证编号与分组互斥。模型只生成 `selectedAliases` 和 `uncertainAliases`；Rust 根据两个数组是否均为空唯一推导 `noMatch`，避免冗余字段自相矛盾。无效响应直接失败，不修改正式引用。
- 本地运行时固定为 llama.cpp `b10344` CPU 构建；GitHub Actions 下载对应平台产物并校验 SHA-256，再作为 Tauri resource 打包。Windows 便携产物把整个 `llama-runtime` 目录放在 EXE 旁边，不能只复制 `llama-server.exe` 而遗漏动态库。
- 本地模型固定为 `Qwen/Qwen3-1.7B-GGUF` revision `90862c4b9d2787eaed51d12237eafdfe7c5f6077` 的 `Qwen3-1.7B-Q8_0.gguf`。Rust 按固定大小和 SHA-256 校验下载，模型只进入系统应用缓存。
- llama.cpp 只监听 `127.0.0.1`，使用每次启动随机生成的 API key，关闭 Web UI、思考模式和上下文滚动；推理线程最多为 4，并至少给系统保留一个逻辑核心。
- 同一时间只允许一个本地 LLM 下载、加载或推理任务。禁用功能与正常退出都必须结束 sidecar，不能遗留后台进程。
- 智能引用写回时必须重新验证当前工作区中的源节点和目标节点；异步分析使用的旧快照不能直接越过当前数据边界。
- 本地 LLM 请求使用统一的保守 token 估算预算，并由 TypeScript 组装层和 Rust 命令边界双重约束。
- 已下载 GGUF 的就绪状态由绑定哈希、大小和修改时间的校验标记决定；Windows sidecar 还必须加入带 `KILL_ON_JOB_CLOSE` 的 Job Object，覆盖主进程异常退出。
- 远端向量提供者在缓存未命中时可能接收工作区全部非空节点的有界文本分段；任何 UI 和文档披露都必须按这个真实边界描述。
- 远端密文同步不等于远端 AI：存储适配器可以只保存密文，但嵌入或 LLM 服务必须看到明文才能分析。密码保护模式默认禁止远端 AI；在实现本地预筛选与明确秘密排除前，不得把当前全库远端向量流程用于已解锁工作区。

## 内容处理器边界

- `Node.content` 继续是可移植字符串。第一种富文本展示优先使用 Markdown 源文本和禁用危险 HTML 的安全预览，不采用编辑器私有 JSON 作为唯一存储。
- `ContentProcessor` 接收已解锁节点的只读快照，返回受约束的展示模型和显式动作；处理器偏好属于独立视图元数据，不进入领域层。
- TOTP 处理器只在本机内存计算当前验证码，当前值不得写入工作区、日志、缓存、同步或模型输入。
- 脚本默认只能预览。执行必须经 Rust 权限代理和独立进程，默认无文件、网络、环境变量或其他秘密访问权，并具有超时、取消、输出上限和退出回收。
- 首批只允许经过审查的内置处理器。第三方扩展必须使用隔离进程与能力声明，不能向 WebView 注入任意 JavaScript。

## 开发环境

CI 当前使用：

- Rust stable，工作区 edition 2024。
- Node.js 24。
- pnpm 11.16.0。
- Worker 检查需要 `wasm32-unknown-unknown` target。

开发阶段的自动检查和打包统一在 `windows-latest` 运行，与当前实际使用环境一致。源码继续保持供应商与视图边界解耦；macOS、Linux 构建在正式支持对应平台时恢复。

### 桌面前端

```powershell
cd apps/desktop
pnpm install --frozen-lockfile
pnpm dev
```

`pnpm dev` 只启动浏览器开发视图，使用 `localStorage`。运行完整桌面环境：

```powershell
cd apps/desktop
pnpm tauri dev
```

### 前端测试与构建

```powershell
cd apps/desktop
pnpm test
pnpm build
```

### Rust 检查

```powershell
cargo fmt --all -- --check
cargo test -p linked-info-contracts -p linked-info-domain -p linked-info-storage-port -p linked-info-storage-memory -p linked-info-application
cargo check -p linked-info-desktop
cargo test -p linked-info-desktop --lib
```

Worker 的 wasm 检查：

```powershell
rustup target add wasm32-unknown-unknown
cargo clippy -p cloudflare-worker --target wasm32-unknown-unknown -- -D warnings
cargo clippy -p cloudflare-backup-worker --target wasm32-unknown-unknown -- -D warnings
```

## 打包

本地执行完整 Tauri 打包：

```powershell
cd apps/desktop
pnpm tauri build
```

仓库的 `Desktop packages` GitHub Actions 工作流当前只生成 Windows 便携版 EXE，并打包本地 LLM 运行时；开发产物保留 3 天。使用时必须完整解压产物并保持 `linked-info-desktop.exe` 与 `llama-runtime` 的相对位置。构建目前没有商业代码签名。

## Cloudflare 适配器

Cloudflare 不是桌面端的固定依赖。`apps/cloudflare-worker` 通过供应商无关的应用层和存储端口接入 D1；Cloudflare 类型不得进入领域 crate 或桌面 React 组件。

当前 Worker/D1 实现是未被桌面端调用的明文节点 API，不能直接用作秘密工作区备份。首个异机备份适配器将使用 Worker 承担应用身份、授权和限流，R2 保存客户端已经加密的完整快照；D1 只在确有查询需求时保存账户、设备、版本和对象索引等最少元数据。备份通过独立 `BackupTarget` 端口接入，不能让 R2、D1 或 S3 类型进入桌面视图和加密核心。

备份 Worker 与节点 API Worker 是两个部署单元。前者只接受带应用级授权的不透明加密导出，使用独立 R2 binding，并通过流式请求体写入对象；后者继续只承担现有图节点 API。第一版备份对象直接依赖 R2 强一致列表和对象元数据，不创建没有实际查询用途的 D1 表。

仓库没有包含远程数据库 ID、API 令牌或已部署地址。`wrangler.jsonc` 中的 D1 `database_id` 保持为 `local`，只有实际创建远程资源时才由部署者在自己的环境中配置。不要提交 `.env`、Wrangler 登录状态、令牌或数据库导出。

## 修改约定

- 先搜索同类实现，保持现有模式一致。
- UI 文案必须同时进入 `apps/desktop/src/locales.ts` 的中文和英文资源，不能在组件中直接硬编码。
- 画布坐标、层级、缩放和筛选状态不能写入节点领域模型。
- 新存储实现通过 `storage-port` 或 `WorkspacePersistence` 接入，不让供应商 SDK 穿过边界。
- 修改数据模型或持久化前先补充不变量测试；修复交互问题时保留可复现的回归测试。
- 不要把本地工作区、导出备份、账号信息或任何凭据加入测试夹具和提交历史。

提交前至少运行受影响范围的测试，并确保 `cargo fmt --all -- --check`、`pnpm test` 和 `pnpm build` 通过。完整检查以 [.github/workflows/ci.yml](.github/workflows/ci.yml) 为准。

## 依赖许可证与 SBOM

CI 对当前 Windows 构建涉及的 Rust 依赖和前端全部依赖执行许可证门禁。门禁使用仓库内已审查的精确许可证表达式集合；出现新表达式、缺失许可证或工具输出结构变化时默认失败，必须人工确认后才能更新允许集合。它是工程审查门槛，不构成法律意见。

SBOM 使用 CycloneDX JSON，并按生态分别生成：Rust workspace 每个 crate 的依赖由固定版本且校验过下载哈希的 `cargo-cyclonedx` 生成，桌面前端生产依赖由锁定版本的 pnpm 原生命令生成。这些清单随 CI 和 Windows 便携构建作为构建产物保存，不提交到源码仓库；SBOM 记录“包含了什么”，RustSec 与 `pnpm audit` 负责检查“已知存在什么风险”，两者不能相互替代。

## 许可证与贡献

项目使用 [Apache License 2.0](LICENSE)。除非贡献者明确另行声明，提交给本项目并被接收的贡献按照同一许可证提供。
