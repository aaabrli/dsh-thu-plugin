# dsh-thu-plugin

清华学生资源获取的 DSH 插件。把 thu.services 上已有的工具接成会话里的 DSH 工具。面板上的按钮只负责把不能打进包的外部 CLI 装到本机，不下载课程文件。

范围：网络学堂文件下载、教参教材下载、清华云盘共享链接批量下载。

- [PLAN.md](PLAN.md) — 目标、硬边界、目录结构、UI 设计、里程碑、风险、决策记录。
- [TOOLS.md](TOOLS.md) — 每个工具的契约：参数、返回、失败方式、所需凭据；面板路由契约。

位置：仓库根的 `dsh-thu-plugin/`，**不迁入 `local-plugins/`**（已定，见 [PLAN.md §9](PLAN.md#9-决策记录)）。

当前状态：M0、M1、M2、M3、M4 完成（学堂与教参已真机验证；教参仍缺真实 token + 真实书目手测）。八个工具全部注册：`thu_status`、`thu_learn_semesters` / `thu_learn_courses` / `thu_learn_files` / `thu_learn_download`、`thu_reserves_download`、`thu_cloud_list` / `thu_cloud_download`。

界面是**设置面板里的一页**（`settings.section`，id `thu`，导航名「清华工具」）：教参 CLI 安装按钮，加上五项凭据的写入（`MADMODEL_USERNAME`、`MADMODEL_PASSWORD`、`THU_LEARN_FINGERPRINT`、`THU_LEARN_COOKIE`、`THU_RESERVES_TOKEN`）。学号与密码和 `dsh-thu-automad` **共用同一对引用**，设备指纹也共用（存在 `thu-automad/session` 记录里，两个插件向学校呈现同一台设备）。凭据只显示「已设置 / 未设置」，从不回显明文；留空保存即清除。教参 CLI 不需要先改配置，按钮默认装到 `~/.dsh/dsh-thu-plugin/reserves/downloader`（本机需要 `unzip`）。同一页还有第二个按钮：安装 [`dsh-thu-automad`](https://github.com/aaabrli/dsh-thu-automad)。它重跑当前安装形态的 CLI（`plugin --profile <p> add <spec>`），由 CLI 自己写依赖并对账 `dsh.profile.bundles`；装完需重启 `dsh web`，失败时面板会显示安装日志（git 源若被 pnpm 的 `allowBuilds` 拦住，日志里写着要加的键）。

真实账号已跑通（2026-2027 秋季学期 7 门课、数值分析A 22 个文件）：`MADMODEL_*` + 共享指纹能登录、能列、能看，**也能下载**——插件在登录那一刻包住全局 `fetch`，把库自己写进内存 jar 的 learn 域 `Set-Cookie` 顺手记下来，再用它去取 `downloadUrl`（实测落到 `%PDF-` 文件，不需要用户提供 cookie）。`THU_LEARN_COOKIE` 只在验证码/二次认证挡住密码登录时才需要，填了就优先用。`checks/learn-live.ts` 是真机探针（不进 `check`）：`THU_TRY_DOWNLOAD=1` 会下载最小的那个文件并打印 magic。

教参 token 怎么拿：浏览器登录 <https://ereserves.lib.tsinghua.edu.cn>，控制台执行 `localStorage.License`，把值粘进设置页的 `THU_RESERVES_TOKEN`。它是 JWT，约 1 小时过期；插件会先本地看 `exp`，过期直接提示重填，不会去起浏览器的登录流程。

配置项（`cordis.patch.yml` 里有默认值）：`downloadDir`（默认 `thu-downloads`，相对注入的工作目录）、`concurrency`（默认 2）、`timeoutMs`（默认 90 秒）、`reservesDelayMs`（默认 1500，下限 1000）、`reservesTimeoutMs`（默认 30 分钟）、`reservesCli`（空则用上面的默认安装路径）、`reservesTokenFile`（可选，覆盖凭据的 `token.txt` 路径）、`usernameRef` / `passwordRef`（默认 `MADMODEL_USERNAME` / `MADMODEL_PASSWORD`，即与 `dsh-thu-automad` 共用的那对引用）。

真实教参 token、真实共享链接仍待手测。剩余 M5：错误文案、示例配置、i18n 补齐。

开发命令（在本目录内）：

```
pnpm run setup:dev   # 把 harness 的包链进 node_modules（一次性）
pnpm run check       # typecheck + build + host-smoke + client-bundle
```


一句话边界：插件是适配层，不重写爬虫、不代填密码、不分发 GPL 依赖的源码。不含 GPA 计算（已移出范围）。