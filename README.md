# DSH 桌面启动器

**中文** | [English](README.en.md)

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) **本地 `dsh web` 服务**的托盘启动器与进程监管程序。

它只为一件事而生：不必再记住并手敲 `dsh web`。托盘图标会在自己的窗口里打开 DeepSeek Harness、保持服务存活，并在出问题时告诉你究竟发生了什么。

范围是刻意收窄的。这是一个管理本机单个 `dsh web` 实例的自用工具，**不是** `deepseek-harness/apps/desktop` 里官方 Electron 桌面端的替代、封装或竞品；两者互不感知。

---

## 功能

| | |
|---|---|
| **托盘** | 左键打开或聚焦 DSH 窗口，右键打开菜单。菜单与状态文案为中文。 |
| **独立窗口** | DSH 界面运行在私有会话分区上。完全不碰你的浏览器：不开标签页、不进历史记录、不共用 cookie。 |
| **启动即开窗** | 双击启动器会立即打开窗口；由开机自启拉起时只装托盘、保持隐藏，不会在登录时突然弹窗糊你一脸。 |
| **复用或自启** | 若配置端口上已有服务在跑，直接复用；否则由启动器自己拉起 `dsh web`。 |
| **按需重启** | 只有托盘菜单里的「重启服务」会停掉东西，而且会先征求确认。 |
| **诊断** | 按需弹出的窗口，展示服务状态、解析出的路径、捕获的输出，以及复制 URL 按钮。 |
| **检查更新** | 仅手动触发。读取全部已发布版本，取其中最高者。 |

启动器自有界面（加载页、诊断页、错误页、窗口背景）使用 `#1f1d19` 底色与 `#f2efe9` 文字，原生标题栏也通过 `titleBarStyle: 'hidden'` 加 `titleBarOverlay` 调成同色。DSH 界面自己管主题，刻意不做干预——目标只是让它外圈的边框不再显得是硬拼上去的。

隐藏标题栏带来两个容易做错的后果：

- **原生拖动区会一起消失。** 页面若不自己提供，窗口就完全拖不动，因此在顶部注入了一条 32px 高、`z-index` 最高、透明的拖动条。它必须**按文档重新注入**，因为每次导航后新文档里都没有它。
- **覆盖层是点击穿透的。** 在 Electron 中拖动区不会吞掉鼠标事件，所以这条拖动条不会让下面的界面变得点不动。

开机自启如何识别：登录项注册时带上 `--autostart` 参数，启动时只认这个标志。另外两种做法都试过并失败，原因记录在 `launchedAtLogin()` 里——按 Run 键的值名匹配会失败，因为 Electron 把它写成 `electron.app.Electron`；按 `process.execPath` 比对命令行也会失败，因为启动器有两份副本，而 Run 记录总是指向最后一次切换开关时运行的那一份。`scripts/verify-launch-modes.ps1` 对两种行为都做了端到端验证。

## 环境要求

接收方只需要两样东西，都是一次性的：

1. **Node.js** —— 启动器用系统 Node 运行 `dsh`，所以 Node 必须在 `PATH` 上，或位于其标准安装路径。
2. **全局安装的 `@deepseek-ai/dsh`** —— `npm install -g @deepseek-ai/dsh`

就这些。已用一个全新的 `DSH_HOME` 实测：只有全局 CLI 的机器可以从零启动 web profile，自动创建出 `profiles/web/{package.json,cordis.yml,cordis.patch.yml,pnpm-workspace.yaml}`，并在**不存在** `profiles/node_modules` 的情况下完成配置合成。

**不需要 pnpm**，基础 profile 也**不需要**那约 451MB 的 profile 依赖树——因为随包分发的 bundle 会从 dsh 安装目录本身解析：`resolveBundleDir` 会先在安装锚点、之后才在 profile 目录里查找。只有当你用 `dsh plugin` 安装额外插件时，pnpm 和那棵依赖树才变得必要。

启动器从不携带凭据。每个用户填自己的 DEEPSEEK API Key；**永远不要**把自己的 `~/.dsh/.credentials.yaml` 拷贝给别人。

## 从源码运行

```sh
npm install
npm start
```

启动器常驻托盘。不主动打开就没有主窗口。

## 分享给别人

双击 **`打包.bat`**，或在命令行里：

```powershell
npm run release        # 依次执行 npm run dist 和 npm run share
```

两种方式都会产出内容等价的两样东西，发哪个都行：

| | |
|---|---|
| `DSH-Launcher\` | 文件夹；你也可以右键自己压缩 |
| `DSH-Launcher.zip` | 约 147MB，由那约 368MB 的文件夹压成 |

两者的根层都恰好只有三项：`win-unpacked\`、`setup.bat`、`安装说明.md`。若压缩包多出一层嵌套、缺少其中任一项，或 `setup.bat` 丢了 CRLF 行尾、混入非 ASCII 字节，打包流程会**拒绝出包**。

两个目录，两种职责，刻意分开：

```
build\            electron-builder 的原始产物；会被 npm run dist 清空，从不直接外发
DSH-Launcher\     最终交付目录；每次运行都由 build\ + share\ 重建
```

`setup.bat` **不能**放进 `build\`：`npm run dist` 会清空该目录，放在里面的东西下一次构建就没了。

接收方解压后：跑一次 `setup.bat`，双击 `win-unpacked\DSH Launcher.exe`，再左键点托盘图标。`setup.bat` 会在缺失时通过 winget 安装 Node.js、安装 `@deepseek-ai/dsh`，验证 `dsh --version`，并打印出 exe 的确切路径。重复运行是安全的。

有两件事要提醒对方，都写在 `安装说明.md` 里：

- **SmartScreen。** 构建产物没有代码签名，Windows 会提示"Windows 已保护你的电脑"；需要点**「更多信息」→「仍要运行」**。
- **网络来源标记（Mark-of-the-Web）。** 从网上传过去的文件带有区域标记，在解压目录里执行 `Get-ChildItem -Recurse | Unblock-File` 即可清除。

**不要**分享 `~/.dsh/.credentials.yaml` 或整个 `~/.dsh`：它们携带 API Key 引用和本机的会话签名密钥。构建产物本身是干净的——不含任何凭据，也不含任何机器专属路径。

对于从未配置过 dsh 的接收方，更推荐[官方桌面端](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/desktop/README.zh.md)：它内置 Node、pnpm 和 Python，提供已签名的安装包，完全不需要 `npm install -g`。本启动器是更轻的选择，适合已经在用 dsh 命令行、只想要一个托盘图标的人。

### 为什么 setup.bat 必须保持 CRLF 行尾

`cmd.exe` 会**错误解析**使用裸 LF 的 `.bat`：`REM` 注释块被当成命令执行，控制台里刷满
`'Launcher' is not recognized as an internal or external command`。任何用 LF 重写 `share/setup.bat` 的工具或编辑器都会让它复发。打包脚本每次运行都会修复并校验行尾，所以外发的副本始终正确；`.gitattributes` 同时在仓库层面把外发脚本钉在 CRLF 上，因此全新克隆下来也是完好的。

## 集成与构建

```sh
npm run dist        # 在 build/ 生成免安装目录产物（无安装包、未签名）
```

在只能走镜像的网络下，有三个环境陷阱：

- **Electron 二进制**默认从 GitHub releases 下载，在那里会**卡死**。`.npmrc` 固定了 npmmirror 镜像，所以普通的 `npm install` 即可完成。
- **electron-builder 的辅助压缩包**同样来自 GitHub。构建时需设置
  `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`
- **`winCodeSign` 辅助包在没有符号链接权限时无法解压。** 该压缩包内含 macOS 的 `.dylib` 符号链接，除非账户是管理员或开启了开发者模式，解压会以"客户端没有所需的特权"失败。`--dir` 构建不需要签名，因此 `win.signAndEditExecutable` 设为 `false`，从根本上避免了这次下载。只有真正要签名时才应把它打开。

### exe 图标是独立的构建步骤

关掉 `signAndEditExecutable` 避开了 `winCodeSign`，但它同时也跳过了 rcedit——于是打包出的 `DSH Launcher.exe` 会在任务栏、Alt-Tab 和资源管理器里保留 **Electron 的默认图标**。因此 `npm run dist` 之后会执行 `scripts/embed-exe-icon.ps1`，改用 Win32 API（`BeginUpdateResource`/`UpdateResource`）重写图标资源，而不是 rcedit。它只碰 `RT_ICON` 和 `RT_GROUP_ICON`，不动版本信息和清单，也不需要管理员权限。

这里有**两个真金白银踩过的坑**，改那个脚本前值得先读：

1. **`UpdateResource` 只按 id 覆盖，从不清理。** 在一个已带图标的文件上写 id 1..n，会留下陈旧的 `RT_ICON` 条目，于是从第二次运行起，一个声明"id 2 是 64x64"的组会读到上一轮留在 id 2 的东西。**磁盘上看这个组完美无缺。** Windows 拒绝这个不一致的图标集，并**回退到此前缓存的图标**——这就是为什么资源目录里尺寸都对，exe 却一直显示 Electron 图标。
2. **在同一个更新句柄里"先删后加"行不通。** 删光所有图标资源会让组结构指向已被移除的成员，而后续写入没有落地：文件最终变成一些成员读回来是垃圾数据的组。

可行的策略是分配一段**高于现有最大 id 的全新 id 段**，并且只覆盖那两个组 id（组数量是固定的）。这样不会复用任何陈旧资源，位图也不需要删除。

校验必须**逐成员比对载荷字节**，而不是只看组目录里的尺寸——陷阱 1 里，目录恰恰是看起来最正常的那个东西。脚本现在会把每个成员 id 解析成它的 `RT_ICON` 载荷，再把长度与声明长度比对。

`scripts/dump-exe-icons.ps1 -Executable <路径> [-OutFile icon.png]` 是独立的复核手段：它从成品 exe 里重新读出每个组和每个成员，并能把最大的那个导出为 PNG 以确认图案。

### 图标

项目根目录的 `dsh-ico.ico` 是唯一真源。托盘、任务栏、窗口和打包后的 `.exe` 全部渲染这一张图。

`npm run make-icons` 读取它并生成：

- `assets/icon.ico` —— 七个尺寸（16/24/32/48/64/128/256）
- `assets/icon.png` —— 256x256，用于无法读取 .ico 的平台

七个尺寸不是装饰。Windows 会按场景挑选——托盘和标题栏用 16，任务栏用 32，资源管理器用 48/256——而只带单个条目的 .ico 会被外壳缩放，恰好在最显眼的地方显得发虚。

**已知限制：源图只有 96x96。** 它的 DIB 头声明为 96x96（翻倍后的 192 高度用于覆盖 AND 掩码），所以 128 和 256 是插值放大出来的，不可能比源图更清晰。而 96 及以下的尺寸——也就是托盘和任务栏这两个真正被看到的地方——都是干净的降采样。把 `dsh-ico.ico` 换成同一图案的 >=256px 版本，就能让大尺寸变清晰，其它什么都不用改；`make-icons` 会打印一条提示，列出哪些尺寸是放大得到的。

`npm run preview-icons` 会写出 `preview-icons.png`：把每个尺寸 1:1 并排放好，用于实际判断可辨识度，而不是盲信缩放结果。

另外，`scripts/set-exe-icon.ps1` 按 Windows 期望的方式对尺寸分组：16/32/48/256 进入 `RT_GROUP_ICON` 2（即"小图标"资源），其余进入组 1。只用一个组其实也能显示，但资源管理器和 Alt-Tab 会挑错条目。

## 自检

点击托盘图标无法自动化，但最容易坏掉的部分可以无头检查：

```sh
# Windows
set DSH_LAUNCHER_SELF_TEST=1
npm run self-test

# POSIX
DSH_LAUNCHER_SELF_TEST=1 npm run self-test
```

它断言 25 项属性：Node 与 dsh 的解析、自检运行不会被误判为开机自启、服务复用**或**由启动器启动、未认证的根请求被 401 拦下、浏览器会话 cookie 能被签发并落入窗口会话、该 cookie 能通过 HTTP 认证返回 200、子进程与其端口被释放、stop 是幂等的、托盘图标能加载、关闭窗口是隐藏而非销毁、注入的拖动条存在且声明了拖动区、渲染资源存在，以及诊断页确实渲染出了内容。任何一步失败，退出码都非零。

用 `DSH_LAUNCHER_SELF_TEST_PORT=3081` 把它指向一个临时端口，就不会打扰正常实例。它同样适用于打包产物：

```sh
"build/win-unpacked/DSH Launcher.exe"
```

`scripts/verify-launch-modes.ps1` 覆盖自检覆盖不到的部分：它把真实 exe 启动两次，通过枚举可见的顶层窗口，确认手动启动会开窗、开机自启（`--autostart`）只装托盘。

---

## 认证是怎么工作的

这是设计中**最不显眼**的一环，也是启动器能够复用一个非自己启动的服务的原因。

本地 `dsh web` 服务使用**两把互相独立的密钥**：

| 密钥 | 存放位置 | 生命周期 | 作用 |
|---|---|---|---|
| 进程启动令牌 | 仅进程内存 | 每次启动重新生成 | 即 `dsh web` 打印的 URL 里那个 `?token=`。只在首次 `GET /` 时校验一次。 |
| 浏览器会话密钥 | `~/.dsh/.credentials.yaml` 中的 `client-connection/browser-session` 记录 | **持久** | 用于给 `HttpOnly` 的 `dsh-auth-<authority>` cookie 签名，之后每个请求都靠它认证。 |

第一个携带有效启动令牌的请求会被回以一个重定向和一个由**持久**密钥签名的 `Set-Cookie`。此后 cookie 就是唯一的凭据。正因为该密钥的生命周期长于进程，拥有自己 Electron 会话的启动器可以直接签发一个等价的 cookie 并加载裸 URL——不必抓 stdout、不需要启动令牌，也不用重启一个自己并不拥有的服务。

cookie 载荷里只带 authority 与签发/过期时间戳，**从不包含启动令牌**，所以签发出来的 cookie 能跨服务重启存活。

两点值得知道：

- **这个格式是内部实现细节。** 它是从 `@deepseek-ai/dsh-client-connection` 镜像过来的，不是公开 API。若 DSH 改了格式，启动器会**明确报错**：窗口显示具体的认证错误，同时监管逻辑保留 stdout 打印的 URL 作为兜底。
- **那个密钥就是凭据。** 读到它等同于持有本机 `127.0.0.1:3080` 的登录态。它只在内存中读取，从不写日志，也从不经 IPC 传递。捕获的输出经过过滤，`?token=` 的值绝不会出现在诊断窗口或任何日志文件里。

## 硬性约束

这些不是偏好，破坏其中任何一条都会做出一个坏掉的启动器。

1. **`dsh` 必须在系统 Node 下运行，绝不能用 Electron 自带的 Node。**
   `$DSH_HOME/profiles/node_modules` 里是为系统 Node 的 ABI 编译的原生模块（`node-pty`、`sharp`、`koffi`）。Electron 只是外壳、托盘和窗口的持有者。解析出的 Node 路径会缓存在启动器配置里，以免之后 PATH 变化时静默切换运行时。

2. **启动器从不写入 `~/.dsh` 的配置。** DSH 通过文件监视器热加载 `settings.yaml` 和 `profiles/web/cordis.patch.yml`；第二个写入者会和运行中的服务互相打架。启动器自己的设置存放在 Electron 的 `userData` 下。

3. **启动器从不触碰 `profiles/desktop`**，也从不启动 `--profile desktop`。那个 profile 归官方桌面端所有，CLI 自身也拒绝它。

## 更新通道

版本选择刻意**忽略 npm dist-tag**。在这个产品上，`latest` 落后于 rc 线——撰写时 `latest` 是 `0.1.5-rc.3`，而最新已发布版本是 `0.1.7-rc.2`——所以任何依赖 tag 的做法要么卡住、要么静默把用户降级。更新器读取完整版本列表，取 semver 最高者（含预发布），并跳过桌面端打包流水线产出的四段式测试构建。

安装从不自动进行。确认对话框会讲清三项代价：会先停服务（打断运行中的 agent 任务）、Windows 上 dsh 运行期间全局安装会失败、以及下次启动可能重装 profile 依赖树。

## 目录结构

```
src/
  main.js       托盘、单实例锁、窗口编排、IPC、自检
  dsh.js        node/dsh 解析、端口探活、spawn、stdout 解析、进程树终止
  auth.js       会话密钥读取、cookie 签发、会话注入
  config.js     启动器设置（存于 userData）
  updater.js    版本发现、semver 选择、全局安装
  preload.js    窄接口渲染进程桥
renderer/
  loading.html      服务启动期间显示的等待页
  diagnostics.html  状态、路径、捕获输出、操作按钮
scripts/
  make-icons.js           由 dsh-ico.ico 重新生成 assets/
  preview-icons.js        并排尺寸图，用于判断可辨识度
  set-exe-icon.ps1        把图标资源写入构建出的 .exe
  embed-exe-icon.ps1      构建钩子包装；目标缺失时明确报错
  dump-exe-icons.ps1      独立回读成品 .exe 的图标
  verify-launch-modes.ps1 校验手动启动与开机自启两种行为
share/
  setup.bat               接收方的一次性环境配置；纯 ASCII，必须保持 CRLF
  打包分享包.ps1           组装 DSH-Launcher\ 并校验压缩包
  安装说明.md              随包发给接收方的中文安装说明
打包.bat                  双击即可：重建 + 打包一步完成
assets/
  icon.ico          7 个尺寸，生成物 —— Windows 托盘、窗口与 .exe 图标
  icon.png          256x256，生成物 —— 其它平台的托盘、mac/linux 构建用
dsh-ico.ico         受版本管理的 96x96 源图，唯一图标来源
README.md           本文档（中文，主）
README.en.md        英文版
```

以下目录为生成物，从不手工编辑，可安全删除重建：`build\`（由 `npm run dist` 生成）、`DSH-Launcher\` 与 `DSH-Launcher.zip`（由 `npm run share` 生成）。

## 已验证

两条监管路径都由自检覆盖，以下结果均在 Windows 上、对源码树和打包产物分别观察到：

- **复用** —— 3080 上已有的监听被复用、完成认证，并被原样保留运行；对打包出的 `DSH Launcher.exe` 同样通过。
- **冷启动** —— 启动器在一个空闲端口上拉起 `dsh web`、完成认证，然后将其停止，子进程消失、端口释放。

打包产物通过了全部 25 项自检断言；`scripts/verify-launch-modes.ps1` 报告手动启动时有 1 个可见窗口，开机自启时为 0 个。

以下内容未做自动化，因此改动窗口或托盘代码后请手工验证：托盘菜单各项动作、开机自启开关、以及更新流程。

## 已知不足

- macOS 与 Linux 为尽力而为。受支持的平台是 Windows；Linux 上托盘需要 AppIndicator 宿主（GNOME 需装扩展），macOS 的开机自启用的是登录项而非 Windows 注册表。
- 官方桌面端那种无托盘的窗口聚焦方式无法复用；本启动器始终打开自己的窗口。
- 启动器不管理 profile 依赖树。若某次 dsh 更新改变了 profile 需求，下次启动可能较慢，或需要 `dsh plugin` 维护。
- 登录项记录的是当时正在运行的那份副本。因此在从 `build\` 或 `DSH-Launcher\` 启动时开启自启，记录下的路径会被下一次构建清掉。长期使用自启请把启动器放到固定目录。
