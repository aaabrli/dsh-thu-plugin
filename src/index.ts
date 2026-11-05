/**
 * Host plugin that registers Tsinghua download tools.
 *
 * Every tool here is a thin adapter: it validates arguments, calls one pure
 * capability module (`cloud`, `download`, later `learn`/`reserves`), and returns
 * a domain value. Failures the user can act on come back as data with a
 * `reason`, not as exceptions — an exception is reserved for "the tool itself
 * could not run".
 * @module dsh-thu-plugin
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-working-directory'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { CloudReason } from './cloud.ts'
import { CloudError, downloadShareFiles, listDirectory, parseShareTarget } from './cloud.ts'
import { resolveOptions } from './config.ts'
import { downloadRoot, formatBytes, joinUnder } from './download.ts'
import type { LearnReason } from './learn.ts'
import { isLearnFailure, openLearnSession } from './learn.ts'
import {
  readInstall,
  readPanel,
  startAutomadInstall,
  startInstall,
  writeCredential,
} from './panel.ts'
import { CREDENTIALS_PATH, INSTALL_PATH, PANEL_PATH } from './routes.ts'
import { downloadBook } from './reserves.ts'
import { readStatus } from './status.ts'

/** Cordis plugin name. */
export const name = 'thu'

/** Services this plugin registers tools against and reads credentials from. */
export const inject = ['tools', 'credentials', 'workingDirectory', 'connection']

/** A failure the caller can act on, as a value instead of a thrown error. */
interface Failure {
  readonly ok: false
  readonly reason: CloudReason | LearnReason | 'unknown'
  readonly message: string
}

/**
 * Turn a thrown error into a domain failure.
 * @param error - whatever was thrown.
 * @returns a failure carrying a reason the model can branch on.
 */
function toFailure(error: unknown): Failure {
  if (error instanceof CloudError) return { ok: false, reason: error.reason, message: error.message }
  return { ok: false, reason: 'unknown', message: error instanceof Error ? error.message : String(error) }
}

/**
 * Resolve the session's working directory, so a relative `downloadDir` lands in
 * the workspace the user is actually looking at.
 * @param ctx - plugin context.
 * @param agent - session the call runs for.
 * @param signal - cancellation.
 * @returns absolute working directory.
 */
async function sessionDirectory(
  ctx: Context,
  agent: Parameters<Context['workingDirectory']['ensure']>[0],
  signal: AbortSignal,
): Promise<string> {
  return ctx.workingDirectory.ensure(agent, signal)
}

/**
 * Validate config and register this plugin's tools.
 * @param ctx - plugin context providing the tool registry, credentials seam, and working directory.
 * @param config - raw `config` mapping from cordis.yml; validated here.
 */
export function apply(ctx: Context, config: unknown): void {
  const options = resolveOptions(config)

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'thu_status',
    description: 'Check whether Tsinghua Learn credentials and the reserves downloader are configured. Does not reveal secret values.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          learn: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              credential: { type: 'boolean', required: true, description: 'Whether a Learn login secret is configured.' },
              session: { type: 'boolean', required: true, description: 'Whether a live Learn session is stored.' },
              sharedFingerprint: { type: 'boolean', required: true, description: 'Whether a device fingerprint is stored in the record shared with dsh-thu-automad.' },
            },
          },
          reserves: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              cli: { type: 'boolean', required: true, description: 'Whether the reserves downloader path exists.' },
              token: { type: 'boolean', required: true, description: 'Whether a reserves token is configured.' },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `learn credential=${String(value.learn.credential)} session=${String(value.learn.session)} shared-fingerprint=${String(value.learn.sharedFingerprint)}; reserves cli=${String(value.reserves.cli)} token=${String(value.reserves.token)}`,
      }],
    },
    async execute() {
      return readStatus(ctx, options)
    },
  })), 'thu: status tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'thu_cloud_list',
    description: 'List a directory of a public Tsinghua cloud (cloud.tsinghua.edu.cn) share link. Works without any credentials: the share link itself is the authorization.',
    parameters: {
      url: { type: 'string', required: true, description: 'Share link such as https://cloud.tsinghua.edu.cn/d/<key>/ or the bare share key.' },
      path: { type: 'string', description: 'Directory inside the share. Defaults to / (or to the path embedded in the link).' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string', description: 'Why the listing failed: invalid-url, not-found, locked, network, timeout, http-error.' },
          message: { type: 'string' },
          shareKey: { type: 'string' },
          path: { type: 'string', description: 'Directory that was listed.' },
          entries: {
            type: 'array',
            description: 'Entries of the directory, directories first.',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string', required: true, description: 'Path of the entry inside the share.' },
                type: { type: 'string', required: true, enum: ['file', 'dir'] },
                size: { type: 'number', required: true, description: 'Bytes; 0 for directories.' },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `cloud list failed: ${value.reason ?? 'unknown'} — ${value.message ?? ''}` }]
        const entries = value.entries ?? []
        const lines = entries.slice(0, 20).map(entry => `${entry.type === 'dir' ? 'dir ' : 'file'}  ${entry.name}${entry.type === 'dir' ? '/' : `  (${formatBytes(entry.size)})`}`)
        const more = entries.length > 20 ? [`… ${entries.length - 20} more`] : []
        return [{ type: 'text', text: [`${value.shareKey ?? ''}${value.path ?? ''} — ${entries.length} entries`, ...lines, ...more].join('\n') }]
      },
    },
    async execute(args, exec) {
      try {
        const target = parseShareTarget(args.url, args.path)
        const entries = await listDirectory(target, { timeoutMs: options.timeoutMs, signal: exec.signal })
        return { ok: true, shareKey: target.shareKey, path: target.path, entries }
      } catch (error) {
        return { ...toFailure(error), entries: [] }
      }
    },
  })), 'thu: cloud list tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'thu_cloud_download',
    description: 'Download files from a public Tsinghua cloud (cloud.tsinghua.edu.cn) share link into the workspace. Recurses into subdirectories; needs no credentials.',
    parameters: {
      url: { type: 'string', required: true, description: 'Share link or bare share key.' },
      path: { type: 'string', description: 'Directory (or single file) inside the share. Defaults to /.' },
      pattern: { type: 'string', description: 'Comma-separated names, suffixes, or globs (* and ?) to filter files, e.g. ".pdf, *.pptx". Omit for everything.' },
      concurrency: { type: 'integer', description: `Parallel downloads. Defaults to the configured ${String(options.concurrency)}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          message: { type: 'string' },
          directory: { type: 'string', description: 'Absolute directory the files were written to.' },
          downloaded: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string', required: true, description: 'Absolute path on disk.' },
                bytes: { type: 'number', required: true },
              },
            },
          },
          failed: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
          totalBytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => {
        const head = value.ok
          ? `downloaded ${value.downloaded?.length ?? 0} file(s), ${formatBytes(value.totalBytes ?? 0)} → ${value.directory ?? ''}`
          : `cloud download failed: ${value.reason ?? 'unknown'} — ${value.message ?? ''}`
        const failed = (value.failed ?? []).slice(0, 5).map(item => `failed: ${item.name} — ${item.reason}`)
        return [{ type: 'text', text: [head, ...failed].join('\n') }]
      },
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('thu_cloud_download requires an agent Session')
      let target
      try {
        target = parseShareTarget(args.url, args.path)
      } catch (error) {
        return { ...toFailure(error), downloaded: [], failed: [], totalBytes: 0 }
      }
      try {
        const cwd = await sessionDirectory(ctx, exec.agent, exec.signal)
        const root = joinUnder(downloadRoot(cwd, options.downloadDir), target.shareKey)
        const result = await downloadShareFiles(target, {
          root,
          pattern: args.pattern,
          concurrency: args.concurrency ?? options.concurrency,
          timeoutMs: options.timeoutMs,
          signal: exec.signal,
        })
        return { ok: true as const, ...result }
      } catch (error) {
        return { ...toFailure(error), downloaded: [], failed: [], totalBytes: 0 }
      }
    },
  })), 'thu: cloud download tool')

  const learnFailure = (value: { reason: LearnReason; message: string; credential?: string }) => ({
    ok: false as const,
    reason: value.reason,
    message: value.message,
    ...(value.credential === undefined ? {} : { credential: value.credential }),
  })

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'thu_learn_semesters',
    description: 'List Tsinghua Learn semesters for the signed-in student. Needs Learn credentials; does not take a password as an argument.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          message: { type: 'string' },
          credential: { type: 'string', description: 'Which credential to configure when reason is missing-credential.' },
          semesters: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                current: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `learn semesters failed: ${value.reason ?? 'unknown'} — ${value.message ?? ''}` }]
        const rows = value.semesters ?? []
        const lines = rows.slice(0, 20).map(row => `${row.current ? '* ' : '  '}${row.id}  ${row.name}`)
        return [{ type: 'text', text: [`${rows.length} semester(s)`, ...lines].join('\n') }]
      },
    },
    async execute(_args, exec) {
      const session = await openLearnSession(ctx, options, options.timeoutMs)
      if (isLearnFailure(session)) return { ...learnFailure(session), semesters: [] }
      try {
        const semesters = await session.semesters()
        void exec.signal
        return { ok: true as const, semesters }
      } catch (error) {
        return { ...toFailure(error), semesters: [] }
      }
    },
  })), 'thu: learn semesters tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'thu_learn_courses',
    description: 'List Tsinghua Learn courses for one semester. Omit semesterId for the current semester.',
    parameters: {
      semesterId: { type: 'string', description: 'Semester id such as 2025-2026-1. Defaults to the current semester.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          message: { type: 'string' },
          credential: { type: 'string' },
          semesterId: { type: 'string' },
          courses: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                teacher: { type: 'string', required: true },
                time: { type: 'string', required: true },
                location: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `learn courses failed: ${value.reason ?? 'unknown'} — ${value.message ?? ''}` }]
        const rows = value.courses ?? []
        const lines = rows.slice(0, 20).map(row => `${row.id}  ${row.name}  ${row.teacher}`)
        const more = rows.length > 20 ? [`… ${rows.length - 20} more`] : []
        return [{ type: 'text', text: [`${value.semesterId ?? ''} — ${rows.length} course(s)`, ...lines, ...more].join('\n') }]
      },
    },
    async execute(args) {
      const session = await openLearnSession(ctx, options, options.timeoutMs)
      if (isLearnFailure(session)) return { ...learnFailure(session), courses: [] }
      try {
        const listed = await session.courses(args.semesterId)
        return { ok: true as const, semesterId: listed.semesterId, courses: listed.courses }
      } catch (error) {
        return { ...toFailure(error), courses: [] }
      }
    },
  })), 'thu: learn courses tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'thu_learn_files',
    description: 'List files of one Tsinghua Learn course. downloadUrl is returned so the user can copy it; saving to disk is thu_learn_download.',
    parameters: {
      courseId: { type: 'string', required: true, description: 'Course id from thu_learn_courses.' },
      category: { type: 'string', description: 'Optional category title or id to keep.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          message: { type: 'string' },
          credential: { type: 'string' },
          courseId: { type: 'string' },
          files: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                size: { type: 'number', required: true },
                uploadedAt: { type: 'string', required: true },
                downloadUrl: { type: 'string', required: true },
                hasPreview: { type: 'boolean', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.ok) return [{ type: 'text', text: `learn files failed: ${value.reason ?? 'unknown'} — ${value.message ?? ''}` }]
        const rows = value.files ?? []
        const lines = rows.slice(0, 20).map(row => `${row.id}  ${row.name}  (${formatBytes(row.size)})`)
        const more = rows.length > 20 ? [`… ${rows.length - 20} more`] : []
        return [{ type: 'text', text: [`${value.courseId ?? ''} — ${rows.length} file(s)`, ...lines, ...more].join('\n') }]
      },
    },
    async execute(args) {
      const session = await openLearnSession(ctx, options, options.timeoutMs)
      if (isLearnFailure(session)) return { ...learnFailure(session), courseId: args.courseId, files: [] }
      try {
        const files = await session.files(args.courseId, args.category)
        return { ok: true as const, courseId: args.courseId, files }
      } catch (error) {
        return { ...toFailure(error), courseId: args.courseId, files: [] }
      }
    },
  })), 'thu: learn files tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'thu_learn_download',
    description: 'Download selected Tsinghua Learn course files into the workspace. One failure does not stop the rest.',
    parameters: {
      courseId: { type: 'string', required: true, description: 'Course id from thu_learn_courses.' },
      fileIds: {
        type: 'array',
        required: true,
        description: 'File ids from thu_learn_files.',
        items: { type: 'string' },
      },
      overwrite: { type: 'boolean', description: 'Replace an existing file of the same name. Defaults to false.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string' },
          message: { type: 'string' },
          credential: { type: 'string' },
          downloaded: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                path: { type: 'string', required: true },
                bytes: { type: 'number', required: true },
              },
            },
          },
          failed: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                reason: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (!value.ok && (value.downloaded?.length ?? 0) === 0) {
          return [{ type: 'text', text: `learn download failed: ${value.reason ?? 'unknown'} — ${value.message ?? ''}` }]
        }
        const failed = (value.failed ?? []).slice(0, 5).map(item => `failed: ${item.name} — ${item.reason}`)
        return [{ type: 'text', text: [`downloaded ${value.downloaded?.length ?? 0} file(s)`, ...failed].join('\n') }]
      },
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('thu_learn_download requires an agent Session')
      const session = await openLearnSession(ctx, options, options.timeoutMs)
      if (isLearnFailure(session)) return { ...learnFailure(session), downloaded: [], failed: [] }
      try {
        const cwd = await sessionDirectory(ctx, exec.agent, exec.signal)
        const root = joinUnder(downloadRoot(cwd, options.downloadDir), 'learn', args.courseId)
        const result = await session.download(args.courseId, args.fileIds, root, {
          timeoutMs: options.timeoutMs,
          signal: exec.signal,
          concurrency: options.concurrency,
          overwrite: args.overwrite === true,
        })
        const ok = result.failed.length === 0 || result.downloaded.length > 0
        return { ok, ...result }
      } catch (error) {
        return { ...toFailure(error), downloaded: [], failed: [] }
      }
    },
  })), 'thu: learn download tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'thu_reserves_download',
    description: 'Download a Tsinghua course-reserves (教参) book as a PDF into the workspace. Runs the locally installed reserves CLI as a subprocess: the CLI must be installed from Settings → Tsinghua tools, and THU_RESERVES_TOKEN must be saved. The token lasts about an hour. One call downloads the whole book — upstream cannot select chapters.',
    parameters: {
      url: { type: 'string', required: true, description: 'Book detail URL: https://ereserves.lib.tsinghua.edu.cn/bookDetail/<id>.' },
      quality: { type: 'integer', description: 'JPEG quality 1–96 for the generated PDF; 96 (the default) keeps the scans untouched.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          reason: { type: 'string', description: 'Why the download failed: invalid-url, cli-missing, token-missing, token-expired, token-invalid, rate-limited, login-required, exit-nonzero, timeout, cancelled, no-output.' },
          message: { type: 'string', description: 'What the user should do about a failure.' },
          log: { type: 'string', description: 'Tail of the CLI output, for failures.' },
          bookId: { type: 'string' },
          book: { type: 'string', description: 'Book title as the CLI reported it.' },
          path: { type: 'string', description: 'Local absolute path of the generated PDF.' },
          bytes: { type: 'number' },
          pages: { type: 'number', description: 'Pages the CLI scraped; 0 when it did not say.' },
          durationMs: { type: 'number' },
        },
      },
      render: (_args, value) => {
        if (!value.ok) {
          const detail = value.message ?? ''
          const tail = value.log === undefined ? [] : [`out: ${value.log.split('\n').slice(-5).join(' | ')}`]
          return [{ type: 'text', text: [`reserves download failed: ${value.reason ?? 'unknown'} — ${detail}`, ...tail].join('\n') }]
        }
        return [{
          type: 'text',
          text: `${value.book ?? value.bookId ?? 'book'} — ${value.pages ?? 0} pages, ${formatBytes(value.bytes ?? 0)} in ${((value.durationMs ?? 0) / 1_000).toFixed(1)}s\n${value.path ?? ''}`,
        }]
      },
    },
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('thu_reserves_download requires an agent Session')
      const cwd = await sessionDirectory(ctx, exec.agent, exec.signal)
      return downloadBook(ctx, options, cwd, {
        url: args.url,
        ...(args.quality === undefined ? {} : { quality: args.quality }),
      }, exec.signal)
    },
  })), 'thu: reserves download tool')

  ctx.effect(() => ctx.connection.fetch.register({
    path: PANEL_PATH,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => Response.json(await readPanel(ctx, options), {
      headers: { 'cache-control': 'no-store' },
    }),
  }), 'thu: panel route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: INSTALL_PATH,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async request => {
      if (request.method === 'GET') {
        const taskId = new URL(request.url).searchParams.get('taskId') ?? ''
        const task = readInstall(taskId)
        if (task === undefined) return Response.json({ state: 'unknown' }, { status: 404 })
        return Response.json(task, { headers: { 'cache-control': 'no-store' } })
      }
      const body = await readJson(request)
      const task = body.tool === 'reserves'
        ? startInstall(options)
        : body.tool === 'automad' ? await startAutomadInstall() : undefined
      if (task === undefined) {
        return Response.json({ ok: false, reason: 'unknown-tool' }, { status: 400 })
      }
      if ('ok' in task) return Response.json(task, { status: 400 })
      return Response.json({ taskId: task.taskId, state: task.state })
    },
  }), 'thu: install route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: CREDENTIALS_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      const body = await readJson(request)
      const id = typeof body.id === 'string' ? body.id : ''
      const value = typeof body.value === 'string' ? body.value : ''
      const result = await writeCredential(ctx, options, id, value)
      return Response.json(result, { status: result.ok ? 200 : 400 })
    },
  }), 'thu: credentials route')
}

/**
 * Read a JSON object body. A non-object becomes an empty record so callers
 * can reject unknown fields without throwing.
 * @param request - incoming Fetch request.
 * @returns the object, or `{}` when the body is not one.
 */
async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json()
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return {}
    return body as Record<string, unknown>
  } catch {
    return {}
  }
}
