# 2026-11 依赖安全修复

## 基线和范围

基于 main `b8adcae`，与标题复制 PR #34 分开。审计运行 41592368589 的 RustSec 数据库提交为 `263a4d951a0867d4bddc29dddd6d59427c78f9a7`，命中 6 个包、27 条漏洞公告；公告数量不是本应用已证实的可利用攻击路径数量。没有访问真实工作区或远端备份。

先核对源码调用和功能选择，再由 GitHub Actions 保存 Windows 实际 feature 反向依赖图并解析锁文件；解析成功不等于测试或漏洞审计通过。禁止忽略公告、降低审计门禁或在本机编译。此文记录初步可达性判断，不声称已经完成漏洞利用复现或汇编级侧信道验证。

## 六个依赖的影响

| 依赖（旧版本） | 源码证据与判断 | 目标版本 |
| --- | --- | --- |
| ctutils 0.4.2（1 条） | 锁文件经 digest 0.11.3 进入 hmac/sha2 新版本链。不是应用直接调用；具体 Windows 使用链以云端 feature 图为准。常量时间保证不能仅凭 x64 排除，升级，不宣称已证明密钥泄露或不受影响。 | 0.4.4 |
| rustls 0.23.45（4 条） | reqwest 的 rustls-tls 用于 S3、模型下载和可选远端模型。仓库没有自定义 ClientSessionStore/会话 Debug 输出、ECH 启用接口；旧锁文件 rustls 依赖不含 brotli，需 feature 图复核。密钥交换预测问题仍应修复，不以服务器行为作为安全保证。 | 0.23.46 |
| rustls-webpki 0.103.14（1 条） | TLS 证书链验证用于上述真实网络入口；不能排除攻击者伪造受影响证书链的风险。模型哈希和备份密文不替代服务器身份验证。 | 0.103.16 |
| webpki-roots 1.0.9（1 条） | hyper-rustls/reqwest 使用的根信任集；与证书验证库一起升级，避免仅修其中一个组件。 | 1.0.10 |
| wasmtime 48.0.5（16 条） | extension-host 使用独立进程、空 Linker、无导入和限额；Cargo 禁用默认功能，仅开启 anyhow/component-model/cranelift/runtime/std。runtime.rs 使用同步调用且 concurrency_support(false)，没有 call_async、宿主创建 StructType 或跨 Engine 类型共享接口。因此部分异步/GC/跨 Engine 公告缺少触发入口；但仍编译不可信组件，不能把进程限额视为运行时漏洞修复。保守升级整个 48.x 配套组件，不新增异步、GC 或 WASI 功能。 | 48.0.8 |
| zip 8.6.0（4 条） | 唯一 ZipArchive 读取在 extension-contracts/src/package.rs：by_index 逐项读取，拒绝目录与符号链接、验证路径和大小、读取限额+1 字节，不调用 ZipArchive::extract 或 ZipStreamReader::extract，也不恢复归档 Unix 权限。公告所描述的自动解压攻击链在当前源码未找到；仍升级解析库，并保留路径、链接、容量、签名回归。 | 9.0.0 |

## 上游依据

- [ctutils 常量时间问题](https://rustsec.org/advisories/RUSTSEC-2026-0385.html)。
- rustls：[Debug 输出](https://rustsec.org/advisories/RUSTSEC-2026-0346.html)、[ECH 拒绝](https://rustsec.org/advisories/RUSTSEC-2026-0347.html)、[Brotli 证书](https://rustsec.org/advisories/RUSTSEC-2026-0348.html)、[密钥交换预测](https://rustsec.org/advisories/RUSTSEC-2026-0349.html)。
- [证书链验证](https://rustsec.org/advisories/RUSTSEC-2026-0382.html)与[根信任集](https://rustsec.org/advisories/RUSTSEC-2026-0381.html)。
- [Wasmtime 跨 Engine 类型条件和修复版本](https://github.com/bytecodealliance/wasmtime/security/advisories/GHSA-qw58-7h65-crq2)；其余命中公告及版本范围以固定审计运行的完整 JSON 为准，不将这一例的不可达判断推广到全部 16 条。
- [ZIP 自动解压符号链接](https://rustsec.org/advisories/RUSTSEC-2026-0368.html)，其他三个命中项同样指向 extract/Unix 权限恢复路径。

## 验证要求与当前状态

云端生成锁文件后，核对每个更新项和新增传递依赖；保留 RustSec、许可证、SBOM、核心/扩展/桌面/Worker、前端构建和交互门禁。zip 9 为主版本升级，任何 API 差异只按编译与现有回归证据处理，不改安全校验策略。工作区 schema、密文格式、备份协议、扩展 WIT 均不变。

当前只提交影响分析和只读权限的云端锁文件准备任务，尚未声称升级完成。准备任务不提交或推送仓库；产物须匹配预期 run/head 后由代理审查并提交。完成安全 PR 验证与审查后，将其修复合入标题复制任务分支，重新执行该功能验证；PR 合并仍需 owner 单独授权。
