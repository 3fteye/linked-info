---
name: linked-info-commit-discipline
description: '为 D:\soft\memory（3fteye/linked-info）创建、审查和发布提交，基于 Conventional Commits 与仓库本地规则检查 staged diff；每次成功提交后立即推送任务分支并创建或更新 Draft PR，再根据本次提交与累计 PR 风险决定是否触发 Codex Code Review 与 Security Review。Review 命令必须由 owner 已确认且绑定可用 Codex 工作区的 GitHub 身份发送。任何 AI、agent、编辑器助手或自动化工具在被要求暂存、提交、推送、创建或更新 PR、起草或改写 commit message、审查 staged changes、选择提交拆分点、处理云端 Review，或修复历史 commit message 时使用。'
---

# Linked Info Commit Discipline

## 目标

让 `3fteye/linked-info` 的提交可审查、可回溯。每次成功提交后立即推送任务分支并维护 Draft PR，再对本次提交和累计 PR diff 做明确的云端 Review 分级。聊天上下文不是本流程的事实来源；以当前 staged diff、仓库文件和当轮验证为准。

## 提交前流程

1. 先读取仓库根 `AGENTS.md`，再按改动范围读取 `DEVELOPMENT.md`；涉及安全边界时还要读取 `SECURITY.md`。
2. 写提交信息前运行：
   - `git status --short`
   - `git diff --cached --stat`
   - `git diff --cached --name-only`
3. 用户要求提交但没有 staged 文件时，先检查 unstaged changes 并提出合理分组；不要盲目执行 `git add .`。
4. staged diff 混入无关的运行时代码、测试、文档、规划、工具、资产或仓库配置时，停止并建议拆分，不能用宽泛标题掩盖混杂。
5. commit message 只能基于 staged diff 和本轮实际运行的验证。未运行或未读到结果的测试不能写成通过。

## GitHub 发布与 Codex 云端审查

### 当前设置

- `3fteye/linked-info` 的仓库项为 `Follow personal`；个人 `Auto review` 已关闭，因此普通 Code Review 当前由发布代理手动判断和触发。
- `Exhaustive code review` 保持关闭。
- 普通 Code Review 与 Security Review 是两条独立链路；Security Review 的判据以仓库根 `SECURITY.md` 为准。
- 当前批准的有序 Review 身份为 `rashadrao335566`、`qawskioe`、`ryansamze797`；普通 Code Review 与 Security Review 分别维护触发和回退状态，可以由不同的已批准身份收口。
- 本机 `gh` 的固定日常账号是 `FSOTM`。Review 身份只在发布和核验 Review 命令期间临时使用，结束、失败或中断后都必须恢复并核验 `FSOTM`。

### 分支、自动推送与授权边界

- Owner 已设定长期规则：授权代理创建 commit 时，同时授权把该 commit 推送到本仓库远端、创建或更新对应 Draft PR，并按审查分级发布所需 Review 命令。除非 owner 当次明确要求“仅本地提交”或“不要联网”，不得停在只领先本地的状态。
- 新工作必须位于任务专属分支，不得直接堆积在 `main`。第一次推送使用 `git push -u origin <branch>`，后续每次成功 commit 后立即 `git push`。如果共享 checkout 中存在其它活跃任务，不得擅自切换它们正在使用的分支，应转到独立 worktree 或报告并停止。
- 第一次推送任务分支后创建面向 `main` 的 Draft PR；后续提交更新同一 PR。提交前已经存在对应 PR 时复用，不得为每个 commit 重复创建 PR。
- 每次推送后，以本次 commit diff 判断是否引入新的审查风险，同时以累计 PR diff 确认审查范围。命中普通或安全审查判据时，在当前 PR head 上触发对应 Review；未命中时不发表评论并记录跳过理由。
- push 或 PR 更新失败时，保留本地 commit，立即核对远端与当前分支状态并报告失败层；不得声称发布完成，也不得改用其它账号或其它分支绕过失败。
- 该长期授权不包含合并 PR、改分支保护、修改仓库 Review 设置、force push、rewrite、rebase 或删除远端分支。

### Review 评论账号

提交作者、push 身份和 Review 评论身份彼此独立。不要为了触发 Review 改写提交作者、提交者或远端推送身份。按 `rashadrao335566` → `qawskioe` → `ryansamze797` 的顺序处理已批准身份；新增或替换身份仍须由 owner 明确确认。普通 Code Review 与 Security Review 独立计数。

1. 优先使用 GitHub connector 的 PR conversation comment，但只有 connector 的实际 login 严格等于当前候选身份时才能使用；发布后从 PR conversation 回读评论作者。Connector 属于后续候选时不得提前使用。
2. Connector 不可用、身份不符或发布失败时，使用本机 `gh` 的当前候选身份。账号尚未保存在本机时，由 owner 自行完成浏览器登录；代理不得接收或转发 token。
3. 使用本机 `gh` 前先读取当前活跃账号。对当前候选运行 `gh auth switch -h github.com -u <approved-login>`，再运行 `gh api user --jq .login`；输出严格等于候选 login 后，才能向 `3fteye/linked-info` 发布 Review 命令。
4. 普通 Code Review 评论以 `@codex review` 开头；Security Review 评论正文必须严格等于单行 `@codex security review`，不得追加焦点、标点、说明或换行。发布后必须回读作者；Security Review 还要核对完整正文相等。
5. 评论发布后立即运行 `gh auth switch -h github.com -u FSOTM`，再以 `gh api user --jq .login` 核验固定日常账号已经恢复。不得在 Review 身份下执行 push 或无关 GitHub 操作。

账号核验、切换、评论发布或 `FSOTM` 恢复任一步失败时，停止当前身份并报告具体失败层。评论确定未发布时可以继续下一候选；评论已经发布时，只有下面定义的明确回退条件或 owner 当次明确要求切换身份，才允许使用下一候选，避免异步重复触发。

Security Review 评论若带有命令之外的任何文字，即使 GitHub 已创建评论，也不算有效请求；服务端是否记录该错误请求应视为未知。未经 owner 明确授权故障排查，不得自动用同一身份或其它身份重发。

### Review 账号回退

- Review 命令发布后，以 Codex 的 👀 反应或审查任务出现作为已触发证据；一旦触发，立即停止该 PR head、该 Review 类型的全部账号回退。
- Codex 明确回复额度、usage limit、credits、身份未启用 Review，且评论没有 👀、没有审查任务时，可以切换到下一已批准身份。owner 当次明确要求切换账号时，也允许在回读确认前一身份没有触发证据后切换。
- 单纯无响应、超时或读取失败通常属于状态未知，不得自动重发；没有 owner 明确指示时应停止并报告。
- 同一 PR head、同一 Review 类型、同一 GitHub 身份最多主动请求一次。普通 Code Review 与 Security Review 分别计数；不得重复使用已经失败或已经触发过的身份。
- 所有已批准身份都明确未触发时，报告每个身份的失败原因并停止；不得使用未获批准的本机账号、提交账号或 connector 身份兜底。

### Review 分级

以最终 PR diff 为范围，不只看最后一个 commit：

1. **不触发云端 Review**：纯说明性文档、拼写或格式修正、不会进入执行或发布路径的独立产物，以及可由确定性检查充分覆盖的机械变更。
2. **触发普通 Code Review**：任何进入正式产品或工具执行路径的 Rust、TypeScript/TSX、JavaScript、配置或脚本变更；领域行为、持久化或迁移、导入导出、画布交互、状态与异步时序、供应商适配器、Tauri/React/Rust 边界、测试语义或覆盖范围、构建/CI/依赖，以及会改变代理决策的 `AGENTS.md`、技能或执行型配置。
3. **普通 Code Review + Security Review**：除普通审查外，最终 diff 还涉及持久化 schema/迁移/拒绝策略，或改变 `SECURITY.md` 的强制安全边界、威胁模型或发布供应链约束，例如明文生命周期、密钥与重新认证、加密持久化、WebView/IPC 权限、扩展隔离、远端备份凭据、不可信输入、日志与剪贴板、删除或更新签名。Security Review 只能附加在普通 Review 之上，不能替代普通 Review。

没有触发时，在交付报告中记录具体理由。不能只根据文件扩展名、提交 type 或改动行数分级。

### Review 收口

1. 评论发布后，以 Codex 的 👀 反应或审查任务出现作为“已触发”证据；仅有评论文本或 push 成功不算。
2. 每个 PR head、每种 Review、每个已批准身份最多主动请求一次；只有“Review 账号回退”的明确条件才允许切换身份。
3. 逐条回到当前源码和测试核验审查结果。有效问题必须修复并重新运行相关最窄验证；误报要给出具体反证。
4. 修复产生新 head 后，只有修改触及原审查风险或使旧结论失效时，才重新请求对应 Review。
5. 当前 head 没有已确认且未处理的严重发现，才能声称 GitHub 提交已完成审查。Review 无发现不替代本地测试、CI 或 owner 验收。

## 验证

验证强度与改动范围相称，优先执行最窄相关检查。仓库的完整命令与当前基线以 `DEVELOPMENT.md` 和 `.github/workflows/ci.yml` 为准。

- Rust 格式：`cargo fmt --all -- --check`
- 核心 Rust：`cargo test -p linked-info-contracts -p linked-info-domain -p linked-info-storage-port -p linked-info-storage-memory -p linked-info-application`
- 桌面 Rust：`cargo test -p linked-info-desktop --lib`
- 前端（在 `apps/desktop`）：`pnpm test`、`pnpm test:e2e`、`pnpm build`
- Cloudflare Worker 变化：运行工作流中对应的 wasm32 clippy 与测试。

不要为了 GitHub 发布而擅自扩大到与改动无关的昂贵检查；但不能用云端 Review 代替受影响范围的本地验证。

## Commit message

使用：

```text
type(scope): 中文 subject

变更：
- ...

验证：
- ...
```

- `type` 和 `scope` 使用小写 ASCII；subject 默认用中文，代码标识保留英文。
- 常用 type：`feat`、`fix`、`refactor`、`docs`、`test`、`tools`、`build`、`ci`、`chore`。
- 常用 scope：`domain`、`storage`、`backup`、`security`、`extensions`、`desktop`、`ui`、`canvas`、`import`、`export`、`tests`、`ci`、`deps`、`docs`、`agents`。
- 同一行为的代码和测试放在同一提交并使用生产代码 type；只有纯测试变更才使用 `test`。
- 持久化 schema、导入导出或迁移变化必须在 body 说明兼容性、迁移或拒绝策略。不兼容变化使用 `BREAKING CHANGE:` footer。
- body 优先解释逻辑、边界、兼容性和验证证据，不要只复述文件列表。
