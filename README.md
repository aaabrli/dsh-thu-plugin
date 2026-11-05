# 清华工具

在 DSH 里用中文说一句话，就能下课件、下教材、搜论文、下论文。

这个插件把清华学生常用的几个资源入口接进对话：网络学堂、教参教材、清华云盘共享链接、学术论文 PDF。你不用记命令，直接说「把数值分析A 的课件都下了」「找几篇 KV cache 压缩的论文」「帮我把这篇的 PDF 取下来」。

当前版本 **0.2.0**（变更见 [doc/CHANGELOG.md](doc/CHANGELOG.md)）。

## 能做什么

| 你想做的事 | 你可以这样说 | 背后 |
| --- | --- | --- |
| 看这学期有哪些课 | 「我这学期有哪些课？」 | `thu_learn_semesters` |
| 看某门课有哪些文件 | 「数值分析A 都有什么文件？」 | `thu_learn_courses` / `thu_learn_files` |
| 下课件 | 「把数值分析A 的课件都下下来」 | `thu_learn_download` |
| 下教参教材 | 「下载高等数学的教材」 | `thu_reserves_download` |
| 搜论文 | 「找几篇 KV cache 压缩的论文」 | `thu_paper_search` |
| 下论文 PDF | 「把这篇的 PDF 取下来」 | `thu_paper_fetch` |
| 云盘共享链接 | 「把这个共享链接里的文件全下了」 | `thu_cloud_list` / `thu_cloud_download` |
| 看配置齐不齐 | 「清华工具现在能用吗？」 | `thu_status` |

一共十个工具，逐个契约见 [doc/TOOLS.md](doc/TOOLS.md)。

## 安装

发在 npm 上，装进 profile 再重启 `dsh web`：

```bash
dsh plugin --profile <profile 名> add dsh-thu-plugin
# 想钉住版本：add dsh-thu-plugin@0.2.0
```

装好并重启后，设置页里会多出一页「清华工具」。

改代码而不是只用插件的话，见 [doc/DEVELOPMENT.md](doc/DEVELOPMENT.md)：仓库只存源码，`lib/` 是构建产物（`prepack` 在打包时自动构建），而构建要链到 DSH 工作副本里的内部包，所以开发得在那份工作副本里做。

## 第一次用：填三样东西

打开 **设置 → 清华工具**，凭据只显示「已设置 / 未设置」，不会回显明文，留空保存即清除。

| 要填的 | 干什么用 | 去哪拿 |
| --- | --- | --- |
| 学号 + 密码 | 登录网络学堂 | 就是你的校园账号；与 `dsh-thu-automad` 共用同一对引用，填一次两边都能用 |
| 教参 token | 下教参教材 | 浏览器登录 <https://ereserves.lib.tsinghua.edu.cn>，控制台执行 `localStorage.License`，把值粘进来（JWT，约 1 小时过期，过期后重新粘） |
| 论文邮箱 | 下论文 PDF | 你常用的邮箱即可。Unpaywall 要求真实地址来识别请求方 |

同一页还有一个设备指纹与小工具按钮，正常用不到，说明在 [doc/DEVELOPMENT.md](doc/DEVELOPMENT.md)。

## 论文获取怎么用

这是最绕的一块，单独说清楚。

**先搜后取。** 先让模型搜，拿到论文的 DOI 或 arXiv id，再让它取 PDF。两条指令可以合成一句：「找两篇关于长文本推理的论文，把第一篇下下来」。

**arXiv 不需要装任何东西。** 认出 arXiv id（比如 `1706.03762`）或 arXiv 链接时，插件自己从 `https://arxiv.org/pdf/<id>` 取，实测 0.9 秒、2.1 MB。这条路不起本地进程、不需要登录。

**其他论文要一个本机 CLI。** 开放获取的论文（PLoS、PNAS 等）靠它查 Unpaywall 直接拿 PDF；订阅论文靠它在**你本机弹一个浏览器窗口**，你在这个窗口里完成学校统一身份认证，它再把 PDF 交回来。插件不代填密码，也不碰你的登录态。

**装 CLI 是第一步，按钮一键装。** 设置页「论文获取」那一行的按钮会：

1. 先看本机有没有 `uv` 或 `pipx`；
2. 都没有就从 GitHub 取官方 `uv` 放到 `~/.local/bin/uv`；
3. 用它在 **Python 3.13** 上装 `instsci` 到 `~/.local/bin/instsci`，面板显示当前进行到哪一步。

固定 3.13 不是洁癖：上游的浏览器路线在 3.14 上起不来，闭源论文会全部失败。第一次真去取闭源论文时，它还会自己下浏览器内核（几百 MB），不在按钮里，按需发生。

**要等的时候会等。** 闭源论文最长等 20 分钟（`paperTimeoutMs`），因为要等你在那个窗口里点完登录。同一时刻只取一篇，两个窗口会互相踩 cookie。

**文件落在哪。** 默认 `<对话的工作区>/thu-downloads/papers/<DOI 或 arXiv id>.pdf`；重名不覆盖，自动加 `-1`。想改目录就配 `paperDir`（相对路径从工作区算，也可以写绝对路径或 `~/Papers`）。落盘前会校验字节：`%PDF-` 开头、大于 5000 字节、结尾正常——拿到的是登录页或半截文件时不会假装成功。

## 文件都下到哪

默认都在这一个目录里，按来源分子目录：

```
thu-downloads/
├── learn/<课程 id>/          课件与课程文件
├── reserves/<书目 id>/       教参教材
├── <共享链接 key>/           云盘文件
└── papers/                  论文 PDF
```

目录名可用配置项 `downloadDir` 改（默认 `thu-downloads`，必须写工作区内的相对路径）。

## 常见问题

**论文搜索报「被限流」。** Semantic Scholar 不登录时按 IP 限流，`rate-limited` 是它的正常反应。等几十秒再搜，或换个更窄的关键词。

**论文取不回来，说「没有 PDF」。** 这条路先从 Unpaywall 找开放获取的 PDF 链接，找不到就退到网页正文。有些期刊确实没给 PDF 链接，或者这篇需要机构权限又没在校内网。换用浏览器窗口那条路（同一工具会自动走）。

**拿到的是 HTML。** 通常是登录页。插件会拦下来报 `invalid-pdf`，不会把网页存成 `.pdf`。

**教参提示 token 过期。** JWT 只有约 1 小时，重新从 `localStorage.License` 粘一次。

**学堂下载不到文件。** 如果账号被验证码或二次认证挡住，先在浏览器登录一次，把 cookie 填进 `THU_LEARN_COOKIE`。

**下载器装不上。** 教参 CLI 的解包依赖本机有 `unzip`；论文 CLI 的安装依赖能访问 GitHub（下 `uv`）与 PyPI（下依赖）。面板会显示失败原因。

## 边界

- 只做**你自己有权限**的资源：用的是你的账号、以你的身份请求。遵守学校的资源使用规定与期刊订阅条款。
- 插件不改 DSH 的循环，只提供工具；面板上的按钮直接发请求，不经过模型。
- 论文的获取路线全部交给外部项目 [`instsci`](https://github.com/Rimagination/instsci)（MIT），插件只负责装它、调它、验它的产物。唯一例外是 arXiv，理由见 [doc/PLAN.md §9](doc/PLAN.md#9-决策记录)。
- 真机验证状态：学堂（真实账号 7 门课）、云盘、论文（开放获取与 arXiv 已取到 PDF）已跑通；教参仍待真实 token + 真实书目，闭源论文仍待完整走一次浏览器登录。

## 文档

| 文件 | 内容 |
| --- | --- |
| [doc/TOOLS.md](doc/TOOLS.md) | 十个工具的参数、返回、失败方式、所需凭据；面板路由契约 |
| [doc/PLAN.md](doc/PLAN.md) | 目标与硬边界、目录结构、UI 设计、里程碑、风险、决策记录 |
| [doc/DEVELOPMENT.md](doc/DEVELOPMENT.md) | 实现细节、面板设计、真机验证记录、踩过的坑 |
| [doc/CHANGELOG.md](doc/CHANGELOG.md) | 版本变更 |

发版约定：改 `package.json` 的 `version` → 更新 `doc/CHANGELOG.md` → `git commit` → `git tag -a vX.Y.Z` → `npm publish`。`prepack` 会先跑一次构建，打出的包里带 `lib/`；`src/` 跟着发布只为让类型定义与源码可查。

## 许可

MIT，见 [LICENSE](LICENSE)。论文路线的外部依赖 [`instsci`](https://github.com/Rimagination/instsci) 也是 MIT，各自独立。
