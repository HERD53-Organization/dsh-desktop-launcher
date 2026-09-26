> 中文为主，英文见下方 [English](#english)。
>
> 说明：仓库目前**不提供预编译产物**（`private: true`，且构建需本机 Node 环境）。
> 下方的体积数据对应自行构建后的结果。
>
> 粘贴到 Release 表单时请**先清空描述框**，并跳过「Generate release notes」——
> 否则平台的自动生成内容会与本文并存，看起来像重复了一遍。

---

第一次公开发布。

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **本地 `dsh web` 服务**的托盘启动器与进程监管程序——它只为一件事而生：不必再记住并手敲 `dsh web`。

## 它解决什么问题

`dsh web` 每次都要开终端、敲命令、等它打印带 token 的 URL。关掉终端服务就没了，而那个 URL 里还带着只对本次进程有效的令牌。

本启动器把这件事变成一次点击：托盘图标 → 窗口打开 → 直接可对话。

## 主要特性

| 特性 | 说明 |
|---|---|
| **托盘常驻** | 左键打开或聚焦窗口，右键菜单提供重启服务、诊断、检查更新、退出。界面为中文。 |
| **独立窗口** | DSH 界面运行在私有会话分区上，完全不碰你的浏览器：不开标签页、不进历史、不共用 cookie。 |
| **两种启动行为** | 双击启动 → 立即开窗；开机自启 → 只装托盘、保持隐藏，不会在登录时突然弹窗。 |
| **复用已有服务** | 端口上已有服务在跑就直接复用，**不打断**正在进行的会话。 |
| **断线自愈的认证** | 会话密钥是持久的，服务重启后认证依然有效，无需重新登录。 |
| **诊断页** | 服务状态、解析出的路径、捕获的输出、一键复制地址。 |
| **手动检查更新** | 读取全部已发布版本取最高者，**不会**因 npm dist-tag 落后而把你降级。 |
| **一键分享** | 双击 `打包.bat` 产出可直接发给别人的目录与压缩包，附带 `setup.bat` 自动配置对方环境。 |

## 两个值得说明的设计决定

**① 认证不靠抓取 stdout。** `dsh web` 使用两把独立的密钥：每次启动重新生成的进程令牌（即 URL 里那个 `?token=`），以及持久保存在 `.credentials.yaml` 中的浏览器会话密钥。启动器直接从后者签发等价 cookie 并加载裸 URL。这带来两个实际好处：**服务重启后不用重新认证**，以及**能够复用一个自己没启动的服务**。

这个格式属于内部实现细节（镜像自 `@deepseek-ai/dsh-client-connection`，非公开 API）。若将来 DSH 改了它，启动器会明确报错并回退到 stdout 打印的 URL。

**② `dsh` 必须用系统 Node 运行。** profile 依赖树里含按系统 ABI 编译的原生模块（`node-pty`、`sharp`、`koffi`），Electron 自带的 Node 无法加载它们。Electron 在这里只是外壳、托盘与窗口的持有者。

## 环境要求

接收方只需两样，都是一次性的：

1. **Node.js** —— 启动器用系统 Node 运行 `dsh`
2. **`@deepseek-ai/dsh`** —— `npm install -g @deepseek-ai/dsh`

**不需要 pnpm**，基础 profile 也**不需要**那约 451MB 的依赖树：随包分发的 bundle 会从 dsh 安装目录自身解析。已用全新 `DSH_HOME` 实测：只有全局 CLI 的机器可以从零启动。

## 快速开始

**自己构建：**

```sh
npm install
npm start
```

**分享给别人：** 双击 `打包.bat`，产出 `DSH-Launcher.zip`（约 147MB，由约 368MB 的目录压成）。对方解压 → 跑一次 `setup.bat` → 双击 `win-unpacked\DSH Launcher.exe` → 左键点托盘图标。

对方会遇到两个提示，`安装说明.md` 里都有说明：无代码签名导致的 SmartScreen 拦截（需点「更多信息」→「仍要运行」），以及网络来源文件标记（`Unblock-File` 可清除）。

## 已验证

自动化验证已内建，不依赖人工点检：

- **`npm run self-test`** —— 在隔离实例（独立 `user-data-dir` 与端口）上断言 **25 项**：Node/dsh 解析、自启识别、服务复用与冷启动、401 认证拦截、cookie 签发与注入、认证页面加载、子进程与端口释放、stop 幂等、托盘图标加载、关窗隐藏而非销毁、注入的拖动条、渲染资源存在性、诊断页真实渲染内容。
- **`scripts/verify-launch-modes.ps1`** —— 启动真实 exe 两次，通过枚举可见顶层窗口确认：手动启动 1 个窗口，自启 0 个。
- **`scripts/dump-exe-icons.ps1`** —— 从成品 exe 回读每个图标成员的载荷字节并与其声明尺寸比对。

在 Windows 上，源码树与打包产物均通过全部检查。

**未自动化**，因此改动窗口或托盘代码后需人工确认：托盘菜单各项动作、开机自启开关、以及更新流程本身。

## 已知不足

- **macOS 与 Linux 为尽力而为。** 受支持平台是 Windows。Linux 上托盘需要 AppIndicator 宿主（GNOME 需装扩展），macOS 的开机自启用登录项而非注册表。
- **开机自启记录的是当时运行的副本。** 从 `build\` 或 `DSH-Launcher\` 启动时开启自启，记录下的路径会被下一次构建清掉。长期使用请把启动器放到固定目录。
- **启动器不管理 profile 依赖树。** 若某次 dsh 更新改变了 profile 需求，下次启动可能较慢，或需要 `dsh plugin` 维护。
- **图标源图仅 96×96。** 128 与 256 为插值放大，无法比源图更清晰；托盘与任务栏实际使用的 16/32 是干净的降采样。换成 >=256px 的同图案即可解决。
- **未声明开源许可证。**

## 本次变更

首个公开版本。包含双语文档：`README.md` 为中文（默认），`README.en.md` 为英文，首行互链。

---

## English

A tray launcher and process supervisor for the **local `dsh web` server** of
DeepSeek Harness. It exists so that opening the harness is one click instead of
remembering a command, and so the server keeps running when no terminal does.

**Highlights**

- Tray icon opens or focuses its own window; the DSH UI runs on a private
  session partition, so the user's browser is never touched.
- Doubling down on the executable opens the window; an autostart launch only
  installs the tray.
- An existing server on the port is adopted rather than restarted, so a running
  session is not interrupted.
- Authentication is minted from the persistent browser-session secret rather
  than scraped from stdout, which is what lets it adopt a server it did not
  start and survive a server restart.
- Manual-only update check that reads every published version and picks the
  highest, ignoring npm dist-tags.
- `打包.bat` / `npm run release` produces a folder and zip ready to hand to
  someone else, together with a `setup.bat` that configures their machine.

**Requirements:** Node.js and `@deepseek-ai/dsh` installed globally. pnpm is not
required and neither is the ~451MB profile dependency tree; in-box bundles
resolve from the dsh installation itself.

**Verification is built in:** `npm run self-test` asserts 25 properties on an
isolated instance, `scripts/verify-launch-modes.ps1` checks both launch
behaviours by enumerating visible windows, and `scripts/dump-exe-icons.ps1`
re-reads every icon member payload from a finished `.exe`.

**Known limitations:** macOS and Linux are best-effort (Windows is the supported
target); the login item records whichever copy is running, so autostart should
be enabled from a stable folder; the launcher does not manage the profile
dependency tree; the icon source artwork is 96x96, so the 128 and 256 sizes are
interpolated; no open-source licence is declared.

This release also makes the documentation bilingual: `README.md` is Chinese by
default, `README.en.md` is English, and the two link to each other.
