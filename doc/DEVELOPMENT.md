# 实现与运维笔记

面向改这个插件的人：目录与边界、面板设计、真机验证记录、踩过的坑。只想把插件用起来的看 [README.md](../README.md)。

## 概览

清华学生资源获取的 DSH 插件。把 thu.services 上已有的工具接成会话里的 DSH 工具。面板上的按钮只负责把不能打进包的外部 CLI 装到本机，不下载课程文件。

范围：网络学堂文件下载、教参教材下载、清华云盘共享链接批量下载、论文 PDF 获取（开放获取优先，闭源走机构权限）。

- [PLAN.md](PLAN.md) — 目标、硬边界、目录结构、UI 设计、里程碑、风险、决策记录。
- [TOOLS.md](TOOLS.md) — 每个工具的契约：参数、返回、失败方式、所需凭据；面板路由契约。
- [CHANGELOG.md](CHANGELOG.md) — 版本变更。

位置：仓库根的 `dsh-thu-plugin/`，**不迁入 `local-plugins/`**（已定，见 [PLAN.md §9](PLAN.md#9-决策记录)）。

当前状态：M0–M4 完成（学堂与教参已真机验证；教参仍缺真实 token + 真实书目手测）；M6 论文获取完成并已真机取到 PDF——开放获取一篇（255,629 字节）与 arXiv 一篇（2,215,244 字节）都在 2 秒内落地，闭源路线待在本机可见窗口里完成一次统一身份认证。已注册十个工具：`thu_status`、`thu_learn_semesters` / `thu_learn_courses` / `thu_learn_files` / `thu_learn_download`、`thu_reserves_download`、`thu_paper_search` / `thu_paper_fetch`、`thu_cloud_list` / `thu_cloud_download`。契约见 [TOOLS.md](TOOLS.md)，实现要点见 [PLAN.md §5.5](PLAN.md#55-论文获取子进程加一个自写检索)。


版本：`package.json` 的 `version` 与 git tag 同步，当前 **0.2.2**（tag `v0.2.2`），变更见 [CHANGELOG.md](CHANGELOG.md)。依赖不锁 dsh 版本：四个 `@deepseek-ai/*` peer 都写 `*`，理由见 [PLAN.md §9](PLAN.md#9-决策记录)。本目录是**独立仓库**，父仓库的 `.git/info/exclude` 里有一行 `dsh-thu-plugin/` 把它挡在 `git add` 之外，两边互不干扰。发版：改 `version` → 更新 `doc/CHANGELOG.md` → `git commit` → `git tag -a vX.Y.Z` → `npm publish`（`scripts.prepack` 先构建，包里含 `lib/`；`lib/` 本身不进仓库）。
界面是**设置面板里的一页**（`settings.section`，id `thu`，导航名「清华工具」）：教参 CLI 安装按钮，加上六项凭据的写入（`MADMODEL_USERNAME`、`MADMODEL_PASSWORD`、`THU_LEARN_FINGERPRINT`、`THU_LEARN_COOKIE`、`THU_RESERVES_TOKEN`、`THU_PAPER_EMAIL`）。学号与密码和 `dsh-thu-automad` **共用同一对引用**，设备指纹也共用（存在 `thu-automad/session` 记录里，两个插件向学校呈现同一台设备）。凭据只显示「已设置 / 未设置」，从不回显明文；留空保存即清除。教参 CLI 不需要先改配置，按钮默认装到 `~/.dsh/dsh-thu-plugin/reserves/downloader`（本机需要 `unzip`）。同一页还有第二个按钮：安装 [`dsh-thu-automad`](https://github.com/aaabrli/dsh-thu-automad)。它重跑当前安装形态的 CLI（`plugin --profile <p> add <spec>`），由 CLI 自己写依赖并对账 `dsh.profile.bundles`；装完需重启 `dsh web`，失败时面板会显示安装日志（git 源若被 pnpm 的 `allowBuilds` 拦住，日志里写着要加的键）。

同一页的第三个按钮是一键安装：先看本机有没有 `uv`（`~/.local/bin`、`~/.cargo/bin`、PATH）或 `pipx`，都没有就从 GitHub Releases 取官方 uv 放进 `~/.local/bin/uv`，再用它把 `instsci` 从 git 装到 `~/.local/bin/instsci`——与工具解析 `paperCli` 的顺序对得上，安装过程中面板会显示当前这一步。安装固定在 Python 3.13 上（uv 会自己下这个解释器）：上游的浏览器路线只支持 3.10–3.13，而本机默认的 3.14 会让 Playwright 误判事件循环、CloakBrowser 直接起不来，闭源路线全部退化成 `auth_required`。首次真去取一篇闭源论文时，上游还会自己下浏览器内核（数百 MB），那一步也在这个按钮之外、按需发生。

真实账号已跑通（2026-2027 秋季学期 7 门课、数值分析A 22 个文件）：`MADMODEL_*` + 共享指纹能登录、能列、能看，**也能下载**——插件在登录那一刻包住全局 `fetch`，把库自己写进内存 jar 的 learn 域 `Set-Cookie` 顺手记下来，再用它去取 `downloadUrl`（实测落到 `%PDF-` 文件，不需要用户提供 cookie）。`THU_LEARN_COOKIE` 只在验证码/二次认证挡住密码登录时才需要，填了就优先用。`checks/learn-live.ts` 是真机探针（不进 `check`）：`THU_TRY_DOWNLOAD=1` 会下载最小的那个文件并打印 magic。

教参 token 怎么拿：浏览器登录 <https://ereserves.lib.tsinghua.edu.cn>，控制台执行 `localStorage.License`，把值粘进设置页的 `THU_RESERVES_TOKEN`。它是 JWT，约 1 小时过期；插件会先本地看 `exp`，过期直接提示重填，不会去起浏览器的登录流程。

论文获取（M6）：单篇获取是对本机 [`instsci`](https://github.com/Rimagination/instsci)（MIT，尚未发到 PyPI）的子进程调用。开放获取（Unpaywall / arXiv / OpenAIRE）走 HTTP 直接拿 PDF；闭源论文由它在**本机弹一个可见浏览器窗口**，最长等 900 秒让人完成统一身份认证，所以这个工具会长时间不返回，`paperTimeoutMs` 默认 20 分钟。插件不驱动浏览器、不代填密码：SSO 永远由人在那个窗口里点，插件只等结果。arXiv 论文不走 CLI 也不走机构网关——上游只解析 DOI 与 URL，裸 arXiv id 拿不到、arXiv 链接会被拐进 WebVPN，所以这是唯一一处插件自己发 HTTP 的地方：认出 arXiv id 就 `GET https://arxiv.org/pdf/<id>`，同样验字节、同样落 `papers/`，返回 `quality: pdf_only`、`source: arxiv`。检索（`thu_paper_search`）不走 CLI，直接打 Semantic Scholar 的公开接口——上游的 `search` 只有 Rich 表格、没有 JSON 开关；好处是装 CLI 之前搜索就能用。PDF 默认落 `thu-downloads/papers/<安全化 DOI 或 arXiv id>.pdf`（`paperDir` 可改），落盘前按上游同样的规则验字节（`%PDF-` 开头、大于 5000 字节、前 64 字节没有 U+FFFD、`%%EOF` 若存在须在末尾 8192 字节内），不合格的文件不写进工作区。邮箱进凭据 `THU_PAPER_EMAIL`（Unpaywall 要求真实地址），插件在调用前把它同步进 `~/.instsci/config.json`。

配置项（`cordis.patch.yml` 里有默认值）：`downloadDir`（默认 `thu-downloads`，相对注入的工作目录）、`concurrency`（默认 2）、`timeoutMs`（默认 90 秒）、`reservesDelayMs`（默认 1500，下限 1000）、`reservesTimeoutMs`（默认 30 分钟）、`reservesCli`（空则用上面的默认安装路径）、`reservesTokenFile`（可选，覆盖凭据的 `token.txt` 路径）、`usernameRef` / `passwordRef`（默认 `MADMODEL_USERNAME` / `MADMODEL_PASSWORD`，即与 `dsh-thu-automad` 共用的那对引用）。论文获取另有六项，已进 `cordis.patch.yml`：`paperDir`（默认空，即 `<downloadDir>/papers`；写相对路径从对话的工作区算，写绝对路径或 `~/…` 就按原样落）、`paperCli`（空则先找 `~/.local/bin/instsci`，再找 PATH）、`paperSchool`（默认 `清华大学`，校园网关表按中文名查）、`paperSchoolEn`（默认 `Tsinghua University`，出版社登录页与 CARSI 名单按英文名匹配）、`paperEmailRef`（默认 `THU_PAPER_EMAIL`）、`paperTimeoutMs`（默认 20 分钟）。两个学校名都只在 instsci 配置里缺这个键时才写入。

真实教参 token、真实共享链接、真实论文（一篇开放获取 + 一篇闭源）仍待手测。剩余 M5：错误文案、示例配置、i18n 补齐；M6 待真机手测（见上）；之后是 M7 批量队列。

开发命令（在本目录内）：

```
pnpm run setup:dev   # 把 harness 的包链进 node_modules（一次性）
pnpm run check       # typecheck + build + host-smoke + client-bundle
```


一句话边界：插件是适配层，不重写爬虫、不代填密码、不分发 GPL 依赖的源码。论文获取也守这条：调本机 CLI、等它的可见浏览器窗口，插件自己不去点那个窗口。不含 GPA 计算（已移出范围）。