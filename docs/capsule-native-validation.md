# 胶囊原生 Windows 自动验收

本页说明原生回归的执行边界，不替代 [胶囊实施基线](capsule-notes.md) 或 Windows Hello、真实休眠的人工验收。

## 为什么不在当前账号下换目录测试

当前产品通过 Tauri 的应用标识解析 Windows Known Folders，并通过该标识维护单实例。复制 EXE、改变工作目录或修改 `APPDATA` 环境变量不能可靠隔离正式工作区；设备凭据还有独立的系统钥匙串命名空间。测试不得据此在用户账号下启动另一份应用。

原生自动回归限定在全新的 GitHub-hosted Windows runner。Node 驱动及两个 PowerShell helper 均要求 `GITHUB_ACTIONS=true`、`RUNNER_ENVIRONMENT=github-hosted`、`RUNNER_OS=Windows`；这些是防误运行检查，不是抵御本机恶意用户伪造环境变量的安全机制。

启动前必须确认 Roaming 与 Local Known Folder 下的 `com.linkedinfo.desktop` 两整根都不存在；发现已有目录即失败，不能读取或清空后继续。进程只运行本次 checkout 的 `target/release/linked-info-desktop.exe`。默认数据仅在这个独立 runner 中创建，不配置真实远端目标，不启用系统快速解锁，不接触个人凭据。

## 原生驱动与权限

- `.github/workflows/desktop-packages.yml` 先构建正常 portable EXE，再执行 `apps/desktop/scripts/native-capsule-smoke.mjs`。不会向发布包加入专用测试 IPC、调试编译特性或放宽 CSP。
- CDP 只在测试启动期间开放于 loopback。连接前验证监听进程属于本次 EXE 或其 WebView2 子进程；不连接已有浏览器或扫描其他页面。
- 使用锁定版本 Playwright 1.62 的 `noDefaults` 连接选项关闭默认焦点模拟，由真实 Win32 焦点驱动 `focus/blur` 与 `document.hasFocus()`；不能把两个页面同时被模拟聚焦的结果当成原生失焦证据。
- 高完整性级别的 WebView2 host 会忽略 `WEBVIEW2_*` 环境变量，因此 CI 使用精确 EXE 名的临时 `HKLM` 浏览器参数策略；仅创建原先不存在的值，并在结束时只移除与本次端口匹配的值，不能改通配策略、覆盖旧值或删除整个键。依据 [Microsoft 提权 host 说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/security#for-an-elevated-host-app-use-appropriate-override-flags) 与 [WebView2 调试参数说明](https://learn.microsoft.com/en-us/microsoft-edge/webview2/how-to/debug-visual-studio-code#using-a-registry-value)。此操作只在临时 runner 执行，不修改用户机器或发布产物。
- 窗口 helper 先验证 PID 的真实可执行路径，再检查该 PID 的窗口尺寸、DPI、置顶与边框属性，或执行限定窗口的焦点、鼠标拖动及关闭操作。
- 无标题栏按客户区顶部相对外框的实际偏移验证，允许 Windows 11 的一 DIP 阴影边。Tao 0.35 保留顶层窗口的 `WS_CAPTION` 位，通过 `WM_NCCALCSIZE` 移除标题栏，因此该标志只作诊断，不能单独当成显示原生标题栏的证据。客户区尺寸及置顶、可见性仍分别断言。
- 会话锁定和休眠使用向主 HWND 投递 Windows 通知的方式验证消息处理链；不会锁定或挂起整台 runner，不能把通知注入描述成操作系统真实锁定或物理休眠。

## 验证与输出

自动场景覆盖主窗口与胶囊的真实 WebView2 实例、展开/收起、原生窗口几何与拖动、快捷键和失焦保存、正式时间节点/引用、重复提交、撤销、权限拒绝、应用加密与锁定后的录入隔离。既有 Vitest 测试继续负责可控的提交失败、迟到回执、旧会话与关闭竞争。

所有录入文本和密码均为脚本内生成的合成数据。输出只包含固定检查项、通过/失败、数量及有限的窗口属性；不收集页面正文、控制台输出、底层异常正文、截图、录像或 trace。CI 只上传独立 JSON 摘要，不上传 WebView 用户目录或工作区文件。清理仅针对本次明确启动的进程和策略值，不使用按名称的广域终止或清空目录。

2026-09-03，最新 [Windows package 33737491604](https://github.com/3fteye/linked-info/actions/runs/33737491604) 对 `5b38892` 正式 EXE 完成 14 项原生检查，14 passed、0 failed、0 page errors，测试进程正常退出码为 0。该提交与最终验证基线 `8739dba` 的产品源码相同，后续只修改 CI 驱动、测试和开发说明。覆盖真实窗口拖动、原生失焦提交、重复提交去重、单次撤销、主窗口敏感命令拒绝、加密与最后快照锁定、通知撤权、隐藏和统一退出。CI 只保存结构化 JSON 摘要及正常 Windows 包，不包含测试工作区或浏览器目录。

Windows Hello、显示缩放与多屏实际观感、真实系统锁定、用户切换和硬件休眠仍需后续人工验收；本页不授权在用户机器上自动进行这些操作。原生验收成功也不替代 Rust/前端回归与云端审查；各项当前状态见[验证记录](capsule-notes.md#验证记录)。
