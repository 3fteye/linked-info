# 开发与提交工作流

本项目采用短期功能分支和 Pull Request。`main` 只接收经过 CI 和审查的合并结果，不再直接推送日常开发提交。

## 分支与提交

1. 从最新 `main` 创建 `io/<主题>` 分支，例如 `io/canvas-keyboard-navigation`。
2. 只提交本次任务相关文件；本地草稿、真实工作区、导出、账号数据、模型文件和构建产物不得加入提交。
3. 在本地运行与改动范围相称的快速验证。完整检查由 Windows GitHub Actions 完成。
4. 推送功能分支并创建面向 `main` 的 Draft PR。实现和自检完成后将 PR 标记为 Ready for review。

## 审查流程

普通 Code Review 与 Security Review 是两条独立审查链：

- 普通 Code Review 使用 [AGENTS.md](AGENTS.md) 中的仓库规则。PR 进入 Ready 状态后由自动审查触发；需要重新审查时在 PR 评论中使用 `@codex review`。
- Security Review 使用仓库设置中单独指定的 [SECURITY.md](SECURITY.md)。只有改动涉及其威胁模型或强制安全边界时才触发对应安全审查，不能用普通 Code Review 代替。
- 本地开发期间可以使用 Codex `/review` 检查未提交改动、当前分支或单个提交；本地结果不能替代 GitHub PR 上的审查记录。

处理完审查意见后重新运行相关测试并推送到同一分支。所有阻断意见和对话解决、必需状态检查通过后，使用 squash merge 合并到 `main`，随后删除功能分支。

## 必需检查

面向 `main` 的 PR 必须通过：

- `Windows core, frontend and Worker`
- `Windows desktop check`

CI 在 PR 上验证功能分支，并在合并后的 `main` 上再次验证最终提交。Windows 便携包仍通过 `Desktop packages` 手动工作流从已经合并的提交生成，不从未合并分支发布最新版。

`main` 的仓库 Ruleset 由 [`.github/rulesets/main.json`](.github/rulesets/main.json) 记录：必须通过 PR、只允许 squash merge、解决审查对话并通过上述状态检查，同时禁止删除和强制推送默认分支。该文件是可审查的配置来源；修改后仍需由仓库管理员通过 GitHub API 或管理界面应用并核对实际状态。

## 紧急修改

紧急修改仍然创建最小功能分支和 PR，不绕过 `main` 规则。若 GitHub 或 CI 本身故障导致无法合并，应先确认故障范围并记录原因，再临时调整仓库规则；恢复后立即还原规则并补做审查。
