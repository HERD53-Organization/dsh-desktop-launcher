# 变更记录

本文件记录各版本的显著变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-09-26

文档更新，功能与 0.1.0 一致。面向用户的发行说明见 [`docs/RELEASE-v0.1.1.md`](docs/RELEASE-v0.1.1.md)，可直接作为 Release 正文。

### 新增

- `README.en.md` 英文文档；`README.md` 改为中文并作为默认，两者首行互链。
- 本变更记录。
- `.gitattributes` 把外发脚本（`setup.bat`、`打包.bat`）钉在 CRLF 上。此前仅靠打包脚本在组装时修复，全新克隆仍可能拿到 LF——而 `cmd.exe` 会错误解析 LF 行尾的 `.bat`，把 `REM` 注释块当命令执行。

### 修正

- 文档中的自检断言数由早期的「12/15 步」更正为实际的 **25 项**，并补全了后来新增的检查项（自启识别、注入的拖动条、渲染资源存在性、诊断页真实渲染）。
- 「已验证」章节引用了同样的过时数字，改为打包产物通过全部 25 项，并补充启动模式验证结果。
- 文档此前遗漏 `scripts/verify-launch-modes.ps1`，目录清单中也缺 `README.en.md`。

## [0.1.0] - 2026-09-26

首次发布。一个面向本地 `dsh web` 服务的托盘启动器与进程监管程序。

### 新增

- **托盘常驻**：左键打开或聚焦窗口，右键菜单提供重启服务、诊断、检查更新、开机自启开关、退出。界面文案为中文。
- **独立窗口**：DSH 界面运行在私有会话分区上，不影响用户的浏览器（无标签页、无历史、不共用 cookie）。
- **两种启动行为**：手动启动立即开窗；开机自启只装托盘、保持隐藏。
- **服务复用**：端口上已有服务则直接复用，不打断正在进行的会话。
- **认证**：从 `.credentials.yaml` 的持久会话密钥签发 cookie，而非抓取 stdout 的启动令牌。因此服务重启后无需重新认证，且能复用一个自己没启动的服务。
- **诊断窗口**：服务状态、解析出的路径、捕获的输出（已过滤 token）、一键复制地址。
- **手动检查更新**：读取全部已发布版本取 semver 最高者，忽略 npm dist-tag；安装前明确告知三项代价。
- **一键分享**：`打包.bat` 重建并组装 `DSH-Launcher\` 与压缩包；`share\setup.bat` 为接收方自动配置 Node.js 与 dsh。
- **图标**：由 `dsh-ico.ico` 生成 7 个尺寸的 ICO，并通过 Win32 资源 API 写入 exe。
- **自动化验证**：`npm run self-test`（25 项断言）、`scripts/verify-launch-modes.ps1`、`scripts/dump-exe-icons.ps1`。

### 已知不足

- macOS 与 Linux 为尽力而为；受支持平台是 Windows。
- 开机自启记录的是当时运行的副本，从 `build\` 或 `DSH-Launcher\` 启动时开启会记录下易失路径。
- 不管理 profile 依赖树。
- 图标源图仅 96×96，128 与 256 为插值放大。
- 未声明开源许可证。

[0.1.1]: https://github.com/HERD53-Organization/dsh-desktop-launcher/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/HERD53-Organization/dsh-desktop-launcher/releases/tag/v0.1.0
