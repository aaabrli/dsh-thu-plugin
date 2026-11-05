# 工具契约

本文定义插件对模型暴露的每个工具：参数、返回、失败方式、所需凭据。实现按此表落地，改表即改契约。

共 10 个工具，不含作业与通知。`thu_learn_homework` / `thu_learn_notices` 不在本表，也不注册。论文获取的 2 个见「论文获取」一节；批量与任务队列（`thu_paper_batch` / `thu_paper_job`）在 M7，落地时补进本文。

通用约定：

- 所有工具名以 `thu_` 开头，snake_case。
- 所有工具**不接受**密码、token、cookie 作为参数；凭据由 `ctx.credentials.resolve()` 在 `execute` 内部取得。
- 所有下载类工具把文件写到 `<工作区>/thu-downloads/<域>/<文件名>`，返回相对路径、字节数与耗时；不覆盖已存在文件，重名自动加 `-1`。
- 所有工具遵守 `exec.signal`；取消时清理半成品文件。
- 缺少凭据属于**领域结果**而非异常：返回 `{ ok: false, reason: 'missing-credential', credential: 'THU_LEARN_COOKIE' }`，让模型能直接告诉用户去配哪个凭据。
- 网络/子进程故障抛异常，由工具错误路径处理。

## 凭据清单

| 凭据引用 | 用途 | 由谁写入 |
| --- | --- | --- |
| `MADMODEL_USERNAME`（可由 `usernameRef` 改名） | 学号，与 `dsh-thu-automad` **共用同一个引用** | 设置页「校园账号」或 `request_secret` 卡片填写 |
| `MADMODEL_PASSWORD`（可由 `passwordRef` 改名） | 统一身份认证密码，与 `dsh-thu-automad` 共用 | 同上 |
| `THU_LEARN_FINGERPRINT` | 设备指纹**覆盖**（一般不用填） | 未配置时读 `thu-automad/session` 记录里的指纹；都没有则首次登录时生成并写回该记录 |
| `THU_LEARN_COOKIE` | 学堂 cookie：覆盖自动登录（验证码/二次认证时用），正常情况不需要 | 用户从浏览器复制 |
| `THU_RESERVES_TOKEN` | 教参平台 token（JWT，约 1 小时有效） | 设置页粘贴（`localStorage.License`），或 `reservesTokenFile` 指向的 `token.txt` |
| `THU_PAPER_EMAIL`（可由 `paperEmailRef` 改名） | Unpaywall 要求的真实邮箱。不是口令，但也不回显 | 设置页「论文获取」或 `request_secret` 卡片填写 |

云盘共享链接不进凭据表：它以 `url` 参数逐次传入，本身自带访问权，没有「存起来」的必要。

## 状态

### `thu_status`

- 参数：无。
- 返回：`{ learn: { credential: boolean, session: boolean }, reserves: { cli: boolean, token: boolean }, papers: { cli?: string, email: boolean, school?: string } }`。`papers.cli` 是解析出来的可执行文件路径，找不到时整个键不出现；`papers.school` 读的是 instsci 自己的配置，没写学校时同样不出现。
- 说明：云盘不需要登录态，没有可报告的状态，故不出现；GPA 已移出本插件范围。`papers.school` 是 `~/.instsci/config.json` 里当前的学校名（人读字段，不含任何 key），`null` 表示还没配。
- 失败：不抛异常，任何一项不可用都如实置 `false`。
- 用途：模型在开工前先自检，避免连续失败调用。
- 凭据：无（只读 `describe`，不 resolve 明文）。

## 网络学堂

### `thu_learn_semesters`

- 参数：无。
- 返回：`{ semesters: Array<{ id: string, name: string, current: boolean }> }`
- 失败：未登录时返回 `missing-credential` 领域结果。
- 凭据：`MADMODEL_USERNAME` + `MADMODEL_PASSWORD` + 设备指纹（`THU_LEARN_FINGERPRINT` 覆盖 > `thu-automad/session` 共享记录 > 首次登录生成），或 `THU_LEARN_COOKIE`。

### `thu_learn_courses`

- 参数：`semesterId`（string，可选；缺省取当前学期）。
- 返回：`{ semesterId, courses: Array<{ id, name, teacher, time, location }> }`
- 凭据：同学期接口。

### `thu_learn_files`

- 参数：`courseId`（string，必填）、`category`（string，可选，对应库的分类过滤）。
- 返回：`{ courseId, files: Array<{ id, name, size, uploadedAt, downloadUrl, hasPreview }> }`
- 说明：`downloadUrl` 一定返回给模型可见，便于用户在对话里直接复制；真正落盘走 `thu_learn_download`。
- 凭据：同上学堂。

### `thu_learn_download`

- 参数：`courseId`（必填）、`fileIds`（string[]，必填）、`overwrite`（boolean，可选，默认 false）。
- 返回：`{ downloaded: Array<{ name, path, bytes }>, failed: Array<{ name, reason }> }`
- 失败：部分失败不抛异常，逐项写进 `failed`，每项 `reason` 以领域原因开头（`login-required: …`、`session-expired: …`）。
- 凭据：`MADMODEL_USERNAME` + `MADMODEL_PASSWORD` + 设备指纹即可，**不需要用户提供 cookie**。库的 jar 关在 `makeFetch()` 闭包里，但那个闭包每次请求都调用**全局** `fetch` 再从响应头读 `Set-Cookie`——所以插件在登录时短暂包住 `globalThis.fetch`（`captureLearnCookies`，`finally` 里还原，只记录 learn 域的 `name=value`），拿这份会话 cookie 去取 `downloadUrl`。`THU_LEARN_COOKIE` 是显式覆盖（验证码、二次认证挡住密码登录时用），填了就优先。
- 文件名：学校给的是 `title` + `fileType` 两段，`title` 多半没后缀，落盘时补上 `.pdf` / `.mp4`。
- 兜底：cookie 会话失效时学校对下载返回 **HTTP 200 的 HTML 登录页**，`guardFileResponse` 按 `content-type` 拦下来给 `login-required`，绝不把 HTML 写进交付文件。

## 教参教材

### `thu_reserves_download`

- 参数：`url`（string，必填，`https://ereserves.lib.tsinghua.edu.cn/bookDetail/<id>`）、`quality`（integer，可选，1–96，96 表示不压缩；缺省交给 CLI）。
- 返回：`{ ok: true, bookId, book, path, bytes, pages, durationMs }`。`path` 是本地绝对路径，落在 `<downloadDir>/reserves/<bookId>.pdf`；重名依次加 `-1`…`-99`。
- **没有 `chapters` 参数**：上游 CLI 只支持整本下载，章节选择留给用户自己裁 PDF。
- 失败：一律领域结果 `{ ok: false, reason, message, log? }`，不抛异常。`reason` 取值：`invalid-url` / `cli-missing` / `token-missing` / `token-invalid` / `token-expired` / `rate-limited` / `login-required` / `exit-nonzero` / `timeout` / `cancelled` / `no-output`。`log` 是 stdout/stderr 尾部（上限 64,000 字符）。
- 凭据：`THU_RESERVES_TOKEN`，或配置 `reservesTokenFile` 指向的 `token.txt`。插件先本地解 JWT 的 `exp`（提前 60 秒），缺失/非 JWT/过期分别返回 `token-missing` / `token-invalid` / `token-expired`——**不会**触发 CLI 自带的浏览器登录分支（它删 `token.txt`、起 selenium、`input()` 等人，工具调用会挂死）。
- 子进程细节：运行目录是临时目录，插件把 token 写成 0600 的 `token.txt` 放在那里，结束后整个目录删掉（token 不落工作区）。`stdin` 设 `'ignore'`。
- 限速：固定 `-c 1`（串行），请求间隔 `max(1_000, reservesDelayMs) / 1000` 秒。作者说明请求过快会封号，这是硬约束。
- 超时：`reservesTimeoutMs`（默认 30 分钟），超时 SIGTERM，5 秒后 SIGKILL。
- 运行参数：`-u <url> -e -i <间隔> -c 1 --no-img`，`quality` 存在时再加 `-q <n>`。

## 云盘

### `thu_cloud_list`

- 参数：`url`（string，必填，`https://cloud.tsinghua.edu.cn/d/...` 或裸 share key）、`path`（string，可选，默认 `/`）。
- 返回：`{ shareKey, path, entries: Array<{ name, path, type: 'file'|'dir', size }> }`
- 失败：非共享链接、加密链接、404 各自返回不同 `reason`，不抛异常——这些都是用户输入层面的事。`reason` 取值：`invalid-url` / `not-found` / `locked` / `network` / `timeout` / `http-error`。只接受 `cloud.tsinghua.edu.cn` 的 `/d/<key>` 公开共享链接。

### `thu_cloud_download`

- 参数：`url`（必填）、`path`（可选，目录或单个文件）、`pattern`（可选）、`concurrency`（integer，可选，默认取配置）。
- `path` 指向目录时递归；指向文件时直接下这一个（dirents 接口对文件路径返回 404，据此回退）。
- 落盘：`<downloadDir>/<shareKey>/<共享内相对路径>`，保留目录结构。
- `pattern` 语义（与上游脚本的注释不同，`-f` 其实是 glob 不是正则）：逗号分隔；含 `*` / `?` 按 glob 匹配；不含通配符则按**后缀或全名**忽略大小写匹配（`.pdf` 能匹配 `a.PDF`）。
- 返回：`{ ok, directory, downloaded: Array<{ name, path, bytes }>, failed: Array<{ name, reason }>, totalBytes }`（`path` 是**本地绝对路径**）
- 失败：单项失败不影响其余项；全部失败抛异常。空匹配返回 `reason: 'empty-directory'`。
- 凭据：无（共享链接自带访问权）。

## 论文获取

能力来自外部 Python CLI [`instsci`](https://github.com/Rimagination/instsci)（MIT，尚未发到 PyPI）：插件只装它、调它、搬它的产物，不重写抓取逻辑。这里两个工具的分工是刻意的——检索走插件自己打的公开接口，获取走子进程。

### `thu_paper_search`

- 参数：`query`（string，必填）、`limit`（integer，可选，默认 10；超出 1–100 会自动夹回，不报错）、`year`（string，可选，Semantic Scholar 的年份写法，如 `2023` 或 `2020-2024`）。
- 返回：`{ ok: true, total, results: Array<{ title, authors: string[], year?, venue?, doi?, arxivId?, citations, url, abstract? }> }`；`abstract` 截断到 800 字符，`doi` 与 `arxivId` 没有时整个键不出现（工具输出的 JSON Schema 只声明 `string`，返回 `null` 会被拒绝），拿到后直接喂给 `thu_paper_fetch` 的 `identifier`。
- 实现：插件直接请求 `https://api.semanticscholar.org/graph/v1/paper/search`（字段 `title,authors,year,venue,externalIds,citationCount,abstract,url`），不经过 CLI。理由：`instsci search` 只打 Rich 表格、没有 JSON 开关，正确解析一张会折行的表格比调这个公开接口更脆。
- 失败：`{ ok: false, reason: 'rate-limited', message, retryAfterSec? }`（HTTP 429，`retryAfterSec` 取自 `Retry-After`）与 `{ ok: false, reason: 'bad-request', message }`（其余 4xx）是领域结果，失败时也带 `results: []`（schema 要求这个键）；网络错误与 5xx 抛异常。超时用 `timeoutMs`。
- 凭据：无。没有 API key 时 Semantic Scholar 按 IP 限流，`rate-limited` 就是它的正常长相。

### `thu_paper_fetch`

- 参数：`identifier`（string，必填，DOI、arXiv id 或文章 URL）、`overwrite`（boolean，可选，默认 false）。
- 返回（拿到 PDF）：`{ ok: true, identifier, doi?, arxivId?, title, status, quality, source, path, bytes, durationMs }`。`path` 是绝对路径：默认落在 `<工作目录>/<downloadDir>/papers/<安全化 DOI 或 arXiv id>.pdf`，`paperDir` 非空时改落它（相对路径从工作区算，绝对路径与 `~/…` 按原样）（`/` 以外的非 `\w-.` 字符换成 `_`，两者都没有时叫 `paper.pdf`）；`status` / `quality` / `source` 是上游自己的分类（`success` / `pdf_only` / `open_access` 等，原样透传）。
- 返回（没拿到）：`{ ok: false, reason, message, log? }`。`message` 是人话，模型可直接转述；`log` 是 stdout/stderr 尾部（采集上限 64,000 字符，返回时截到 2,000）。上游报告里的 `status`、`reason`、`next_action.message` 在 `no-pdf` 时拼进 `message`。
- arXiv 直取：`identifier` 能被 `arxivOf` 认出（裸 `2401.01234`、`arXiv:2401.01234v2`、`https://arxiv.org/abs/…`、`https://arxiv.org/pdf/…`）时**不起 CLI**，直接 `GET https://arxiv.org/pdf/<id>`（版本后缀去掉），字节过同一套校验，落同一个目录，返回 `{ ok: true, arxivId, title: 'arXiv <id>', status: 'success', quality: 'pdf_only', source: 'arxiv' }`——`pdf_only` 表示没有正文抽取，`doi` 键不出现。这条路不需要 CLI、不需要邮箱、不需要机构登录；HTTP 非 2xx 报 `exit-nonzero`，网络错报 `no-pdf`，字节不合格报 `invalid-pdf`，单次请求上限 2 分钟。
- `reason` 取值：`cli-missing` / `missing-credential` / `timeout` / `cancelled` / `exit-nonzero` / `unparseable-output` / `no-pdf` / `invalid-pdf`。`invalid-pdf` 的 `message` 里带实际字节数与问题码（`empty` / `html_response` / `too_small` / `missing_pdf_header` / `corrupt_pdf_header` / `early_eof_with_trailing_payload`）。
- 凭据：`THU_PAPER_EMAIL`。上游 `fetch` 在邮箱为空时会 `typer.prompt` 等人输入——子进程必须 `stdin: 'ignore'`，所以插件在调用前把邮箱同步进 `~/.instsci/config.json`（缺失或不一致才写），拿不到凭据就直接返回 `missing-credential`，绝不让上游落到那条交互分支。首轮日志里出现 `enter your email` 时同样映射成 `missing-credential`。
- 机构：`~/.instsci/config.json` 有四个名字位，语义不同——`school` 用来查校园网关表（清华是 `webvpn.tsinghua.edu.cn`，这一列存的是中文名，填英文会 `ValueError`，闭源路线直接退化成 `config_needed`），`institution_name_zh` / `institution_name_en` / `carsi_idp_name` 是出版社登录页与 CARSI 名单要匹配的名字（英文）。插件在对应键为空时分别补 `paperSchool`（默认 `清华大学`）与 `paperSchoolEn`（默认 `Tsinghua University`），合并已有键、权限 `0600`；任何已有值都不覆盖，`thu_status` 的 `papers.school` 把当前值报出来让人自己判断。
- 子进程细节：`fetch <identifier> --format json --output <临时目录>`；`COLUMNS` 设成很大的数（Rich 会把 `console.print` 的 JSON 按终端宽度折行，折过的 JSON 不是合法 JSON），`NO_COLOR=1`，`stdin: 'ignore'`。上游在 JSON 之后还会打 `PDF saved to:` 与 `Source:` 两行，所以解析只在「第一个以 `{` 开头的行」到「最后一个以 `}` 结尾的行」之间做，失败再退到括号配对扫描（字符串内的括号不算）。
- 产物搬运：不直接写工作区。PDF 路径取 JSON 里的 `paper.pdf_path`（开放获取落在 `--output` 临时目录，浏览器路线落在上游 `cache_dir/browser_pdf/<doi>/`），先在原处按上面的规则验字节，合格才搬进 `<downloadDir>/papers/`（`rename`，跨盘时退 `copyFile`）——这样上游 `_save_pdf` 的 `write_bytes` 覆盖不到已有文件，重名照常加 `-1`，不合格的文件也从没进过工作区。临时目录结束后删掉。
- 字节校验：`%PDF-` 开头、大于 5000 字节、前 64 字节不含 U+FFFD、`%%EOF` 若存在须落在末尾 8192 字节内；另外先排除以 `<!doctype html` / `<html` / `<head` / `<body` 开头的登录页。
- 可见浏览器：上游第 6 步会用 CloakBrowser 打开**本机的可见窗口**，最长等 900 秒让人完成统一身份认证。所以这个工具可能十几分钟不返回，`paperTimeoutMs` 默认 20 分钟；同一时刻只跑一个 `thu_paper_fetch`（`execute` 内的 promise 队列串行），两个窗口抢同一个 browser profile 会互相踩 cookie。
- 超时/取消：到点 SIGTERM，5 秒后 SIGKILL；`exec.signal` 取消同理，返回 `cancelled`。已经搬进工作区的文件不回滚；重试会先命中上游缓存（full text ≥ 1000 字符才算命中），通常几秒就返回。
- 界面：工具结果只出文本摘要，不放按钮。

## 界面与按钮

面板按钮下载的是**外部工具本身**，不是课程文件、教材或云盘内容。那些走会话里的 `thu_learn_download` / `thu_reserves_download` / `thu_cloud_download`。

界面位置是**设置面板里的一页**（`settings.section`，id `thu`，order 40，导航名「清华工具」），不是浮在会话上的浮标或抽屉——安装与凭据都是配置动作，不该占输入区。

按钮：

| 按钮 | 下载什么 | 为什么不打进包 |
| --- | --- | --- |
| 教参下载器 | `libthu/reserves-lib-tsinghua-downloader` 的 CLI，装到本机，供 `thu_reserves_download` 子进程调用 | GPL-3.0，不能 import、不能放进 npm 包 |
| 学堂库 | 不提供下载按钮。`thu-learn-lib` 已是 MIT 依赖 | — |
| 论文获取 CLI | `instsci`（`git+https://github.com/Rimagination/instsci.git`），用 `uv tool install` 或 `pipx install` 装到 `~/.local/bin/instsci`，供 `thu_paper_fetch` 子进程调用 | Python 项目，带 `cloakbrowser`（浏览器内核，首次按需下载数百 MB）与 `pymupdf` 等重依赖，不能打进 npm 包；上游未发布到 PyPI，只能从 git 装 |

云盘脚本无许可证，且 Seafile 客户端已自己实现，不提供下载按钮。

论文获取 CLI 的按钮是一键装全链，复用同一套安装任务机制（15 分钟超时、日志截断到 64,000 字符、当前步骤随任务回报给面板）。点击后先探测 `uv` / `pipx`（`~/.local/bin`、`~/.cargo/bin`、PATH）：有就按 `uv tool install --force git+…` 或 `pipx install --force git+…` 装（`--force` 是为了让已装过 CLI 的机器也能按 3.13 重装一遍，否则只会得到 already installed）；都没有就下载官方 uv（`https://github.com/astral-sh/uv/releases/latest/download/uv-<target>.tar.gz`），解包后把二进制放进 `~/.local/bin/uv`，再用它装 CLI。安装固定在 Python 3.13（`--python 3.13`）：上游浏览器路线只支持 3.10–3.13，3.14 上 Playwright 的 sync API 会误判事件循环，CloakBrowser 起不来，闭源路线一律 `auth_required`；uv 会自己下这个解释器，pipx 则需要本机已有 3.13。不退回 `pip install`（会污染用户的系统 Python），也不 `curl | sh`（装了什么、跑了哪段脚本要能说清）。uv 下载失败（网络受限）时任务走进 failed 并带上原因。装完 `thu_status` 的 `papers.cli` 变绿，但第一次真去取闭源论文时上游还会自己下浏览器内核，这一步不归按钮管。

按钮不经过模型：点击直接 `POST /api/thu/install` 把 CLI 装到本机。安装目标由 `reservesCliPath(options)` 决定：`reservesCli` 配了就用它，没配就落到 `~/.dsh/dsh-thu-plugin/reserves/downloader`——所以不必先改配置才能点按钮。工具的 `render` 只出文本摘要，不承载按钮。

不能靠 `output.presentationMeta` 加自定义卡片：核心的 result view 是封闭 union（`card: 'read' | 'search' | 'web' | …`），包外插件新增 card kind 要改核心。

除教参 CLI 外，面板还能装 `dsh-thu-automad`（`https://github.com/aaabrli/dsh-thu-automad.git`）。它不手改 profile 清单，而是重跑 CLI 的 `plugin --profile <p> add <spec>`——CLI 自己负责写依赖、对账 `dsh.profile.bundles`。用哪条 CLI 由运行时决定：优先复现启动本进程的那条命令（`process.execPath` + `process.execArgv` + `process.argv[1]`，覆盖 `pnpm dsh` 与全局 `dsh` 两种形态），取不到才退回 PATH 里的 `dsh`。profile 名先看 argv（`--profile`、`--profile=`、或 `~/.dsh/profiles/<arg>` 存在的位置参数），再扫 `~/.dsh/profiles/*/package.json` 里列了 `dsh-thu-plugin` 的那个。安装超时 15 分钟，输出截断到 64,000 字符；失败时把尾部 4,000 字符（含 pnpm 的 `allowBuilds` 提示）放进 `log`，装好会带 `restartRequired: true`。

面板路由契约：

| 路由 | 方法 | 请求 | 返回 |
| --- | --- | --- | --- |
| `/api/thu/panel` | `GET` | — | `{ tools: [reserves \| automad \| papers 条目], fields: Array<{ id, configured, writable, secret }> }`，不含明文 |
| `/api/thu/install` | `POST` | `{ tool: 'reserves' \| 'automad' \| 'papers' }` | `{ taskId }`，失败时 `{ reason }`（reserves 解包依赖本机 `unzip`；papers 没有 `uv` / `pipx` 时会先下 uv，网络受限导致下不来时任务以 failed 结束并带原因） |
| `/api/thu/install` | `GET` | `?taskId=` | `{ state, error?, log?, restartRequired? }` |
| `/api/thu/credentials` | `POST` | `{ id, value }` | `{ ok }`；`value` 为空即清除（走 `unset`） |