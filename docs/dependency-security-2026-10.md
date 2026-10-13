# 2026-10 依赖安全升级

独立于备份状态 PR #25，以 main 为基线处理 RustSec 审计失败，不豁免漏洞或修改审计门槛。

## 升级范围

- Wasmtime 47.0.4 → 48.0.5：修复下限为 48.0.4，Cargo 在第二次定向解析时选择同系列的 48.0.5，因此 manifest 与最终锁文件统一为该补丁版本。覆盖 RUSTSEC-2026-0315、0316、0325、0326、0327。保持 default-features=false 和既有 feature 集合，不开放 WASI、网络、文件或异步组件能力。
- quinn-proto 0.11.16 → 0.11.18：覆盖 RUSTSEC-2026-0338～0342。由现有网络依赖链引入，不新增桌面网络权限。
- 锁文件来自 [Actions 38335326715](https://github.com/3fteye/linked-info/actions/runs/38335326715)，绑定准备提交 ace9c60846f8878c48dd16358e2f20c07905effe。产物 security-cargo-lock（11783994846）已取回并核对差异；临时生成工作流已删除。升级包含配套 Cranelift、Wasm 工具链及 Cargo 重解析的传递依赖边，不手写校验和。

版本依据：[Wasmtime RustSec](https://rustsec.org/advisories/RUSTSEC-2026-0327.html)、[quinn-proto RustSec](https://rustsec.org/advisories/RUSTSEC-2026-0338.html)。审计告警存在不等于所有漏洞在本项目的 feature 集合下都可触发，但不以此跳过升级。

## 验证与边界

测试和编译仅在 GitHub Actions：完整 RustSec 审计、扩展宿主单元与进程生命周期、SDK 外部示例、桌面构建、许可证和 SBOM，以及现有前端回归。普通与安全审查分别进行；待最终提交的 CI 和审查结果完成后记录证据。未通过前不合并、不更新本机应用。

不修改工作区格式、加密、IPC/WIT 契约、扩展签名策略、资源上限、取消及锁定行为。既有跨平台 GTK 告警按 SECURITY.md 保留披露，不通过新增 ignore 规避审计。
