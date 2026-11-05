# dsh-thu-plugin 开发计划

面向清华学生的 DSH 插件：把 thu.services 上已有的工具接进 DSH。文件和教材在会话里下载；面板上的按钮只负责把那几个外部工具装到本机。

本文是项目主计划。工具契约见 [TOOLS.md](TOOLS.md)，调研依据见用户提供的四功能调研（thu-learn-lib / @thu-info/lib / reserves-lib downloader / THU-Cloud-Downloader）。

## 1. 目标与非目标

目标：装进 DSH 后，用一句话完成三件事——下载网络学堂文件、下载教参教材、批量下载清华云盘共享链接。面板不列这些文件；它只提供几个外部工具的「下载 / 安装」按钮。

非目标：

- 不做 GPA / 成绩单计算。**已明确排除**，随之也排除 `@thu-info/lib` 这个 BSL-1.1 依赖，整条成绩链不在本插件范围内。
- 不重写任何爬虫，不实现清华统一身份认证，不做浏览器自动化登录，不分发第三方工具源码。

一句话定位：**这是一个适配层**——把已有工具的能力翻译成 DSH 的 `defineTool` 工具；文件、教材、云盘内容都在会话里下载。轻量面板上的按钮下载的是那几个外部工具本身（装到本机），不是课程文件。凭据与落盘由 DSH 自己管。

## 2. 硬边界（先定，后面所有设计服从它）

| 约束 | 来源 | 落地做法 |
| --- | --- | --- |
| 不代填密码、不绕过二次验证 | 清华 SSO 有 2FA | 登录要么复用浏览器已有会话，要么由用户在凭据卡里粘贴 cookie/指纹；插件只读凭据，不回显、不落明文日志 |
| 教参下载器 GPL-3.0 | libthu/reserves-lib-tsinghua-downloader | 只以**子进程**调用其 CLI，绝不 import 源码、不打包进 npm 包、不放 `vendor/` |
| 云盘脚本无许可证 | chenyifanthu/THU-Cloud-Downloader | 只参考其调用的 Seafile 公开接口，自己写无交互客户端 |
| 模型不可见明文凭据 | DSH 凭据约定 | 全部走 `ctx.credentials.resolve()`；工具参数里不出现 password/token 字段 |

结论：**只有 thu-learn-lib（MIT）可以正常作为 npm 依赖**，另两个都要绕开许可证与交互式设计。

## 3. 产品形态

四件东西：

1. **工具**（`defineTool` 注册到 `ctx.tools`）：模型侧入口。列举课程文件、教参章节、云盘目录，并在会话里触发下载。这是文件和教材的唯一下载入口。
2. **工具安装面板**（client face）：几行外部工具，每行一个「下载」按钮和安装状态。按钮下载的是工具（仓库或发布包），不是学堂文件、不是教材、不是云盘里的资料。
3. **host 路由**（`ctx.connection.fetch.register`）：面板与安装器之间的通道，`GET` 取各工具是否已安装，`POST` 起安装。token-watch 已证明这条通道可用。
4. **凭据**（`ctx.credentials`）：学号与密码用 `MADMODEL_USERNAME` / `MADMODEL_PASSWORD`（与 `dsh-thu-automad` 共用同一对引用，引用名可用 `usernameRef` / `passwordRef` 改），另有 `THU_LEARN_COOKIE` / `THU_LEARN_FINGERPRINT` / `THU_RESERVES_TOKEN`，用户在设置页或 `request_secret` 卡片填写。

为什么安装按钮不挂在工具结果卡上：`output.presentationMeta` 能投影的卡片是核心包里的**封闭 union**（`card: 'read' | 'search' | 'web' | …`），包外插件新增一个 card kind 需要改核心，做不到。会话工具仍用 `render` 出文本。

为什么不用 `action-cards`：它做的是"答案下方的一次性提案卡"，动词按 kind 全局定义而不是按行，塞不进"每个文件一个按钮"；而且它是 experimental 包，release 插件不得在 `dependencies` 里点名它。两个理由都成立，直接排除。

## 4. 目录结构

```
dsh-thu-plugin/
├── package.json          # dsh.bundle + dsh.client，license: MIT
├── cordis.patch.yml      # 插入插件行（裸包名）
├── dev.overlay.yml       # checkout 内开发用，指绝对 src 路径
├── tsconfig.json
├── tsdown.config.ts      # host + client 两个 face
├── checks/
│   ├── host-smoke.ts     # 无凭据时正确返回领域结果
│   └── client-smoke.ts   # 面板与按钮的纯函数部分
├── src/
│   ├── index.ts          # apply(): 注册工具与面板路由
│   ├── config.ts         # Config schema（并发、保存目录、超时、限速）
│   ├── status.ts         # thu_status 的数据源
│   ├── credentials.ts    # 凭据解析与缺失提示
│   ├── download.ts       # 统一下载引擎：并发/断点/进度/落盘
│   ├── routes.ts         # 面板用的 connection.fetch 路由
│   ├── client/           # 浏览器半边
│   │   ├── index.ts      # 座位注册入口
│   │   ├── Panel.tsx     # 下载面板：列表 + 按钮 + 进度
│   │   ├── locale.ts     # 中英文案
│   │   └── styles.ts
│   ├── learn/
│   │   ├── client.ts     # thu-learn-lib 适配与重登
│   │   └── tools.ts      # 学期/课程/文件
│   ├── reserves/
│   │   └── tools.ts      # 子进程调用 downloader.py
│   └── cloud/
│       ├── client.ts     # Seafile share-link API
│       └── tools.ts
└── test/                 # 纯函数单测（链接解析、path 拼接、glob 匹配）
```

依赖策略：`thu-learn-lib` 进 `dependencies`；HTTP 用内置 `fetch`；子进程用 `node:child_process`；client 半边只依赖 React 与注入的 `@deepseek-ai/*`，一律不进 `dependencies`；不引入 `@thu-info/lib`。

## 5. 实现要点

### 5.1 网络学堂（唯一"正规库"路径）

- 用 `Learn2018Helper`：`login(username, password, fingerPrint)` → `getSemesterIdList()` → `getCourseList()` → `getFileList(courseId)`。
- `login` 需要 `fingerPrint`，且必须来自真实走完 SSO 的浏览器会话——这是全项目最硬的一处，**不做自动化登录**。
- 文件对象只有 `downloadUrl`，库不提供下载：`download.ts` 带 cookie 拉取，写进工作区，返回路径与大小。
- cookie 过期自动重登由库负责，但需要 `CredentialProvider` 能重新拿到密码 → 密码走 `ctx.credentials` 每次 resolve，不缓存。

### 5.2 教参教材（子进程）

- 只把上游 CLI 当子进程（GPL-3.0，不 import、不 vendor）。`spawn` 时 stdin 设 `'ignore'`：这个 CLI 里有 `input()` 交互，管道接法会挂死。
- 上游只支持整本下载（没有章节参数），所以工具签名是 `url` + `quality`；章节选择留给用户裁 PDF。
- token 从 cwd 的 `token.txt` 读，所以运行目录是临时目录、插件写 0600 的 `token.txt`、结束后整个目录删掉——token 不落工作区。
- 先本地解 JWT 的 `exp`（提前 60 秒）：缺失 / 非 JWT / 过期分别返回 `token-missing` / `token-invalid` / `token-expired`，绝不触发 CLI 的 selenium + `input()` 分支。
- 限速：固定 `-c 1` + 间隔下限 `reservesDelayMs`；作者明确说明请求过快会封号，默认值必须保守。
- 进程用 `AbortSignal` 与 `reservesTimeoutMs` 管理（SIGTERM 后 5 秒 SIGKILL）；输出尾部进 `log`，失败是领域结果不是异常。
- 成功产物从运行目录移到 `<downloadDir>/reserves/<bookId>.pdf`，重名加 `-1`…`-99`。

### 5.3 云盘（自己写客户端）

- 只支持 `https://cloud.tsinghua.edu.cn/d/<share_key>/` 形式的共享链接。
- 接口：`GET /api/v2.1/share-links/{share_key}/dirents/?path=<p>` 递归列目录，再按 `files` 下载 URL 逐个拉取。
- `-f` 之类 glob 语义自己实现（`picomatch` 或简单后缀匹配），不要照抄脚本注释里的"正则"。
- 无登录态、无密码交互；遇到加密共享链接直接报"不支持，请先手动解密"。

### 5.4 轻 UI（外部工具的下载按钮）

落点：设置面板里的一页（`settings.section`，id `thu`，order 40，导航名「清华工具」）。安装与凭据都是配置动作，设置面板自带导航与内容列，不必再造浮层；也避免浮标压在会话右下方挡住输入区。不抢 `conversation.composer.statusPillReading`——那是 token-watch 的读数座位。

面板只做一件事：列出需要装到本机的外部工具，每行一个「下载」按钮。学堂文件、教参章节、云盘资料不出现在面板上，那些走会话工具。

首版按钮：

| 按钮 | 装什么 | 为什么不打进本包 |
| --- | --- | --- |
| 教参下载器 | `libthu/reserves-lib-tsinghua-downloader` 的 CLI，装到本机路径，供 `thu_reserves_download` 子进程调用 | GPL-3.0，不能 import、不能打包、不能放 `vendor/` |
| 学堂库 | `thu-learn-lib` 已是 npm 依赖，按钮只在缺失时提示安装，不重复下载 | MIT，可以进依赖 |

云盘脚本（`chenyifanthu/THU-Cloud-Downloader`）**没有按钮**：无许可证，且 Seafile 客户端已经自己写了，不需要把那个脚本装下来。

按钮语义：点击 = 直接 `POST /api/thu/install` 把该工具装到本机，**不经过模型**，也不下载任何课程文件。装完后 `thu_status` 的对应项变绿。如果按钮只是生成一句"请帮我安装 X"，那 UI 退化成提示词按钮，不如不做。

面板与 host 的通道：

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/api/thu/panel` | `GET` | 各外部工具是否已安装、缺哪一项 |
| `/api/thu/install` | `POST` | body `{ tool: 'reserves' }`，开始安装，返回 `{ taskId }` |
| `/api/thu/install` | `GET` | `?taskId=`，返回 `{ state, error? }` |

安装进度只留在内存。面板不提供文件下载任务。

UI 的代价（写在这里以免以后当成意外）：加界面意味着要维护 client 构建 face、懒加载 CJS 工厂格式、locale 字典、样式与主题变量、以及"改了 UI 必须重新 build + 刷新浏览器"这条开发纪律。

## 6. 里程碑与验收

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| M0 骨架 ✅ | 包结构、`cordis.patch.yml`、空 `apply`、`Config` schema | `dsh --profile thu --dump-config` 能看到本插件的层；插件加载无报错 |
| M1 云盘 ✅ | Seafile 客户端 + 列目录 + 下载 | 已实现 `thu_cloud_list` / `thu_cloud_download`；离线用 loopback 假 Seafile 覆盖列目录、递归、落盘、筛选、404、超时。**待办**：拿一个真实共享链接跑一次 |
| M2 学堂 ✅（离线） | thu-learn-lib 接入 + 列学期/课程/文件 + 下载 | 已注册四个 `thu_learn_*`。密码登录走库；cookie 不能灌进库的闭包，故单独打学生 JSON。落盘共用 `writeBody`。缺凭据返回 `missing-credential`。**待办**：用户用真实指纹或 cookie 列出本学期并下载一个文件 |
| M3 教材 ✅（离线） | 子进程封装 + token 预检 + 落盘 | `pnpm run check` 用假 CLI 覆盖 6 条失败路径与成功落盘；token 缺失/过期不触发浏览器登录分支。**待办**：真实 token + 真实书目跑一次 |
| M4 轻 UI ✅（离线） | client face、设置页一节（`settings.section`，id `thu`）、安装路由、教参 CLI 下载按钮、学堂四项凭据写入 | `pnpm run check` 全绿；client 产物是 `window.__ModuleLoader__.load` 工厂。面板读凭据只用 `describe`，写走 `set` / `unset`，响应不回显明文。面板上不出现课程文件或教材。`check:client` 校验产物的 `require` 只落在平台单例白名单内。**待办**：重启 `dsh web` 后在设置里打开「清华工具」，点安装按钮、保存一项凭据 |
| M5 打磨 | 错误文案、README、示例配置、i18n | 8 个工具在模型侧描述清晰；未配置凭据时给出"去设置哪个凭据"的指引 |

顺序说明：**云盘排第一**。它不需要任何凭据、不依赖外部 CLI、接口最薄，还能顺带把 `download.ts`（并发、断点、落盘、进度）一次做扎实——这是另外两个能力共用的地基。学堂和教材依赖真实账号与外部二进制，放后面，免得一开始就卡在登录上。

## 7. 风险与未决问题

1. **fingerPrint 的获取**是全项目最大不确定性。若无法稳定取得，学堂能力退化为"用户手动粘贴 cookie + 只读列目录"，需在 M2 前先做一次可行性验证。
2. 教参平台的接口与 Cookie 校验已变更，旧仓库对不上——M3 前先手跑一次 `downloader.py` 确认现状。
3. 云盘共享链接无官方稳定性承诺；接口变更时工具应整体降级为"仅提示用户手动下载"而不是静默失败。
4. 落盘位置：首版固定写到会话工作区下的 `thu-downloads/`，Config 可覆盖；不写用户家目录。
5. 教参 downloader 是 GPL-3.0 且维护者明说「在招人」——若其 CLI 参数变更，只能跟随，不能 fork 进本仓库。
6. **client 半边是全项目第二处不确定性**：产物必须是懒加载 CJS 工厂格式（`window.__ModuleLoader__.load`），仓库里的 `clientBundle` tsdown preset 不在发布包里，包外要自己复刻。M4 开工前先拿 token-watch 的 `tsdown.config.ts` 做一次空白面板冒烟，确认格式对得上再写业务组件。
7. `settings.section` 座位的可用性依赖客户端版本；若某个 DSH 版本不给这个座位，退路是 `settings.general.item`（设置「通用」页里一行）或 `plugins.detail.section`（插件详情页里一块区域）。

## 8. 立即可执行的第一步

```sh
cd /Users/Admin/dsh/deepseek-harness/dsh-thu-plugin
pnpm init                     # 或手写 package.json
# 加 dsh.bundle、engines.dsh、license: MIT、cordis.patch.yml，然后：
dsh plugin --profile thu add .
dsh --profile thu --dump-config
```

注意：本目录在当前 harness 仓库里是**未跟踪的新目录**，不在 pnpm workspace 的 `packages/*/*` 匹配范围内，因此不会被链接进 workspace——这对独立开发是好事，代价是构建产物与依赖都要在本目录内自洽。用 `.git/info/exclude` 挡住误提交。

## 9. 决策记录

已定。后续若推翻，在此追加新行而不是改写旧行。

| 决策 | 结论 | 理由 |
| --- | --- | --- |
| 目录位置 | **留在 `/Users/Admin/dsh/deepseek-harness/dsh-thu-plugin/`，不迁入 `local-plugins/`** | 用户决定。本插件面向最终分发（学生自行安装），不是本地实验品；`local-plugins/` 是仓库内的开发便利位，混进去反而模糊了它的发布定位 |
| 骨架形态 | **对齐 `local-plugins/tsinghua-token-watch`，但只出 host face** | 那套是本仓库唯一验证过的本地插件装载路径（`package.json` + `cordis.patch.yml` + `dev.overlay.yml` + `tsdown.config.ts` + `checks/`）。本插件无界面，故删掉 `dsh.client` 声明、tsdown client face、`src/client/`、`checks/client-smoke.ts` |
| GPA | **不做** | 用户决定。连带排除 `@thu-info/lib` 的 BSL-1.1 依赖 |
| 构建顺序 | **云盘先于学堂** | GPA 移除后，云盘是唯一无需凭据、无需外部 CLI 的能力；其下载引擎是另两个能力的地基 |
| 首版工具 | **8 个，不含作业与通知** | 用户要求开工且不把读取类作业/通知放进首版。此前把这 8 个误写成 9；契约里没有第 9 个，不另造。名单：`thu_status`、`thu_learn_semesters`、`thu_learn_courses`、`thu_learn_files`、`thu_learn_download`、`thu_reserves_download`、`thu_cloud_list`、`thu_cloud_download` |
| 误提交 | **父仓库 `.git/info/exclude` 增加 `dsh-thu-plugin/`** | 目录留在仓库根且不进 pnpm workspace；exclude 只挡本机误 `git add`，不改共享 `.gitignore` |
| UI 档位 | **轻 UI：一个下载面板 + 凭据状态读数** | 用户要求。不造凭据表单（用 `request_secret`），不做任务队列管理（暂停/重试/排序） |
| 按钮机制 | **自建 `shell.overlay` 面板 + `connection.fetch` 路由，点击直接起下载** | `presentationMeta` 的结果卡是核心封闭 union，包外插件加不了 card kind；按钮若只给模型发一句话就退化成了提示词 |
| 不用 `action-cards` | **排除** | 动词按 kind 全局定义，表达不了"每行一个按钮"；且属 experimental 包，release 插件不得在 `dependencies` 里点名 |
| 工具注册位置 | **全部 8 个工具都写在 `src/index.ts`，能力模块保持纯函数** | 契约集中在一处，便于对着 `TOOLS.md` 逐个核对；`cloud.ts` / `download.ts` 不依赖 `Context`，可被 `checks/` 直接驱动 |
| 两个 tsconfig | **`tsconfig.json` 给 `tsc`（指向 `lib/types/*.d.ts`），`tsconfig.check.json` 给 `tsx`（指向 `lib/index.js`）** | harness 的声明产物内部用 `./events.ts` 这类 .ts 后缀引用，运行时不可加载。tsx 从包目录跑会命中 `paths` 而拿到 `.d.ts`，报 `ERR_MODULE_NOT_FOUND`。分成两份比让 tsc 去检查 harness 源码更干净 |
| 云客户端 origin 覆盖 | **`CloudRequestOptions.origin` 只给检查用，生产调用不传** | 否则云盘只能靠真实共享链接验证，回归测试无法离线跑 |
| 落盘布局 | **`<downloadDir>/<shareKey>/<共享内相对路径>`** | 共享内路径即天然去重键；按 share key 分目录避免两个共享链接里同名文件互撞 |
| 学堂 cookie 不进库 | **密码登录走 `thu-learn-lib`；`THU_LEARN_COOKIE` 单独打学生 JSON** | 库的 cookie 罐在 `makeFetch()` 闭包里，没有 `setCookie` 导出。两条路径的文件字节都进 `writeBody`，不另写落盘 |
| 学堂会话标记 | **`learn.session` 只反映本进程是否成功 `openLearnSession`** | 库不导出可持久化的会话。进程重启后回到 false，直到下一次成功登录 |
| 教参参数是 `url` + `quality`，不是章节 | 实现时核对上游 CLI | 它只支持整本下载（无章节参数），章节选择留给用户裁 PDF |
| 教参 CLI 默认装到 `~/.dsh/dsh-thu-plugin/reserves/downloader` | 让设置页安装按钮开箱即用 | `reservesCli` 为空时 `reservesCliPath()` 回落到该路径，status / 安装 / 工具三处共用同一函数 |
| 教参 token 由设置页写入并本地预检 `exp` | 避开 CLI 的 selenium + `input()` 分支 | 提前 60 秒判过期；token 只写进临时运行目录的 `token.txt`（0600），不落工作区 |
| 面板下的是工具，不是文件 | **推翻上面「资源列表每行一个下载按钮」** | 用户明确：文件、教材、云盘内容通过会话工具下载即可。面板按钮下载的是几个外部工具本身（GPL 教参 CLI 等不能打进包的），不是课程文件 |
| 学堂四项凭据可在面板里写 | **推翻上面「不造凭据表单」** | 用户明确要在面板里设置 `THU_USERNAME`、`THU_PASSWORD`、`THU_LEARN_FINGERPRINT`、`THU_LEARN_COOKIE`。读只用 `describe`（`configured` / `writable`），写走 `set` / `unset`。响应不回显明文。空值不能 `set`，清除用 `unset`。`THU_RESERVES_TOKEN` 不进这个表单 |
| 面板位置改为设置页 | **推翻上面「自建 `shell.overlay` 面板」** | 用户明确：浮标压在会话右下方挡输入区，按钮应进设置菜单。座位改为 `settings.section`，id `thu`，order 40，导航名「清华工具」；`shell.overlay` 的 `thu-tools-panel` 撤掉。安装与凭据本来就是配置动作，设置面板自带导航和内容列，不必另造浮层 |
| 账号与 `dsh-thu-automad` 共用一对引用 | 默认 `usernameRef` / `passwordRef` = `MADMODEL_USERNAME` / `MADMODEL_PASSWORD`；**不改 thu-automad** | 用户要求两个插件共用一套账号配置。改 thu-automad 会作废本机已存的 `MADMODEL_*`，而它不在 web profile 的 bundles 里、也没有装 `node_modules`，改了无法跑它的 check。改本插件默认值即可：一次输入、两个插件读到同一份。引用名留成配置项，谁想分开也支持 |
| 设备指纹存在 `thu-automad/session` 记录里共用 | 优先级：`THU_LEARN_FINGERPRINT` > 共享记录 > 首次登录生成并写回记录 | 指纹是本地随机 32 hex 设备 id，不是学校下发的账号数据，可跨工具复用；学校只信任见过的指纹，换新指纹会被当成新设备。`ctx.credentials.modifyRecord` 保证读改写的串行化，写入时保留 payload 里的续期历史字段。指纹本身不是口令，但也不回显 |
| 设置页控件用 `ui-primitives`，布局对齐 `dsh-thu-automad` | `Button` / `Input` + 状态卡 + 分组卡 + 徽章 | 两个插件现在写同一套账号，页面长得不一样会让人以为是两套配置。手写按钮还踩过 token 不存在导致按钮变实心块的坑 |
| 客户端入口不得 require 宿主模块 | **`src/routes.ts` 抽出零 import 的路径常量，加 `check:client` 校验产物** | 曾出现 Web 启动页「Failed to load plugins」：浏览器模块表只认平台单例，client 入口一旦（直接或间接）引入宿主模块（`dsh-credentials`、`node:` 内置）就会在浏览器里加载失败。`checks/client-bundle.ts` 读 `lib/client.js`，把每个字面量 `require` 与平台单例白名单 + `dsh.client.inject` 比对，并断言座位是 `settings.section`、`id` 等于包名 |
| 学堂下载必须带 `THU_LEARN_COOKIE` | 密码登录只用于列学期/课程/文件；下载走 `fetchWithCSRF` + 保存的 cookie，非 cookie 会话不写盘直接 `login-required` | 已真机验证：`thu-learn-lib` 4.x 的 `#fetchWithToken` 是私有字段、cookie jar 在 `makeFetch()` 闭包里，库外拿不到会话；`downloadUrl` 也不带 token，未登录请求被 302 到 `login_timeout` 并返回 **HTTP 200 的 HTML**（写盘就成了 HTML 冒充的 mp4）。`guardFileResponse` 按 `content-type` 拦掉它 |
| 首次登录由插件串行化 | `helperSession` 里 `ensureSignIn()` 只 `helper.login()` 一次，四个方法都先 await 它 | 库的懒登录不 memoise：`semesters()` 里 `Promise.all([getSemesterIdList, getCurrentSemester])` 会并发登录两次，抢 roaming ticket，报 `could not fetch ticket from id.tsinghua.edu.cn`。失败后清空，下一次调用可重试 |
| 下载复用库自己登录出来的会话 cookie | **登录期间包住 `globalThis.fetch` 抓 learn 域 `Set-Cookie`，`finally` 还原**（`captureLearnCookies`） | 库把 jar 关在 `makeFetch()` 闭包里且不导出，但它的 `fetchCookie` 每次都用**全局** `fetch` 并从响应头读 `Set-Cookie`。只旁听、不拦截，只在登录窗口内生效，别人改过 `fetch` 就不动它。这样密码 + 指纹就能下载，`THU_LEARN_COOKIE` 退化成显式覆盖 |
| 文件名补 `fileType` 后缀 | `fileRow` 里 `withExtension(title, fileType)` | 学校把名字和信息分两段给，`title` 通常无后缀（「第三章 线性方程组的直接法」），原样落盘后系统打不开 |
| 面板用第二个按钮装 `dsh-thu-automad` | 重跑 CLI：`plugin --profile <p> add https://github.com/aaabrli/dsh-thu-automad.git`，不手改 profile 的 `package.json` | `dsh plugin` 本来就转发给 pnpm，并在 add/remove 后自己对账 `dsh.profile.bundles`（`packages/boot/plugin-manager/src/operations.ts:94-119`）。面板复制这份逻辑会漂移，尤其"装了依赖但没进 bundles 就不加载"这种坑 |
| 用哪条 CLI 由运行时决定，不写死 | `process.execPath` + `process.execArgv` + `process.argv[1]`（basename 匹配 `bin`/`dsh`），取不到才退回 PATH 的 `dsh` | 源码 checkout 是 `node --import tsx/esm apps/cli/src/bin.ts`，安装版是 `lib/bin.js`，`pnpm dsh` 只是根 `package.json` 的脚本别名——三者都把 CLI 跑在**同一进程**里（`runProfile` 不 spawn），所以本进程的 argv 就是启动方式本身。子进程 cwd 保持宿主的（`--import tsx/esm` 与相对入口要靠它解析），profile 用 `--profile` 显式传 |
| profile 名先看 argv 再扫清单 | `--profile`、`--profile=`、或 `~/.dsh/profiles/<arg>` 存在的位置参数；都取不到则扫 `profiles/*/package.json` 里依赖含 `dsh-thu-plugin` 的那个 | 本插件能跑就说明它被装进了某个 profile，清单是可验证的兜底；`dsh web` 的位置参数会被启动器改写成 `--profile web`，两种写法都要认 |
