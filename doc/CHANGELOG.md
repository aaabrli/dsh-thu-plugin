# 变更记录

版本号以 `package.json` 为准，与 git tag 同步（约定见 [README.md](../README.md)）。每个版本只写用户能感到的变化与必须知道的边界。

## 0.2.2 — 2026-11-05

只有包元数据变了，代码与 0.2.1 相同。

- `peerDependencies` 里四个 `@deepseek-ai/*` 全部改成 `*`，不再锁 dsh 版本。原来写 `^0.2.2-alpha.2`：dsh 的兼容性门会把每个 `@deepseek-ai/dsh-*` peer 的范围拿去比运行时版本，dsh 一升版（0.2.x → 0.3.x）就判定不兼容，插件的整层会被跳过。

## 0.2.1 — 2026-11-05

只有文档变了，代码与 0.2.0 相同。

- README 的安装命令改成能直接复制的写法：原来写 `<profile 名>`，粘进 shell 会被当成输入重定向，第二行的 `add …` 也只是一句注释。
- README 补上源码仓库地址。

## 0.2.0 — 2026-11-05

论文获取（M6）。工具从八个变成十个。

- `thu_paper_search`：直接请求 Semantic Scholar 的 `graph/v1/paper/search`，不经过 CLI，装 CLI 之前就能用。无 key 时对方按 IP 限流，429 报 `rate-limited`。
- `thu_paper_fetch`：包本机 `instsci` CLI（`fetch --format json`），读完它打印的那一份 JSON、按上游同样的规则验字节，再把 PDF 搬进 `<downloadDir>/papers/`。闭源论文由上游在本机弹一个可见浏览器窗口，插件不代填密码。
- arXiv 直取：`identifier` 认出 arXiv id（裸 id、`arXiv:` 前缀、abs/pdf 链接）时不由 CLI 出场，直接 `GET https://arxiv.org/pdf/<id>`——上游只解析 DOI 与 URL，裸 id 拿不到、链接会被拐进 WebVPN，而 arXiv 的 PDF 对所有人开放。返回 `quality: pdf_only`、`source: arxiv`。网络层失败重试一次，错误里带 socket 原因（如 `ECONNRESET`）。
- 设置页第三个按钮：一键安装。先探 `uv` 与 `pipx`（含 `~/.local/bin`、`~/.cargo/bin`），都没有就取官方 uv 发布包放进 `~/.local/bin`，再 `uv tool install --force --python 3.13 git+https://github.com/Rimagination/instsci.git`。面板显示当前步骤，失败带原因。不 `curl | sh`、不退回 `pip install`。
- 新增配置：`paperDir`（空则 `<downloadDir>/papers`；相对路径从工作区算，绝对路径与 `~/…` 照写）、`paperCli`、`paperSchool`（默认 `清华大学`）、`paperSchoolEn`（默认 `Tsinghua University`）、`paperEmailRef`（默认 `THU_PAPER_EMAIL`）、`paperTimeoutMs`（默认 20 分钟）。
- 新增凭据 `THU_PAPER_EMAIL`：Unpaywall 要真实地址，插件在起进程前同步进 `~/.instsci/config.json`（缺失或不一致才写，0600），并顺带补上四个机构名字位。
- 上游适配（都是实测踩出来的）：装固定在 Python 3.13（3.14 起不了浏览器，闭源路线会全部退化成 `auth_required`）；子进程设 `CLOAKBROWSER_CACHE_DIR`（CLI 导入期会往 site-packages 写浏览器缓存）；安装加 `--force`，否则已装过的机器点按钮只会报「already installed」，固定版本永远生效不了。
- `freePath` 从 `reserves.ts` 上移到 `download.ts`，教参与论文共用同一套「重名加 `-1`」。

## 0.1.0 — 2026-11-05

首个版本：网络学堂文件、教参教材、清华云盘共享链接三组工具，加上设置页（六项凭据）与教参 CLI、`dsh-thu-automad` 两个安装按钮。
