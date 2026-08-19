# 全面架构审查（2026-08-19）

- 审查基线：`705eb5c182bbf13c23fe1cd9dd7b4c0550592ceb`
- 范围：Git 已提交的源码、配置、测试和文档
- 性质：只读架构审查；Finding 必须通过对应回归、故障注入或性能测试后再关闭
- 后续修复：每个独立修复批次通过功能分支、Pull Request、Code Review 和 CI 合并

## 结论

**当前不应进入下一阶段的主体功能扩展。**

没有发现 P0，但存在多项 P1：恢复事务可能丢失唯一副本、已提交恢复可能被旧 React 状态回写、加密导出边界可被 WebView 绕过、大工作区交互与智能分析不可持续，以及异步旧结果可能写入正式数据。

好消息是：**不需要推翻现有方向**。`Node + Reference`、视图元数据分离、Rust 加密边界、`BackupTarget`、内容标记注册表和本地 LLM sidecar 都是可继续演进的基础。应先完成一次“事务、代次、容量和增量状态”收口，再继续扩展。

审查基线为 `HEAD 705eb5c182bbf13c23fe1cd9dd7b4c0550592ceb`。全程只读 Git 已提交对象；未修改代码、未运行会写入构建产物的测试、未访问任何真实工作区、导出、附件、草稿、凭据或模型缓存。

### 覆盖判断

| 范围 | 判断 |
| --- | --- |
| Node / Reference / view / v1→v2 | 基本正确；内容与视图分离、双端验证和迁移链可保留 |
| React / Tauri / Rust 分层 | Cargo 分层好；桌面 IPC 的安全与错误契约仍有跨层泄漏 |
| 保存、加密、历史、恢复、备份 | 单文件原子性好；跨文件事务和提交结果语义不合格 |
| 大画布性能 | 视图裁剪和批量 SVG 有价值，但高频路径仍多次全图扫描 |
| 内容处理器、秘密、脚本边界 | 当前 Markdown/TOTP/secret 安全方向好；注册表不足以直接承载脚本 |
| 智能引用 | 模型和结果边界较严，但后台计算、取消、缓存契约和原子写回有缺陷 |
| Cloudflare Worker/D1 | 与桌面正确隔离，但目前只是未使用的参考适配器，不适合作同步骨架 |
| TS/Rust 契约 | 工作区夹具是优点；其他手写 IPC DTO 已发生实际漂移 |
| 测试、CI、供应链 | 基础 CI 很强；缺故障注入、跨语言回环、性能预算和可靠发布来源约束 |
| 文档漂移 | 恢复事务、结果缓存、R2 验收等多处“已完成”声明不成立或互相矛盾 |

## Findings

### P0

未发现。

### P1｜扩展前阻断项

#### 1. primary/recovery 替换不是一个崩溃原子事务

证据：持久化端口将操作拆成 `preserveForRecovery`、`save` 和 `swapWithRecovery`（[workspaceStore.ts:35–40](../apps/desktop/src/workspaceStore.ts#L35)）；实际 swap 先覆盖 recovery，再覆盖 primary（[workspaceTauriPersistence.ts:75–97](../apps/desktop/src/workspaceTauriPersistence.ts#L75)）；Rust 只保证单个文件替换原子（[workspace_file.rs:3307–3342](../apps/desktop/src-tauri/src/workspace_file.rs#L3307)）。

- 触发：第一次 recovery 写完成后，在 primary 写入前进程终止、掉电或磁盘挂起。
- 影响：primary 和 recovery 可能同时变成同一份新工作区，唯一旧副本丢失。swap 等待期间界面也未冻结普通 mutation，完成时可能覆盖刚产生的编辑。
- 架构原因：必须具有单一提交点的整工作区操作，被建模为多个独立槽写；Promise 队列不是跨资源事务。
- 修复方向：由 Rust 提供单一 `replace/swap workspace transaction`，使用两个 staged 文件、事务清单、明确 commit point 和启动恢复；事务期间拒绝工作区 mutation，并增加逐提交点强杀恢复测试。

#### 2. Rust 已持久提交后仍可能返回普通失败，旧 React 快照随后可覆盖新数据

bootstrap restore 在 vault 提交后仍执行可失败步骤（[workspace_file.rs:2505–2508](../apps/desktop/src-tauri/src/workspace_file.rs#L2505)、[workspace_file.rs:1779–1783](../apps/desktop/src-tauri/src/workspace_file.rs#L1779)）；前端把所有异常都当成“导入失败”，保留旧内存工作区（[App.tsx:3634–3689](../apps/desktop/src/App.tsx#L3634)）。

- 触发：新 vault/primary 已提交后，第二次缓存清理、状态 mutex 或末尾访问代次检查失败。
- 影响：磁盘已经恢复成功，UI 却认为失败；后续编辑或关闭保存旧 `workspaceRef`，可把刚恢复的数据重新覆盖。改密码也可能出现“磁盘已接受新密码，界面却报告失败”。
- 架构原因：跨 Rust/React 的结果类型无法区分 `NotCommitted`、`Committed` 与 `CommittedButLocked/FollowupFailed`。
- 修复方向：统一所有安全持久事务的线性化点和结果枚举；commit 后不得再用普通 `Err` 表示整体未完成，前端收到任何 committed 结果都必须卸载旧状态并从 Rust 重载。

#### 3. 合法工作区可以增长到无法导出、导入或异机备份

工作区验证不限制节点数、引用数和正文长度（[workspaceData.ts:235–294](../apps/desktop/src/workspaceData.ts#L235)）；手动传输硬限制 256 MiB（[file_transfer.rs:5–7](../apps/desktop/src-tauri/src/file_transfer.rs#L5)），S3 密文快照硬限制 100 MiB（[s3_backup_target.rs:27–28](../apps/desktop/src-tauri/src/s3_backup_target.rs#L27)）。

- 触发：版本化密文导出超过 100 MiB；更大后超过 256 MiB。Base64 密文还会放大原始 JSON。
- 影响：本地保存继续成功，但全部 S3 备份稳定失败；再增长后连手动迁移也不可用，形成“合法、可编辑、不可灾备”的状态。
- 架构原因：数据模型允许的状态空间大于备份协议可表示空间；全量字符串→密文字符串→字节数组还产生数倍峰值内存。
- 修复方向：在继续富内容/大库扩展前，选择统一的全局可移植预算，或设计版本化、分块认证、可流式恢复的格式；保存、导出、备份和恢复演练必须共享同一容量契约。

#### 4. 文件导出策略位于 React，而真正的 Rust 文件 sink 不受保护

`export_workspace_transfer` 接受 WebView 任意文本并直接写盘，没有 vault、访问代次或敏感授权检查（[file_transfer.rs:35–64](../apps/desktop/src-tauri/src/file_transfer.rs#L35)）。正常 UI 只是自觉先加密（[App.tsx:2869–2888](../apps/desktop/src/App.tsx#L2869)）。

同一拆分还导致“导出不可读原始数据”实际失效：UI 把损坏原文交给 `encryptExport`（[App.tsx:3764–3787](../apps/desktop/src/App.tsx#L3764)），但 Rust 命令先要求它是合法可移植 export（[workspace_file.rs:1423–1445](../apps/desktop/src-tauri/src/workspace_file.rs#L1423)）。

- 触发：受攻击或出错的 WebView 跳过加密直接调用文件命令；或用户尝试导出真正损坏/不支持版本的加密工作区原文。
- 影响：前者可绕过重新认证和强制加密；后者恰在数据恢复时必然失败。
- 架构原因：安全策略、格式验证、加密和文件写入被拆在不同信任等级的两层。
- 修复方向：合并为单一 Rust `export-to-dialog` 用例，在同一访问代次中消费用途授权、根据 vault 状态强制选择加密模式并写盘；为不可读原始数据定义独立、受授权的 opaque payload 模式。

#### 5. Rust 权威闲置计时可被 WebView 任意续期

前端 DOM 事件调用 `recordActivity`（[WorkspaceSecurityGate.tsx:100–123](../apps/desktop/src/WorkspaceSecurityGate.tsx#L100)）；Rust 命令无来源证明地更新时间戳（[workspace_file.rs:461–476](../apps/desktop/src-tauri/src/workspace_file.rs#L461)、[workspace_file.rs:1407–1410](../apps/desktop/src-tauri/src/workspace_file.rs#L1407)）。

- 触发：后台脚本、计时器或受攻击的前端直接 `invoke`，甚至合成 DOM 事件。
- 影响：可无限阻止闲置锁定，使 Rust 长期保留解锁密钥，违反“后台定时器/动画/网络不能刷新活动”的安全边界。
- 架构原因：把安全权威委托给威胁模型中不可信的 WebView。
- 修复方向：由 Rust/平台读取原生输入或 OS last-input；会话时限使用单调时钟。`event.isTrusted` 只能防普通误用，不能作为安全边界。

#### 6. 自动引用的结果失效校验和正式写回之间存在竞态

代码先检查任务/替换代次（[App.tsx:2099–2104](../apps/desktop/src/App.tsx#L2099)），之后异步计算全工作区 key（[App.tsx:2126–2133](../apps/desktop/src/App.tsx#L2126)），返回后不再校验代次便写入正式引用（[App.tsx:2135–2155](../apps/desktop/src/App.tsx#L2135)）。

- 触发：Web Crypto digest 等待期间切换模型设置、编辑语义数据或确认工作区替换；恢复版本复用相同 UUID 时端点检查仍会通过。
- 影响：旧分析可在队列已取消或工作区已替换后新增正式引用，并进入历史和持久化。
- 架构原因：异步验证与领域写入之间没有 revision compare-and-swap；“端点仍存在”不能证明结果仍属于当前语义版本。
- 修复方向：维护单调的工作区语义修订号；在 `updateWorkspace` 同一同步提交闭包内重新比较任务代次、替换代次、设置指纹和修订号。

#### 7. 备份验证/恢复演练结果可能写到已经切换位置的新目标

修改 S3 目标时会获取 claim 并在位置变化时清空状态（[offsite_backup.rs:652–654](../apps/desktop/src-tauri/src/offsite_backup.rs#L652)、[offsite_backup.rs:739–755](../apps/desktop/src-tauri/src/offsite_backup.rs#L739)）；完整校验和恢复演练却不获取 claim，也不比较配置 revision（[offsite_backup.rs:978–1036](../apps/desktop/src-tauri/src/offsite_backup.rs#L978)）。

- 触发：旧 endpoint/bucket 上的长校验运行期间，同一目标 ID 被切换到新位置。
- 影响：旧快照的 `lastVerifiedAtMs` / `lastRestoreTestAtMs` 可在 reset 后写入新目标，虚假证明新位置已可恢复。
- 架构原因：派生状态只绑定目标 ID，没有绑定产生它的配置世代。
- 修复方向：所有有副作用的目标操作共享目标锁；配置加入单调 revision/位置指纹，状态写回使用 compare-and-set。

#### 8. 单节点编辑仍把每次按键重新注入顶层 App 和整张 React Flow

名称、正文每次输入都调用全局回调（[GraphCanvas.tsx:720–725](../apps/desktop/src/GraphCanvas.tsx#L720)、[GraphCanvas.tsx:797–810](../apps/desktop/src/GraphCanvas.tsx#L797)）；App 每次映射整个节点数组（[App.tsx:2735–2757](../apps/desktop/src/App.tsx#L2735)），随后 GraphCanvas 再重建所有 React Flow node data（[GraphCanvas.tsx:2111–2238](../apps/desktop/src/GraphCanvas.tsx#L2111)）。停止输入 300 ms 后又序列化、校验、IPC 和加密整份工作区（[App.tsx:1361–1392](../apps/desktop/src/App.tsx#L1361)）。

- 触发：大型工作区编辑任意字符，或顶层 AI/备份状态变化。
- 影响：单按键多次 O(N)，暂停后 O(N+E) 全量持久化；十万节点路径不可持续。
- 架构原因：内容、几何、选择、标签和动作共享单一顶层快照与 React Flow data 对象。
- 修复方向：按节点 ID 规范化状态和 selector 订阅；编辑草稿局部持有，仅在定向防抖/提交时更新目标节点；Rust 持久化支持 delta/journal 与周期 checkpoint，完整快照只留给导出和关闭边界。

#### 9. 框选、拖动和拖线搜索仍存在高频全图扫描或无界 DOM

Shift 框选每个 pointer move 都构造全部节点矩形、线性求交并再次映射全部选择状态（[GraphCanvas.tsx:2837–2875](../apps/desktop/src/GraphCanvas.tsx#L2837)、[GraphCanvas.tsx:3026–3046](../apps/desktop/src/GraphCanvas.tsx#L3026)）。拖动期间静态引用仍受整个 `flowNodes` 数组失效影响（[GraphCanvas.tsx:1932–2055](../apps/desktop/src/GraphCanvas.tsx#L1932)）。

拖线落到空白处时，空查询会过滤、排序全库（[referenceSearch.ts:14–34](../apps/desktop/src/referenceSearch.ts#L14)、[GraphCanvas.tsx:2072–2093](../apps/desktop/src/GraphCanvas.tsx#L2072)），然后把所有候选挂成按钮（[GraphCanvas.tsx:3501–3630](../apps/desktop/src/GraphCanvas.tsx#L3501)）。

- 触发：大工作区框选/自动平移、引用密集时拖动、或从输出端拖到空白。
- 影响：每帧 O(N+E)；一次空查询即可创建数万 DOM 行并冻结 WebView。
- 架构原因：没有空间索引、引用邻接索引和“搜索全集/排名结果/渲染窗口”三层边界。
- 修复方向：空间索引查询框选；静态路径按已提交布局修订缓存，拖动只更新 incident edges；引用搜索使用索引、top-K、空查询硬上限和虚拟化 listbox。

#### 10. “后台”智能分析仍在 WebView 主线程全量驻留，本地 embedding 也无法硬取消

智能分析为所有节点建立全部分段并取得全部向量（[embeddingService.ts:328–365](../apps/desktop/src/embeddingService.ts#L328)），同时保留 inputs、hashes、keys、missing 和 resolved vectors（[embeddingService.ts:390–516](../apps/desktop/src/embeddingService.ts#L390)）；结果 key 又全量排序并序列化工作区（[smartReferenceCache.ts:202–226](../apps/desktop/src/smartReferenceCache.ts#L202)）。

锁定时 embedding `shutdown` 遇到正在占用的模型锁只返回成功（[embedding.rs:187–204](../apps/desktop/src-tauri/src/embedding.rs#L187)），实际 `model.embed` 不读取取消标志（[embedding.rs:1002–1016](../apps/desktop/src-tauri/src/embedding.rs#L1002)）。

- 触发：大量非空节点或每节点多分段；推理期间锁定。
- 影响：JS 主线程可能冻结，向量内存达到 O(N×段数×维度) 并 OOM；锁定能丢弃结果，但 CPU 任务和明文输入继续存在到推理自然结束。
- 架构原因：Promise 顺序队列不等于后台任务；进程内阻塞推理无法满足硬取消边界。
- 修复方向：将分段、哈希、余弦、图传播和 key 计算移入可取消 Worker/Rust 任务，按批次流式聚合 top-K；本地 embedding 迁入可终止 sidecar/worker process，代次校验继续作为第二道防线。

### P2｜应尽快偿还

#### 11. 加密智能引用结果缓存的 TS/Rust DTO 已实际漂移

TS 强制要求 `sourceFingerprint`（[smartReferenceCache.ts:13–23](../apps/desktop/src/smartReferenceCache.ts#L13)、[smartReferenceCache.ts:89–119](../apps/desktop/src/smartReferenceCache.ts#L89)），Rust DTO 完全没有该字段（[smart_reference_cache.rs:47–57](../apps/desktop/src-tauri/src/smart_reference_cache.rs#L47)）。

- 触发：写入加密缓存后锁定或重启，再读取相同分析。
- 影响：Serde 丢掉额外字段，TS 读回后必定判无效，缓存永远无法跨会话命中并重复 LLM 推理。
- 架构原因：IPC DTO 没有单一契约和真实 TS→Rust→TS 回环测试。
- 修复方向：补齐字段；对全部桌面 IPC DTO 建版本化 JSON Schema/夹具和双向 round-trip 测试。

#### 12. 远端 embedding 适配器丢失 query/document 角色

TS 端口有 `role`，但远端桥只传文本（[embeddingBridge.ts:21–33](../apps/desktop/src/embeddingBridge.ts#L21)）；Rust 远端请求也是 `Vec<String>`（[embedding.rs:243–256](../apps/desktop/src-tauri/src/embedding.rs#L243)），本地适配器则正确按角色加前缀（[embedding.rs:927–945](../apps/desktop/src-tauri/src/embedding.rs#L927)）。

- 触发：远端使用 E5 等非对称检索模型。
- 影响：远端结果语义与本地同模型不一致，错误向量仍会进入按角色分开的缓存。
- 架构原因：适配器缩窄了供应商无关端口语义。
- 修复方向：角色穿过 IPC；预处理 profile 显式版本化并加入配置指纹。

#### 13. 删除备份目标的 keyring 与配置没有崩溃事务

实现先删除凭据，再提交配置（[offsite_backup.rs:1120–1149](../apps/desktop/src-tauri/src/offsite_backup.rs#L1120)）。

- 触发：两步之间进程或系统中断。
- 影响：目标配置仍存在，但凭据永久缺失，灾备路径失联。
- 架构原因：跨 keyring/文件的删除只对普通返回错误回滚，没有 crash recovery。
- 修复方向：增加两阶段 intent/journal，以配置切换为提交点，启动时幂等完成或恢复。

#### 14. Worker 的 PUT/DELETE 并发可复活已删除节点

Worker PUT 先读节点，再独立保存（[cloudflare-worker/src/lib.rs:114–130](../apps/cloudflare-worker/src/lib.rs#L114)）；D1 保存使用 upsert（[storage-d1/src/lib.rs:16–21](../crates/storage-d1/src/lib.rs#L16)），DELETE 在另一个事务中先清边再删节点（[storage-d1/src/lib.rs:149–186](../crates/storage-d1/src/lib.rs#L149)）。

- 触发：PUT 读取后，DELETE 先提交，随后 PUT 执行 upsert。
- 影响：DELETE 和 PUT 都可报告成功，最终节点复活但全部引用永久丢失。
- 架构原因：`GraphStore` 只有混合 create/update 的 `save_node`，用例只能 check-then-act。
- 修复方向：若保留 Worker，拆分 `create` 与条件 `update-existing`，检查 affected rows/revision，并补并发事务测试。若不保留，则明确归档或删除，避免将其误作未来同步基础。

#### 15. 供应商无关错误和 OpenAPI 没有形成稳定应用契约

存储端口允许任意 `S::Error`，应用层原样透传（[storage-port/src/lib.rs:5–28](../crates/storage-port/src/lib.rs#L5)、[application/src/lib.rs:16–70](../crates/application/src/lib.rs#L16)）；Worker 直接匹配 `D1StoreError`（[cloudflare-worker/src/lib.rs:281–297](../apps/cloudflare-worker/src/lib.rs#L281)）。OpenAPI 的 list/get 也漏掉运行时真实存在的 400 响应（[contracts/src/lib.rs:146–182](../crates/contracts/src/lib.rs#L146)）。

- 触发：增加第二数据库、生成客户端或处理非法分页/UUID。
- 影响：更换存储仍要重写 HTTP 错误映射，客户端无法依赖声明的错误面。
- 架构原因：适配器错误越过应用层，文档契约与 handler 各自维护。
- 修复方向：定义稳定的应用错误类别，适配器先映射；OpenAPI 由真实 handler/共享响应类型生成，并在 CI diff 客户端契约。

#### 16. 敏感日志门禁依赖手工路径清单，已经漏掉核心明文模块

门禁只扫描固定 allowlist（[check-sensitive-logging.mjs:7–34](../scripts/check-sensitive-logging.mjs#L7)）；完整遍历名称/正文和导入导出的 [workspaceData.ts:266](../apps/desktop/src/workspaceData.ts#L266)、[workspaceStore.ts:53](../apps/desktop/src/workspaceStore.ts#L53)、[workspaceBackup.ts:31](../apps/desktop/src/workspaceBackup.ts#L31) 都不在清单中。

- 触发：这些模块以后加入 `console.*` 或普通 Rust 日志。
- 影响：CI 仍可通过，无法兑现秘密/正文不进入普通日志的边界。
- 架构原因：安全门禁默认放行，仅对已知文件禁用。
- 修复方向：扫描全部 Git 跟踪的桌面 TS/Rust 文件，默认禁止普通日志；只通过受约束的结构化诊断 API 显式放行。

#### 17. Merge 与桌面包来源约束弱于文档承诺

ruleset 的批准数为 0（[main.json:22–30](../.github/rulesets/main.json#L22)）；桌面包工作流可从手动选择的任意 ref 构建同名产物（[desktop-packages.yml:3–5](../.github/workflows/desktop-packages.yml#L3)），显式 RunId 同步路径只检查运行完成/成功，不核对 workflow、事件、分支和 SHA（[sync-latest-windows-package.ps1:90–103](../scripts/sync-latest-windows-package.ps1#L90)）。

- 触发：从未合并分支手工打包，或在无实际审查的情况下合并。
- 影响：一个“成功”包不证明来自已合并、已通过 main CI 的提交；审查流程只是文档约定。
- 架构原因：发布来源、代码审查和状态检查没有成为同一机器可验证链。
- 修复方向：包任务只接受成功 main CI 的 SHA，artifact/manifest 带 SHA；同步工具校验仓库、workflow、event、branch 和 commit；需要的自动普通/安全审查应成为条件 required check。

#### 18. 灾备验收没有单一事实来源

[SECURITY.md:108](../SECURITY.md#L108) 声称 R2 已完成真实恢复演练，[DEVELOPMENT_PLAN.md:570](../DEVELOPMENT_PLAN.md#L570) 却明确称尚未完成完整下载校验或独立演练。

- 触发：用户或发布审查依赖 HEAD 判断灾备闭环。
- 影响：至少一份文档错误，无法判断恢复承诺是否真实完成。
- 架构原因：实机验收结果散落在叙述文档，没有带提交和构建身份的验证记录。
- 修复方向：建立不含敏感数据的单一验收记录，包含 commit、构建 SHA、目标类型、下载哈希、全新配置解锁、清理结果和日期；其他文档只引用。

### P3｜可按需求后置

#### 19. 内容解析注册表已开放，但展示/动作接口仍对 TOTP 和 secret 闭合

展示 labels 固定为 `secret/totp`（[contentMarkerPresentation.tsx:11–19](../apps/desktop/src/contentMarkerPresentation.tsx#L11)、[contentProcessor.tsx:94–97](../apps/desktop/src/contentProcessor.tsx#L94)）；`ContentProcessor.present` 只能返回 text/markdown，不能表达能力声明或受控动作（[contentProcessor.tsx:19–27](../apps/desktop/src/contentProcessor.tsx#L19)）。

- 触发：加入第三种标记、代码预览动作或脚本处理器。
- 影响：必须修改 App、GraphCanvas、宿主和固定 label 类型，不能真正“只登记适配器”。
- 架构原因：解析注册表开放，展示资源和动作上下文仍是内置联合。
- 修复方向：按 ID 注册展示定义、资源键和 opaque action；宿主只分派动作 ID。当前没有脚本执行漏洞，但脚本执行必须另建 Rust 权限代理、能力声明和可终止隔离进程，不能复用普通 React 回调。

## Cloudflare Worker / D1 判断

边界隔离是成功的：Cloudflare 类型没有进入 domain/application，桌面也没有调用 Worker。但其实际产品价值目前很低：

- 只覆盖 Node/Reference，不覆盖 layout、viewport、view metadata、加密工作区和备份生命周期。
- 未鉴权，不能部署为公开服务。
- 不是客户端密文同步协议。
- D1 在 CI 中没有真实迁移/API 行为测试，Worker 构建路径也仍使用未精确固定的 `worker-build@^0.8`（[wrangler.jsonc:19–21](../apps/cloudflare-worker/wrangler.jsonc#L19)）。

建议二选一：

1. 标为 archived reference adapter，停止把它列作“完成的第二后端”；或
2. 删除以减少依赖和维护面。

未来同步应从版本化密文快照/同步单元契约重新开始，不应继续补丁式扩展当前明文节点 API。

## 已做得好的架构决策

- `NodeId` 稳定、`Node + Reference` 保持通用，没有账号、服务或供应商类型污染领域层。
- view metadata 独立于 Node/Reference；v1→v2 确定性补入空 view，未知版本拒绝。
- TS/Rust 对工作区 ID、名称唯一、布局一一对应、引用端点、重复边、视口和处理器元数据都有严格验证，并共享工作区夹具。
- 单文件写入使用唯一临时文件、`sync_all`、原子替换和目录同步；加密迁移与数据密钥轮换采用 vault-last 提交点。
- Rust 授权代次普遍用于丢弃锁定后的迟到结果；本地 LLM 使用可终止 sidecar、随机 API key 和 Windows Job Object。
- `BackupTarget` 只处理不透明密文字节；统一 S3 适配器强制 HTTPS、禁止重定向并本机复算完整哈希。
- React Flow 不再为每条正式引用创建 Edge，单目标入站线有 40 条展示上限；自动布局使用独立 Worker 且不传正文。
- Markdown 禁用原始 HTML，链接不可导航、图片不加载；标记解析、语义剥离和展示注册表分离，并校验定义/展示一一对应。
- TOTP 和秘密 payload 会从搜索、embedding 和 LLM 语义输入剥离；TOTP 使用共享时钟而不是每节点定时器。
- CI 已有 frozen lockfile、依赖审计、许可证、SBOM、固定 Action SHA 和真实 Edge 合成工作区测试；Playwright 明确关闭截图、录像和 trace。

## 测试与文档缺口

当前自动化更擅长验证正确性，尚不能证明架构承诺：

- Edge 最大合成工作区为 500 节点，验证框选正确性而非性能预算（[canvas-selection.pw.ts:1447–1485](../apps/desktop/e2e/canvas-selection.pw.ts#L1447)）。
- 没有 primary/recovery 各提交点强杀、缓存清理失败、提交后锁定等故障注入测试。
- 没有 TS→Rust→TS IPC DTO 回环，因此漏掉 `sourceFingerprint`。
- 没有引用密集拖动、空查询十万候选、逐键 render count、AI 峰值内存或硬取消测试。
- D1 没有 migration/FK/唯一性/并发/API 集成测试。
- 文档把 recovery swap 和加密结果缓存描述为已完成（[DEVELOPMENT_PLAN.md:632–638](../DEVELOPMENT_PLAN.md#L632)），但实现分别存在 P1/P2 缺陷。
- README 声称加密工作区的不可读数据可加密导出（[README.md:118](../README.md#L118)），当前正常路径实际拒绝这类输入。

## 审查盲区

- 按只读要求未运行 Cargo、Vitest、Edge、构建或性能 profile。
- 未验证 GitHub 实际生效的 ruleset、Actions 历史或产物来源。
- 未连接真实 D1、R2、B2、Tigris、OCI 或自定义 S3。
- 未验证 Windows Hello、Credential Manager、WTS、WebView2、掉电原子替换和主进程强杀的实机行为。
- 未进行独立完整 Security Review；这里只判断架构是否能承载 `SECURITY.md` 已声明的边界。
- 脚本执行尚未实现，因此只能判断现有扩展接口不足以直接安全承载它。

## 严格依赖顺序

1. **先定义跨层契约**：工作区事务状态机、提交结果枚举、工作区语义 revision、备份目标配置 revision、版本化 IPC DTO。
2. **修复数据事务**：Rust 实现 replace/swap journal；消除 commit 后普通 `Err`；阻止旧 React 快照回写。
3. **收紧 Rust 信任边界**：导入导出合并成 Rust 用例；活动时间改用可信原生输入和单调时钟。
4. **确定统一容量策略**：全局可移植预算或分块流式格式；之后才能扩展富内容和更大工作区。
5. **加入 compare-and-commit**：封住自动引用旧结果写回和备份状态跨配置代次写回；再修 keyring/config 删除事务。
6. **修复 TS/Rust 契约**：先修 `sourceFingerprint` 和 embedding role，再建立全部 IPC 回环门禁。
7. **建立真正可取消的 AI 任务端口**：流式 top-K、Worker/Rust 后台计算、可终止 embedding 进程。
8. **重构前端状态和画布索引**：节点级订阅、局部草稿、邻接/空间索引、静态路径缓存、搜索和列表虚拟化。
9. **决定 Worker 去留**：保留才修 create/update 事务、稳定错误、OpenAPI、鉴权、固定构建工具和 D1 集成测试。
10. **补齐工程门禁**：故障注入、大规模性能预算、默认拒绝敏感日志、required review/check、main-SHA 发布来源。
11. **最后更新文档与验收记录**；纯代码预览可在内容注册表泛化后加入，脚本执行必须排在隔离进程和权限代理之后。

未实施任何修复。

