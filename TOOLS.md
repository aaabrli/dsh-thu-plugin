# 工具契约

本文定义插件对模型暴露的每个工具：参数、返回、失败方式、所需凭据。实现按此表落地，改表即改契约。

首版 8 个工具，不含作业与通知。`thu_learn_homework` / `thu_learn_notices` 不在本表，也不注册。

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

云盘共享链接不进凭据表：它以 `url` 参数逐次传入，本身自带访问权，没有「存起来」的必要。

## 状态

### `thu_status`

- 参数：无。
- 返回：`{ learn: { credential: boolean, session: boolean }, reserves: { cli: boolean, token: boolean } }`
- 说明：云盘不需要登录态，没有可报告的状态，故不出现；GPA 已移出本插件范围。
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

## 界面与按钮

面板按钮下载的是**外部工具本身**，不是课程文件、教材或云盘内容。那些走会话里的 `thu_learn_download` / `thu_reserves_download` / `thu_cloud_download`。

界面位置是**设置面板里的一页**（`settings.section`，id `thu`，order 40，导航名「清华工具」），不是浮在会话上的浮标或抽屉——安装与凭据都是配置动作，不该占输入区。

首版按钮：

| 按钮 | 下载什么 | 为什么不打进包 |
| --- | --- | --- |
| 教参下载器 | `libthu/reserves-lib-tsinghua-downloader` 的 CLI，装到本机，供 `thu_reserves_download` 子进程调用 | GPL-3.0，不能 import、不能放进 npm 包 |
| 学堂库 | 不提供下载按钮。`thu-learn-lib` 已是 MIT 依赖 | — |

云盘脚本无许可证，且 Seafile 客户端已自己实现，不提供下载按钮。

按钮不经过模型：点击直接 `POST /api/thu/install` 把 CLI 装到本机。安装目标由 `reservesCliPath(options)` 决定：`reservesCli` 配了就用它，没配就落到 `~/.dsh/dsh-thu-plugin/reserves/downloader`——所以不必先改配置才能点按钮。工具的 `render` 只出文本摘要，不承载按钮。

不能靠 `output.presentationMeta` 加自定义卡片：核心的 result view 是封闭 union（`card: 'read' | 'search' | 'web' | …`），包外插件新增 card kind 要改核心。

除教参 CLI 外，面板还能装 `dsh-thu-automad`（`https://github.com/aaabrli/dsh-thu-automad.git`）。它不手改 profile 清单，而是重跑 CLI 的 `plugin --profile <p> add <spec>`——CLI 自己负责写依赖、对账 `dsh.profile.bundles`。用哪条 CLI 由运行时决定：优先复现启动本进程的那条命令（`process.execPath` + `process.execArgv` + `process.argv[1]`，覆盖 `pnpm dsh` 与全局 `dsh` 两种形态），取不到才退回 PATH 里的 `dsh`。profile 名先看 argv（`--profile`、`--profile=`、或 `~/.dsh/profiles/<arg>` 存在的位置参数），再扫 `~/.dsh/profiles/*/package.json` 里列了 `dsh-thu-plugin` 的那个。安装超时 15 分钟，输出截断到 64,000 字符；失败时把尾部 4,000 字符（含 pnpm 的 `allowBuilds` 提示）放进 `log`，装好会带 `restartRequired: true`。

面板路由契约：

| 路由 | 方法 | 请求 | 返回 |
| --- | --- | --- | --- |
| `/api/thu/panel` | `GET` | — | `{ tools: [reserves | automad 条目], fields: Array<{ id, configured, writable, secret }> }`，不含明文 |
| `/api/thu/install` | `POST` | `{ tool: 'reserves' \| 'automad' }` | `{ taskId }`，失败时 `{ reason }`（reserves 解包依赖本机 `unzip`） |
| `/api/thu/install` | `GET` | `?taskId=` | `{ state, error?, log?, restartRequired? }` |
| `/api/thu/credentials` | `POST` | `{ id, value }` | `{ ok }`；`value` 为空即清除（走 `unset`） |