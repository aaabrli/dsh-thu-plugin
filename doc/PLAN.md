# dsh-thu-plugin 开发计划

面向清华学生的 DSH 插件：把 thu.services 上已有的工具接进 DSH。文件和教材在会话里下载；面板上的按钮只负责把那几个外部工具装到本机。

本文是项目主计划。工具契约见 [TOOLS.md](TOOLS.md)，调研依据见用户提供的四功能调研（thu-learn-lib / @thu-info/lib / reserves-lib downloader / THU-Cloud-Downloader）与论文获取的参考实现 [`Rimagination/instsci`](https://github.com/Rimagination/instsci)。

## 1. 目标与非目标

目标：装进 DSH 后，用一句话完成四件事——下载网络学堂文件、下载教参教材、批量下载清华云盘共享链接、取回论文 PDF（开放获取优先，闭源走机构权限）。面板不列这些文件；它只提供几个外部工具的「下载 / 安装」按钮。

非目标：

- 不做 GPA / 成绩单计算。**已明确排除**，随之也排除 `@thu-info/lib` 这个 BSL-1.1 依赖，整条成绩链不在本插件范围内。
- 不重写任何爬虫，不实现清华统一身份认证，不做浏览器自动化登录，不分发第三方工具源码。论文获取同样守这条：闭源论文要的那一下登录发生在**上游 CLI 自己的可见浏览器窗口**里，插件只起进程、等结果、搬产物，绝不去点那个窗口。

一句话定位：**这是一个适配层**——把已有工具的能力翻译成 DSH 的 `defineTool` 工具；文件、教材、云盘内容都在会话里下载。轻量面板上的按钮下载的是那几个外部工具本身（装到本机），不是课程文件。凭据与落盘由 DSH 自己管。

## 2. 硬边界（先定，后面所有设计服从它）

| 约束 | 来源 | 落地做法 |
| --- | --- | --- |
| 不代填密码、不绕过二次验证 | 清华 SSO 有 2FA | 登录要么复用浏览器已有会话，要么由用户在凭据卡里粘贴 cookie/指纹；插件只读凭据，不回显、不落明文日志 |
| 教参下载器 GPL-3.0 | libthu/reserves-lib-tsinghua-downloader | 只以**子进程**调用其 CLI，绝不 import 源码、不打包进 npm 包、不放 `vendor/` |
| 云盘脚本无许可证 | chenyifanthu/THU-Cloud-Downloader | 只参考其调用的 Seafile 公开接口，自己写无交互客户端 |
| 模型不可见明文凭据 | DSH 凭据约定 | 全部走 `ctx.credentials.resolve()`；工具参数里不出现 password/token 字段 |
| 论文获取依赖可见浏览器 | `instsci` 的机构权限路线（CloakBrowser） | 只以子进程调用，插件不驱动浏览器、不代填 SSO；窗口在本机弹出，人要在场，超时按「最长 900 秒登录」定 |
| `instsci` 是 Python 项目且未上 PyPI | 上游 README 的安装段 | 只装到本机（`uv tool` / `pipx`）再由子进程调用，不进 npm 包的 `dependencies`、不 vendor 源码 |

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
├── papers/
│   ├── search.ts         # Semantic Scholar 检索（公开接口，无 key）
│   └── fetch.ts          # instsci 子进程、JSON 提取、PDF 字节校验、搬进工作区
└── test/                 # 纯函数单测（链接解析、path 拼接、glob 匹配、PDF 字节校验）
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
| 论文获取 CLI（M6） | `instsci` 的 git 源，用 `uv tool install` 或 `pipx install` 装到 `~/.local/bin/instsci`，供 `thu_paper_fetch` 子进程调用；两个安装器都没有时先下载官方 uv（一键安装） | Python 项目 + `cloakbrowser`/`pymupdf` 重依赖，且上游未发 PyPI，进不了 npm 包 |

云盘脚本（`chenyifanthu/THU-Cloud-Downloader`）**没有按钮**：无许可证，且 Seafile 客户端已经自己写了，不需要把那个脚本装下来。

按钮语义：点击 = 直接 `POST /api/thu/install` 把该工具装到本机，**不经过模型**，也不下载任何课程文件。装完后 `thu_status` 的对应项变绿。如果按钮只是生成一句"请帮我安装 X"，那 UI 退化成提示词按钮，不如不做。

面板与 host 的通道：

| 路由 | 方法 | 用途 |
| --- | --- | --- |
| `/api/thu/panel` | `GET` | 各外部工具是否已安装、缺哪一项 |
| `/api/thu/install` | `POST` | body `{ tool: 'reserves' \| 'automad' \| 'papers' }`，开始安装，返回 `{ taskId }` |
| `/api/thu/install` | `GET` | `?taskId=`，返回 `{ state, error? }` |

安装进度只留在内存。面板不提供文件下载任务。

UI 的代价（写在这里以免以后当成意外）：加界面意味着要维护 client 构建 face、懒加载 CJS 工厂格式、locale 字典、样式与主题变量、以及"改了 UI 必须重新 build + 刷新浏览器"这条开发纪律。

### 5.5 论文获取（子进程 + 自写检索 + arXiv 直取）

调研对象是 [`Rimagination/instsci`](https://github.com/Rimagination/instsci)（MIT，Python ≥3.10）：开放获取优先（Unpaywall → arXiv → OpenAIRE），订阅论文再走 Elsevier API、DOI 解析、出版社 PDF 构造、CARSI 联邦、CloakBrowser 可见浏览器与 WebVPN 校门网关，覆盖 ACM / ACS / AIP / IEEE / IOP / Nature / Oxford / RSC / ScienceDirect / Springer / Wiley。这套东西已经写了 4,000 行 `publisher_batch.py` 与 1,000 行 `fetcher.py`，重写等于抄一份更旧的代码，所以只做三件事：装它、调它、搬它的产物。

工具分两个，因为两件事的失败方式完全不同。`thu_paper_search` 直接打 Semantic Scholar 的 `graph/v1/paper/search`：只用标题找 DOI 的场景不需要机构权限，也不需要起进程；上游的 `search` 只打 Rich 表格、没有 JSON 开关，解析折行表格比调公开接口更脆。`thu_paper_fetch` 是对 `instsci fetch <id> --format json` 的子进程封装，参数与返回见 [TOOLS.md](TOOLS.md#论文获取)。唯一的例外是 arXiv：上游只解析 DOI 与 URL，裸 id 与 abs 链接都拿不到 PDF（后者还会被拐进 WebVPN），而 arXiv 的 PDF 对所有人开放，所以这一条由插件自己发 HTTP——决策与边界见 [§9](#9-决策记录)。

实现要点（每条都是踩过或读出来的边界）：

- **邮箱是硬前置**。上游 `fetch` 开头调 `_ensure_email()`，邮箱为空就 `typer.prompt` 等人输入。子进程必须 `stdin: 'ignore'`，插件在起进程前把凭据里的邮箱同步进 `~/.instsci/config.json`（缺失或不一致才写），拿不到就 `missing-credential` 返回，绝不让它掉进交互分支。这跟教参 CLI 的 `input()` 是同一类坑。
- **学校名写四个键，两种语义**。`school` 查的是校园网关表（清华 `webvpn.tsinghua.edu.cn`，表按中文名索引，填英文 `get_school` 会 `ValueError` → 闭源路线变 `config_needed`）；`institution_name_zh` / `institution_name_en` / `carsi_idp_name` 是出版社登录页与 CARSI 名单匹配用的名字，要英文。所以默认值拆成 `paperSchool: 清华大学` 与 `paperSchoolEn: Tsinghua University` 两项，各自只在对应键为空时写入，已有值一律不覆盖。
- **arXiv 直取只此一类**。`arxivOf` 认出裸 id、`arXiv:` 前缀、abs/pdf 链接（版本后缀去掉）就 `GET https://arxiv.org/pdf/<id>`：单次请求上限 2 分钟、失败重试一次、错误里带 socket 原因，字节过同一套校验，落同一个 `papers/` 目录，返回 `quality: 'pdf_only'` / `source: 'arxiv'`。不起子进程、不需要邮箱与机构权限。不做通用抓取，不碰出版社流程。
- **目录可配，默认留在工作区**。`paperDir` 空则 `<downloadDir>/papers`；非空时相对路径从对话的工作区算，绝对路径与 `~/…` 照写。`paperDirectory()` 一处实现，直取与 CLI 两条路共用，避免一条落新目录、一条落旧目录。
- **安装钉 Python 3.13**。上游 `instsci.auth` 在 Python 3.14 上直接抛「Python 3.14 is not yet supported for browser workflows: Playwright's Sync API mis-detects an asyncio loop on 3.14+」，闭源路线一律 `auth_required`——真机第一轮就撞上了。所以 `uv tool install --python 3.13`，uv 会下匹配的解释器；pipx 兜底时同样传 `--python 3.13`，并且两个安装器都带 `--force`——已装过 `instsci` 的机器不加这个开关只会得到「already installed」，固定版本永远生效不了。
- **安装按钮自举 uv**。本机没有 `uv` / `pipx` 时，同一个任务先下 `uv-<target>.tar.gz`、解包、把二进制放进 `~/.local/bin/uv`，再用它装 CLI。不走 `curl | sh`：装了什么、落在哪要能逐条说清；也不退回 `pip install`，那会装进一个插件无法确认的解释器。
- **子进程要指走浏览器缓存**。CLI 在 `import` 阶段就 `mkdir` 自己的浏览器缓存目录，只读安装会连开放获取一起失败。插件把 `CLOAKBROWSER_CACHE_DIR` 指到 `~/.instsci/browsers`，既绕开 site-packages 的写权限，也让内核落在一个说得通的地方。
- **JSON 从 Rich 里捞**。上游用 `console.print` 打 JSON：不设宽就会按 80 列折行（折过的 JSON 不合法），`[tag]` 还会被当 markup 吞掉。插件设 `COLUMNS` 为大数、`NO_COLOR=1`，然后只取「首个 `{` 行」到「末个 `}` 行」之间的内容，再退到括号配对扫描。折行与 markup 的残余风险只落在标题/正文里的方括号上，PDF 与路径不受影响。
- **产物先落临时目录**。`--output` 指向临时目录，真正的落盘从 JSON 的 `paper.pdf_path` 复制到 `<downloadDir>/papers/`：上游 `_save_pdf` 直接 `write_bytes`，先写工作区就会覆盖同名文件，也套不上「重名加 `-1`」的统一契约。浏览器路线的 PDF 本来就在上游 cache 目录里，这一条顺带把它捞回来。
- **字节校验自己再做一遍**。`%PDF-` 开头、> 5000 字节、前 64 字节无 U+FFFD、`%%EOF` 若存在须在末尾 8192 字节内。不合格不写进工作区，这正是学堂下载那条「HTTP 200 的 HTML 登录页」教训的翻版。
- **可见浏览器意味着长任务**。`fetch` 第 6 步会开 CloakBrowser 窗口，最长等 900 秒让人做 SSO；所以 `paperTimeoutMs` 默认 20 分钟，且进程内串行——两个窗口抢同一个 browser profile 会互相踩 cookie。取消走 `exec.signal`，SIGTERM 后 5 秒 SIGKILL。
- **超时后重试先命中缓存**。上游只在 full text ≥ 1000 字符时才写缓存，命中就秒回；这条比「重试再开一次浏览器」重要得多，不要传 `--no-cache`。

M7 的批量与任务队列留了明确的路：`instsci papers` 支持 `--detach` 提交 job，`instsci jobs list|status|tail|cancel --json` 全是机器可读的，所以那两个工具会是「提交 + 轮询」，而不是再包一个 20 分钟的长调用。到那时才需要在 TOOLS.md 里补契约。

## 6. 里程碑与验收

| 里程碑 | 内容 | 验收标准 |
| --- | --- | --- |
| M0 骨架 ✅ | 包结构、`cordis.patch.yml`、空 `apply`、`Config` schema | `dsh --profile thu --dump-config` 能看到本插件的层；插件加载无报错 |
| M1 云盘 ✅ | Seafile 客户端 + 列目录 + 下载 | 已实现 `thu_cloud_list` / `thu_cloud_download`；离线用 loopback 假 Seafile 覆盖列目录、递归、落盘、筛选、404、超时。**待办**：拿一个真实共享链接跑一次 |
| M2 学堂 ✅（离线） | thu-learn-lib 接入 + 列学期/课程/文件 + 下载 | 已注册四个 `thu_learn_*`。密码登录走库；cookie 不能灌进库的闭包，故单独打学生 JSON。落盘共用 `writeBody`。缺凭据返回 `missing-credential`。**待办**：用户用真实指纹或 cookie 列出本学期并下载一个文件 |
| M3 教材 ✅（离线） | 子进程封装 + token 预检 + 落盘 | `pnpm run check` 用假 CLI 覆盖 6 条失败路径与成功落盘；token 缺失/过期不触发浏览器登录分支。**待办**：真实 token + 真实书目跑一次 |
| M4 轻 UI ✅（离线） | client face、设置页一节（`settings.section`，id `thu`）、安装路由、教参 CLI 下载按钮、学堂四项凭据写入 | `pnpm run check` 全绿；client 产物是 `window.__ModuleLoader__.load` 工厂。面板读凭据只用 `describe`，写走 `set` / `unset`，响应不回显明文。面板上不出现课程文件或教材。`check:client` 校验产物的 `require` 只落在平台单例白名单内。**待办**：重启 `dsh web` 后在设置里打开「清华工具」，点安装按钮、保存一项凭据 |
| M5 打磨 | 错误文案、README、示例配置、i18n | 8 个工具在模型侧描述清晰；未配置凭据时给出"去设置哪个凭据"的指引 |
| M6 论文获取 ✅ | `instsci` 子进程封装、Semantic Scholar 检索、PDF 字节校验与搬运、`thu_status` 的 `papers` 段、设置页第三个安装按钮与 `THU_PAPER_EMAIL` | 已实现 `thu_paper_search` / `thu_paper_fetch`。`pnpm run check` 用假 CLI（校验 `COLUMNS`/`NO_COLOR`、打印多行 JSON 与尾随行）覆盖：成功落盘并校验字节、`missing-credential`、`cli-missing`、超时、取消、`invalid-pdf`（过小/HTML）、`early_eof_with_trailing_payload`、`unparseable-output`、`exit-nonzero`、`no-pdf`、重名加 `-1`、`overwrite`、学校不被覆盖、config 落 0600；检索用 loopback 覆盖 200/429/400。**已实测（2026-11-05，本机 macOS）**：开放获取成功（`10.1371/journal.pmed.0020124` → 255,629 字节，2.2 秒，Unpaywall 给了 `url_for_pdf`）；arXiv 改走新增直取路径；闭源仍待在本机可见窗口里完成一次 SSO。实测同时修掉两处适配问题：Python 3.14 会让上游拒启浏览器（安装已 pin `--python 3.13`）、CLI 导入期会往 site-packages 写浏览器缓存（子进程设 `CLOAKBROWSER_CACHE_DIR`） |
| M7 批量与任务队列（规划） | `thu_paper_batch` 用 `instsci papers --detach` 提交 DOI 清单，`thu_paper_job` 用 `instsci jobs status` / `jobs tail` / `jobs cancel` 的 `--json` 轮询 | 提交立即返回 job id；轮询能看到逐条进度；取消能停掉浏览器进程 |

顺序说明：**云盘排第一**。它不需要任何凭据、不依赖外部 CLI、接口最薄，还能顺带把 `download.ts`（并发、断点、落盘、进度）一次做扎实——这是另外两个能力共用的地基。学堂和教材依赖真实账号与外部二进制，放后面，免得一开始就卡在登录上。

## 7. 风险与未决问题

1. **fingerPrint 的获取**是全项目最大不确定性。若无法稳定取得，学堂能力退化为"用户手动粘贴 cookie + 只读列目录"，需在 M2 前先做一次可行性验证。
2. 教参平台的接口与 Cookie 校验已变更，旧仓库对不上——M3 前先手跑一次 `downloader.py` 确认现状。
3. 云盘共享链接无官方稳定性承诺；接口变更时工具应整体降级为"仅提示用户手动下载"而不是静默失败。
4. 落盘位置：首版固定写到会话工作区下的 `thu-downloads/`，Config 可覆盖；不写用户家目录。
5. 教参 downloader 是 GPL-3.0 且维护者明说「在招人」——若其 CLI 参数变更，只能跟随，不能 fork 进本仓库。
6. **client 半边是全项目第二处不确定性**：产物必须是懒加载 CJS 工厂格式（`window.__ModuleLoader__.load`），仓库里的 `clientBundle` tsdown preset 不在发布包里，包外要自己复刻。M4 开工前先拿 token-watch 的 `tsdown.config.ts` 做一次空白面板冒烟，确认格式对得上再写业务组件。
7. `settings.section` 座位的可用性依赖客户端版本；若某个 DSH 版本不给这个座位，退路是 `settings.general.item`（设置「通用」页里一行）或 `plugins.detail.section`（插件详情页里一块区域）。
8. **单篇闭源获取要人站在机器旁**。`instsci` 没有关掉浏览器分支的开关，`fetch` 第 6 步一定开可见窗口、最长等 900 秒。DSH Web 若跑在远端或容器里，窗口弹不出来，论文能力退化成「只做开放获取」；这条要在 M6 真机验收时先确认，别等用户报「卡住了」。
9. `instsci fetch` 的 JSON 走 Rich 的 `console.print`：不设 `COLUMNS` 会按 80 列折行、`[tag]` 会被当 markup 吞掉。`COLUMNS` 能治折行，markup 治不了——残余风险只落在标题/摘要里的方括号，PDF 与路径不受影响；若哪天发现标题被吃，退路是改读上游 cache 里的 JSON。
10. Semantic Scholar 无 key 时按 IP 限流，429 是常态。首版不引入 key，靠 `rate-limited` 的领域结果让模型改口；退路是换 Crossref（`api.crossref.org/works`，同样无 key），M6 不做。
11. 上游未发 PyPI，安装只能从 git；`cloakbrowser` 首次运行还要下浏览器内核（数百 MB），第一次闭源获取会长时间卡在「装浏览器」。面板按钮不覆盖这一步，README 里写清楚，免得被当成失败。一键安装还会访问 `github.com/astral-sh/uv/releases`；网络受限时 uv 下不来，任务失败并给出原因（此前那种「同步拒绝、让你自己去装」的行为已去掉）。
12. 论文 PDF 的版权与访问授权由用户自己负责。插件只按机构权限取回用户本就有权访问的内容，不提供绕过付费墙的手段——这条是产品底线，不写进任何「自动下载全网论文」的表述。

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
| 论文获取走外部 CLI，不自研抓取 | 只在单篇获取处包 `instsci fetch --format json`，不 import 它的 Python、不 vendor | 上游已经把 OA 路线、Elsevier API、CARSI/WebVPN、12 家出版社的可见浏览器流程写完并还在维护；重写的版本只会更旧更薄。它没上 PyPI，所以按「装到本机、子进程调用」走，跟教参 CLI 同一档 |
| arXiv 论文由插件直接取，不经 CLI | `arxivOf(identifier)` 命中就 `GET https://arxiv.org/pdf/<id>`，过同一套字节校验、落同一个目录，返回 `quality: 'pdf_only'` / `source: 'arxiv'` | 这是对「不自研抓取」的**一处**例外：arXiv 的 PDF 对所有人开放，不需要机构权限；而上游 `_parse_doi` 只认 DOI、`_parse_url` 只认 URL，裸 id 直接 `Could not determine URL`，arXiv abs 链接会拐进 WebVPN 变成 `auth_required`，`10.48550/arXiv.*` 又不在 Unpaywall 里——三个入口都拿不到，而用户要的论文大半在 arXiv。例外只限这一类：不做通用抓取，不碰出版社流程 |
| 论文检索自己打接口，不走 CLI | `thu_paper_search` 直接请求 Semantic Scholar 的 `graph/v1/paper/search` | 上游 `search` 只打 Rich 表格、没有任何 JSON 开关，正确解析一张会折行的表格比调这个公开只读接口更脆；检索也不需要机构权限，没有理由为它起一个 Python 进程 |
| 论文获取拆成两个工具 | 检索与单篇获取分开，不合成一个 `thu_paper` | 两件事的失败方式完全不同：检索只会 429 或网络错，获取会缺凭据、超时、弹浏览器、拿到 HTML 冒充的 PDF。合成一个工具就没法分别表达「换个关键词」和「去点浏览器」 |
| 邮箱存成凭据 `THU_PAPER_EMAIL` | 默认引用名可被 `paperEmailRef` 改；在起进程前同步进 `~/.instsci/config.json` | Unpaywall 要真实可收信地址，空着上游就 `typer.prompt` 挂住子进程。设置页只能写凭据，config 文件放的是全局默认值、不该放个人信息；它不是口令，但同样不回显 |
| 学校只在缺失时补，不覆盖 | `paperSchool` 默认 `清华大学`；`instsci` 配置里已有 `school` 就照它的 | 用户可能在本机用 `instsci` 连别的机构，覆盖等于替用户改另一个工具的行为。`thu_status` 把当前 school 报出来，让模型自己判断要不要提醒 |
| 学校名拆成中英两项配置 | `paperSchool`（`school` / `institution_name_zh`）、`paperSchoolEn`（`institution_name_en` / `carsi_idp_name`） | 一个字段表达不了两种语义：网关表按中文名索引（填英文直接 `ValueError`），而 CARSI 与出版社登录页按英文名匹配。写四个键、各管一处，两边的默认值都能开箱即用 |
| uv 自举下载发布包，不 `curl \| sh` | `GET uv-<target>.tar.gz` → `tar -xzf` → 只执行自己写下的 `~/.local/bin/uv` | 官方安装脚本也是取同一个包；直接取包能说清装了什么、落在哪，也不必在子进程里跑远程脚本。失败原因（HTTP 码、tar 退出码、缺文件）都写进任务日志 |
| 单篇获取串行，超时 20 分钟 | `execute` 里 promise 队列；`paperTimeoutMs` 默认 1_200_000 | 可见浏览器共用同一个 browser profile，两个进程并发会抢 cookie 与 SSO 回调。上游 PDF 等待 90 秒、登录等待 900 秒，超时短于这个数就等于把闭源论文直接判死 |
| 产物先落临时目录再搬 | `--output` 指临时目录，按 JSON 的 `paper.pdf_path` 复制进 `<downloadDir>/papers/` | 上游 `_save_pdf` 直接 `write_bytes`，先写工作区会静默覆盖同名文件，也套不上插件统一的「不覆盖、重名加 `-1`」契约；顺带把浏览器路线落在 cache 目录里的 PDF 捞出来 |
| 论文目录可配，默认留在工作区 | `paperDir` 默认空 → `<downloadDir>/papers`；非空时相对路径从工作区算，绝对路径与 `~/…` 照写 | 默认必须落在对话的工作区里，否则用户找不到刚下的 PDF；但确实有人把文献放在 `~/Papers` 或外置盘，所以留一个显式出口。不把三种写法塞进 `downloadDir`，那个键被教参与图书共用、且已限定为工作区相对路径 |
| 空值用「键不出现」，不用 `null` | `PaperHit` / `PaperSuccess` / `ThuStatus.papers` 的可空字段都是 `?:`，取值处条件展开 | 工具 `output.schema` 是手写的 JSON Schema，只写了 `type: 'string'`；返回 `null` 会被 schema 拒绝，而「没有这个键」天然是 `undefined`。面板路由不受此限，仍用 `null` |
| `freePath` 上移到 `download.ts` | 教参与论文共用同一套「重名加 `-1`」 | 两处各写一份会漂移；`download.ts` 本来就是落盘公共层，`reserves.ts` 改为 import |
| 测试靠注入的 seam，不靠环境变量 | `fetchPaper(..., seams: { cli, configPath, env })`；`searchPapers(..., { origin })` | 上游 `config.py` 的 `DEFAULT_BASE_DIR` 是硬编码常量、没有 env 覆盖，检查进程也不可能真的往用户家目录写；seam 只给 `checks/` 用，工具调用永远走默认值 |
| `status.papers.cli` 报路径而不是布尔 | `findPaperCli` 的结果直接给模型，缺失时键不出现 | 模型需要知道「有没有装」，运维需要知道「装的是哪一个」——两种情况同一字段即可，不必再加一个 `path` |
| 论文加入后工具总数是 10 | 8 + `thu_paper_search` + `thu_paper_fetch`；批量与任务留 M7 | 上面「首版工具 8 个」仍是当时的事实，不改写；这里追加新数，免得后来的人拿旧行当现在的契约 |
