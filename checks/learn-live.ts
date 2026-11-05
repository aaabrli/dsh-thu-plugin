/**
 * Live probe: does the stored campus account actually work, and does this
 * plugin's own session layer walk Learn correctly?
 *
 * Not part of `pnpm run check` — it talks to the school, so it runs on demand.
 * It reads the account from the environment (never from a file) and prints
 * names and ids only: no password, no cookie, no fingerprint.
 *
 *   THU_USER=… THU_PASS=… THU_FP=… pnpm exec tsx --tsconfig tsconfig.check.json checks/learn-live.ts
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Learn2018Helper } from 'thu-learn-lib'
import { resolveOptions } from '../src/config.js'
import { openLearnSession } from '../src/learn.js'

const username = process.env.THU_USER
const password = process.env.THU_PASS
const fingerPrint = process.env.THU_FP
const cookie = process.env.THU_COOKIE

/**
 * A Context stub holding just what the Learn layer reads: the two shared
 * account refs, an optional cookie, and the thu-automad session record the
 * device fingerprint lives in.
 * @returns the stub Context.
 */
function stubContext(): Context {
  const refs: Record<string, string> = {}
  if (username !== undefined) refs.MADMODEL_USERNAME = username
  if (password !== undefined) refs.MADMODEL_PASSWORD = password
  if (cookie !== undefined) refs.THU_LEARN_COOKIE = cookie
  const records = new Map<string, unknown>()
  if (fingerPrint !== undefined) {
    records.set('thu-automad/session', { kind: 'grant', payload: { fingerprint: fingerPrint } })
  }
  return {
    credentials: {
      describe: (ref: string) => Promise.resolve({ configured: refs[ref] !== undefined, writable: true }),
      resolve: (ref: string) => Promise.resolve(refs[ref] === undefined ? undefined : { value: refs[ref] }),
      readRecord: (key: string) => Promise.resolve(records.get(key)),
      modifyRecord: (key: string, mutate: (current: unknown) => Promise<unknown>) =>
        mutate(records.get(key)).then(next => {
          if (next === undefined) records.delete(key)
          else records.set(key, next)
          return next
        }),
    },
  } as unknown as Context
}

if (username === undefined || password === undefined) {
  console.log('learn-live: set THU_USER and THU_PASS (THU_FP and THU_COOKIE are optional)')
  process.exitCode = 2
} else {
  const options = resolveOptions({})
  const session = await openLearnSession(stubContext(), options, options.timeoutMs)
  if ('ok' in session) {
    console.log(`learn-live: session failed — ${session.reason}: ${session.message}`)
  } else {
    const semesters = await session.semesters()
    for (const semester of semesters) {
      console.log(`learn-live: semester ${semester.id} ${semester.name} current=${String(semester.current)}`)
    }
    const { semesterId, courses } = await session.courses(undefined)
    console.log(`learn-live: ${semesterId} has ${courses.length} course(s)`)
    for (const course of courses.slice(0, 8)) console.log(`learn-live:   ${course.name}`)
    const first = courses[0]
    if (first !== undefined) {
      const files = await session.files(first.id, undefined)
      console.log(`learn-live: ${first.name} has ${files.length} file(s)`)
      for (const file of files.slice(0, 5)) {
        console.log(`learn-live:   ${file.name} (${file.size} B) ${file.id}`)
      }
      // The smallest file keeps the probe cheap — course videos are hundreds of MB.
      const target = [...files].sort((left, right) => left.size - right.size)[0]
      if (process.env.THU_TRY_DOWNLOAD === '1' && target !== undefined) {
        const root = await mkdtemp(join(tmpdir(), 'learn-live-'))
        const outcome = await session.download(first.id, [target.id], root, {
          timeoutMs: options.timeoutMs,
          signal: AbortSignal.timeout(options.timeoutMs),
          concurrency: 1,
          overwrite: true,
        })
        for (const saved of outcome.downloaded) {
          const head = await readFile(saved.path)
          console.log(`learn-live: saved ${saved.path} ${saved.bytes} B`,
            `magic=${JSON.stringify(head.subarray(0, 5).toString('latin1'))}`)
        }
        console.log(`learn-live: failed=${JSON.stringify(outcome.failed)}`)
        await rm(root, { recursive: true, force: true })
      }
    }
  }
}