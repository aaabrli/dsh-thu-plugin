/**
 * Locale namespace and dictionaries for the settings section.
 *
 * Every user-visible string lives here. Components receive only the typed `t`
 * seat. Credential names stay verbatim — they are configuration tokens, and
 * naming them is how a user knows which entry is being written.
 * @module dsh-thu-plugin/client/locale
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Namespace both dictionaries register under. */
export const NS = 'thu-panel'

/** English dictionary; also the key set both dictionaries must cover. */
export const en = {
  'nav.label': 'Tsinghua',
  'section.title': 'Tsinghua tools',
  'section.hint': 'Account details entered here are shared with dsh-thu-automad: one student id and password serve both plugins. Course files, textbooks, and cloud shares download through the chat tools instead.',
  'section.loading': 'Loading the tools panel…',

  'status.title': 'Status',
  'status.tool': 'Course reserves downloader',
  'status.fingerprint': 'Device fingerprint',
  'status.fingerprint.shared': 'Shared with dsh-thu-automad',
  'status.fingerprint.own': 'Set separately',
  'status.fingerprint.none': 'Created on the first sign-in',
  'status.fingerprint.hint': 'The school trusts a device it has seen. Both plugins present the same one, so a new device never needs a second confirmation.',

  'papers.title': 'Paper fetching',
  'papers.hint': 'Open-access first, then through the university license, by running a local Python CLI. A publisher route opens a browser window on this machine and waits for you to sign in, so a fetch can take minutes. One click installs everything: when neither uv nor pipx is present, uv is downloaded first. The first closed-access fetch also downloads a browser runtime.',
  'papers.install': 'One-click install',
  'papers.installing': 'Installing…',
  'papers.noInstaller': 'Could not download uv automatically (network blocked?). Install uv or pipx by hand, then try again.',
  'papers.path': 'Command:',

  'automad.title': 'dsh-thu-automad',
  'automad.hint': 'The account plugin keeps your Tsinghua login and answers the second confirmation for you. Installing it writes a dependency into this profile and re-runs its plugin command; the page never touches the manifest itself.',
  'automad.package': 'Package',
  'automad.missing': 'Not installed',
  'automad.installed': 'Installed',
  'automad.notBundled': 'Installed, not loaded',
  'automad.install': 'Install',
  'automad.installing': 'Installing…',
  'automad.spec': 'Source:',
  'automad.profile': 'Profile:',
  'automad.restart': 'Installed. Restart dsh web before the plugin loads.',
  'tool.installed': 'Installed',
  'tool.missing': 'Not installed',
  'tool.download': 'Download',
  'tool.downloading': 'Downloading…',
  'tool.failed': 'Download failed',

  'group.identity.title': 'Campus account',
  'group.identity.hint': 'Stored as MADMODEL_USERNAME and MADMODEL_PASSWORD — the references dsh-thu-automad reads, so one entry signs in both plugins.',
  'group.learn.title': 'Learn (网络学堂)',
  'group.learn.hint': 'The account signs in and downloads on its own. The cookie is only the way past a captcha or a second-factor prompt. Leave the fingerprint blank to use the shared device fingerprint.',
  'group.reserves.title': 'Course reserves (教参)',
  'group.reserves.hint': 'Paste localStorage.License from a signed-in ereserves page. The token lasts about an hour.',
  'group.papers.title': 'Paper fetching',
  'group.papers.hint': 'The open-access lookup sends this address with every request, and the CLI asks for one on stdin when it has none — a tool call cannot answer that prompt, so it is saved here.',

  'field.username': 'Student id',
  'field.password': 'Unified-auth password',
  'field.fingerprint': 'Fingerprint override',
  'field.cookie': 'Learn cookie',
  'field.reservesToken': 'Reserves token',
  'field.paperEmail': 'Email for open-access lookups',
  'field.configured': 'Configured',
  'field.empty': 'Not set',
  'field.shared': 'Shared',
  'field.readonly': 'Read-only',
  'field.save': 'Save',
  'field.clear': 'Clear',
  'field.saving': 'Saving…',
  'field.saved': 'Saved',
  'field.error': 'Could not save',
  'field.placeholder': 'New value — stored values are never shown',
} as const

/** Simplified Chinese dictionary. */
export const zh: Record<keyof typeof en, string> = {
  'nav.label': '清华工具',
  'section.title': '清华工具',
  'section.hint': '这里填的账号与 dsh-thu-automad 共用：学号和密码两个插件读同一份。课件、教材和云盘分享仍通过会话里的工具下载。',
  'section.loading': '正在读取工具面板…',

  'status.title': '状态',
  'status.tool': '教参下载器',
  'status.fingerprint': '设备指纹',
  'status.fingerprint.shared': '与 dsh-thu-automad 共用',
  'status.fingerprint.own': '已单独设置',
  'status.fingerprint.none': '首次登录时自动生成',
  'status.fingerprint.hint': '学校只信任见过的设备。两个插件使用同一个指纹，新设备就不会再被要求二次确认。',

  'papers.title': '论文获取',
  'papers.hint': '先走开放获取，再走学校订阅，由本机的 Python CLI 完成。出版社路线会在本机弹出浏览器窗口等你登录，所以一次获取可能要几分钟。一键安装会自己判断：本机没有 uv / pipx 时先下载 uv，再安装 CLI；第一次走闭源路线还会下载浏览器内核。',
  'papers.install': '一键安装',
  'papers.installing': '安装中…',
  'papers.noInstaller': '无法自动下载 uv（网络受限？）：请手动安装 uv 或 pipx 后再试。',
  'papers.path': '命令：',

  'automad.title': 'dsh-thu-automad',
  'automad.hint': '账号插件负责保存清华登录态并代你完成二次确认。安装会往当前 profile 写入依赖并重跑它自己的插件命令，本页不直接改清单。',
  'automad.package': '安装包',
  'automad.missing': '未安装',
  'automad.installed': '已安装',
  'automad.notBundled': '已安装，未加载',
  'automad.install': '安装',
  'automad.installing': '安装中…',
  'automad.spec': '来源：',
  'automad.profile': '配置：',
  'automad.restart': '已安装。重启 dsh web 后插件才会加载。',
  'tool.installed': '已安装',
  'tool.missing': '未安装',
  'tool.download': '下载',
  'tool.downloading': '下载中…',
  'tool.failed': '下载失败',

  'group.identity.title': '校园账号',
  'group.identity.hint': '保存为 MADMODEL_USERNAME 和 MADMODEL_PASSWORD——正是 dsh-thu-automad 读取的两个引用，填一次两个插件都能登录。',
  'group.learn.title': '网络学堂',
  'group.learn.hint': '账号密码即可登录并下载；Cookie 只在遇到验证码或二次认证时才需要。指纹留空即使用共享的设备指纹。',
  'group.reserves.title': '教参平台',
  'group.reserves.hint': '在已登录的教参页面控制台取 localStorage.License 粘贴进来。token 约 1 小时过期。',
  'group.papers.title': '论文获取',
  'group.papers.hint': '开放获取检索每次请求都会带上这个邮箱；CLI 没有邮箱时会在 stdin 上追问，而工具调用无法回答，所以存在这里。',

  'field.username': '学号',
  'field.password': '统一身份认证密码',
  'field.fingerprint': '指纹覆盖',
  'field.cookie': '学堂 Cookie',
  'field.reservesToken': '教参 token',
  'field.paperEmail': '开放获取检索邮箱',
  'field.configured': '已设置',
  'field.empty': '未设置',
  'field.shared': '共用',
  'field.readonly': '只读',
  'field.save': '保存',
  'field.clear': '清除',
  'field.saving': '保存中…',
  'field.saved': '已保存',
  'field.error': '保存失败',
  'field.placeholder': '新值——已保存的值不会再显示',
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Keys of this plugin's dictionaries. */
    'thu-panel': keyof typeof en
  }
}