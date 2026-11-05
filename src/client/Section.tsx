/**
 * Settings section: status rows plus the account fields the tools sign in with.
 *
 * This page is the same shape as `dsh-thu-automad`'s account page on purpose —
 * a status card, one card per credential group, a badge per field — because the
 * two plugins now write the same student id, the same password, and the same
 * device fingerprint. Every control comes from `ui-primitives`, so the two
 * pages also look and behave like the settings pages shipped beside them.
 *
 * Course files are not listed here. Secret inputs are write-only: the snapshot
 * only says configured / writable, and a successful save clears the input.
 * @module dsh-thu-plugin/client/Section
 */

import { memo, useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locale.ts'
import {
  loadPanel,
  pollInstall,
  saveCredential,
  startAutomadInstall,
  startPapersInstall,
  startReservesInstall,
  type FieldView,
  type PanelView,
} from './panel.ts'
import { css } from './styles.ts'

/** Full props of the settings section (the shell supplies `close`). */
export type SectionProps =
  & PropsRuntime<'settings.section'>
  & PropsLocale<typeof NS>

/** Badge weight of one reported state. */
type BadgeTone = 'ok' | 'idle' | 'warn' | 'error'

/** Field label keys, by field id. */
const LABELS = {
  username: 'field.username',
  password: 'field.password',
  fingerprint: 'field.fingerprint',
  cookie: 'field.cookie',
  'reserves-token': 'field.reservesToken',
  'paper-email': 'field.paperEmail',
} as const

/**
 * Cards the fields are grouped into. Order follows the order of the snapshot,
 * which the host decides; ids keep fields in one card even if the host grows
 * the list.
 */
const GROUPS = [
  { title: 'group.identity.title', hint: 'group.identity.hint', ids: ['username', 'password'] },
  { title: 'group.learn.title', hint: 'group.learn.hint', ids: ['fingerprint', 'cookie'] },
  { title: 'group.reserves.title', hint: 'group.reserves.hint', ids: ['reserves-token'] },
  { title: 'group.papers.title', hint: 'group.papers.hint', ids: ['paper-email'] },
] as const

/**
 * The section body: install the reserves CLI, write the shared account.
 * @param props - locale seat.
 * @returns the section content column.
 */
export const ThuSection = memo(function ThuSection({ t }: SectionProps) {
  const [panel, setPanel] = useState<PanelView | null>(null)
  const [revision, setRevision] = useState(0)
  const [taskId, setTaskId] = useState<string | null>(null)
  const [taskKind, setTaskKind] = useState<'reserves' | 'papers' | 'automad'>('reserves')
  const [installError, setInstallError] = useState<string | null>(null)
  const [installLog, setInstallLog] = useState<string | null>(null)
  const [installProgress, setInstallProgress] = useState<string | null>(null)
  const [automadRestart, setAutomadRestart] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [savedField, setSavedField] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  // The panel opens with this section mounted, so one read on mount is enough;
  // `revision` re-reads after an install or a credential write.
  useEffect(() => {
    let cancelled = false
    void loadPanel().then(next => { if (!cancelled) setPanel(next) })
    return () => { cancelled = true }
  }, [revision])

  useEffect(() => {
    if (taskId === null) return
    const timer = setInterval(() => {
      void pollInstall(taskId).then(task => {
        setInstallProgress(task.state === 'running' ? task.progress ?? null : null)
        if (task.state === 'done') {
          setTaskId(null)
          if (task.restartRequired === true) setAutomadRestart(true)
          setRevision(current => current + 1)
        } else if (task.state === 'failed') {
          setTaskId(null)
          setInstallError(task.error ?? t('tool.failed'))
          setInstallLog(task.log ?? null)
        }
      })
    }, 1_000)
    return () => { clearInterval(timer) }
  }, [taskId, t])

  const reserves = panel?.tools.find(item => item.id === 'reserves')
  const papers = panel?.tools.find(item => item.id === 'papers')
  const automad = panel?.tools.find(item => item.id === 'automad')
  const fingerprint = panel?.fields.find(field => field.id === 'fingerprint')

  const write = (field: FieldView, value: string): void => {
    setSaving(field.id)
    setSaveError(null)
    void saveCredential(field.id, value).then(ok => {
      setSaving(null)
      if (!ok) {
        setSaveError(t('field.error'))
        return
      }
      setDrafts(current => ({ ...current, [field.id]: '' }))
      setSavedField(field.id)
      setRevision(current => current + 1)
    })
  }

  if (panel === null) {
    return (
      <div className={css.section}>
        <h2 className={css.h2}>{t('section.title')}</h2>
        <p className={css.p}>{t('section.loading')}</p>
      </div>
    )
  }

  return (
    <div className={css.section}>
      <div>
        <h2 className={css.h2}>{t('section.title')}</h2>
        <p className={css.p}>{t('section.hint')}</p>
      </div>

      <section className={css.card} aria-labelledby="thu-status-title">
        <h3 className={css.h3} id="thu-status-title">{t('status.title')}</h3>
        <div className={css.row}>
          <span className={css.rowLabel}>{t('status.tool')}</span>
          <span className={css.rowValue}>
            <Badge
              tone={reserves?.installed === true ? 'ok' : 'idle'}
              text={reserves?.installed === true ? t('tool.installed') : t('tool.missing')}
            />
            <Button
              onClick={() => {
                setInstallError(null)
                setInstallLog(null)
                setTaskKind('reserves')
                void startReservesInstall().then(task => {
                  if (task.taskId !== undefined) setTaskId(task.taskId)
                  else setInstallError(task.reason ?? t('tool.failed'))
                })
              }}
              disabled={taskId !== null}
            >
              {taskId !== null && taskKind === 'reserves' ? t('tool.downloading') : t('tool.download')}
            </Button>
          </span>
        </div>
        {reserves?.path ? <p className={css.note}>{reserves.path}</p> : null}

        <div className={css.row}>
          <span className={css.rowLabel}>{t('status.fingerprint')}</span>
          <span className={css.rowValue}>
            <Badge
              tone={fingerprint?.configured === true ? 'ok' : 'idle'}
              text={fingerprintState(fingerprint, t)}
            />
          </span>
        </div>
        <div className={css.row}>
          <span className={css.rowLabel}>{t('papers.title')}</span>
          <span className={css.rowValue}>
            <Badge
              tone={papers?.installed === true ? 'ok' : 'idle'}
              text={papers?.installed === true ? t('tool.installed') : t('tool.missing')}
            />
            <Button
              onClick={() => {
                setInstallError(null)
                setInstallLog(null)
                setInstallProgress(null)
                setTaskKind('papers')
                void startPapersInstall().then(task => {
                  if (task.taskId !== undefined) setTaskId(task.taskId)
                  else setInstallError(task.error ?? (task.reason === 'no-installer' ? t('papers.noInstaller') : t('tool.failed')))
                })
              }}
              disabled={taskId !== null}
            >
              {taskId !== null && taskKind === 'papers' ? t('papers.installing') : t('papers.install')}
            </Button>
          </span>
        </div>
        {papers?.path ? <p className={css.note}>{t('papers.path')} {papers.path}</p> : null}
        {installProgress !== null ? <p className={css.note}>{installProgress}</p> : null}
        <p className={css.note}>{t('status.fingerprint.hint')}</p>
        {installError !== null ? <p className={css.error}>{installError}</p> : null}
        {installLog !== null ? <pre className={css.log}>{installLog}</pre> : null}
      </section>

      <section className={css.card} aria-labelledby="thu-automad-title">
        <h3 className={css.h3} id="thu-automad-title">{t('automad.title')}</h3>
        <p className={css.p}>{t('automad.hint')}</p>
        <div className={css.row}>
          <span className={css.rowLabel}>{t('automad.package')}</span>
          <span className={css.rowValue}>
            <Badge
              tone={automad === undefined ? 'idle' : automad.installed === '' ? 'idle' : automad.bundled ? 'ok' : 'warn'}
              text={automadText(automad, t)}
            />
            <Button
              onClick={() => {
                setInstallError(null)
                setInstallLog(null)
                setTaskKind('automad')
                setAutomadRestart(false)
                void startAutomadInstall().then(task => {
                  if (task.taskId !== undefined) setTaskId(task.taskId)
                  else setInstallError(task.reason ?? t('tool.failed'))
                })
              }}
              disabled={taskId !== null}
            >
              {taskId !== null && taskKind === 'automad' ? t('automad.installing') : t('automad.install')}
            </Button>
          </span>
        </div>
        <p className={css.note}>{t('automad.spec')} {automad?.spec ?? ''}</p>
        {automad?.profile ? <p className={css.note}>{t('automad.profile')} {automad.profile}</p> : null}
        {automadRestart ? <p className={css.note}>{t('automad.restart')}</p> : null}
      </section>

      {GROUPS.map(group => {
        const fields = group.ids
          .map(id => panel.fields.find(field => field.id === id))
          .filter((field): field is FieldView => field !== undefined)
        if (fields.length === 0) return null
        const headingId = `thu-${group.title}`
        return (
          <section className={css.card} key={group.title} aria-labelledby={headingId}>
            <h3 className={css.h3} id={headingId}>{t(group.title)}</h3>
            <p className={css.p}>{t(group.hint)}</p>
            {fields.map(field => (
              <FieldRow
                key={field.id}
                field={field}
                label={t(LABELS[field.id as keyof typeof LABELS] ?? 'field.username')}
                state={fieldState(field, t)}
                draft={drafts[field.id] ?? ''}
                busy={saving === field.id}
                saved={savedField === field.id}
                t={t}
                onDraft={value => {
                  setSavedField(null)
                  setSaveError(null)
                  setDrafts(current => ({ ...current, [field.id]: value }))
                }}
                onSave={() => { write(field, drafts[field.id] ?? '') }}
                onClear={() => { write(field, '') }}
              />
            ))}
          </section>
        )
      })}
      {saveError !== null ? <p className={css.error}>{saveError}</p> : null}
    </div>
  )
})

/** One write-only credential row with its own save and clear actions. */
function FieldRow({
  field, label, state, draft, busy, saved, t, onDraft, onSave, onClear,
}: {
  field: FieldView
  label: string
  state: string
  draft: string
  busy: boolean
  saved: boolean
  t: TranslateNS<typeof NS>
  onDraft: (value: string) => void
  onSave: () => void
  onClear: () => void
}) {
  const inputId = `thu-field-${field.id}`
  const disabled = !field.writable || busy
  return (
    <div className={css.field}>
      <label className={css.fieldLabel} htmlFor={inputId}>
        {label}
        <span className={css.fieldState}>{state}</span>
        {field.writable ? null : <span className={css.fieldState}>{t('field.readonly')}</span>}
      </label>
      <Input
        id={inputId}
        type={field.secret ? 'password' : 'text'}
        autoComplete="off"
        placeholder={t('field.placeholder')}
        value={draft}
        disabled={disabled}
        onChange={(event: { target: { value: string } }) => { onDraft(event.target.value) }}
      />
      <div className={css.actions}>
        <Button onClick={onSave} disabled={disabled || draft.length === 0}>
          {busy ? t('field.saving') : t('field.save')}
        </Button>
        <Button onClick={onClear} disabled={disabled || !field.configured}>
          {t('field.clear')}
        </Button>
        {saved ? <span className={css.note}>{t('field.saved')}</span> : null}
      </div>
    </div>
  )
}

/** Small state pill. */
function Badge({ tone, text }: { tone: BadgeTone; text: string }) {
  return <span className={`${css.badge} ${badgeClass(tone)}`.trim()}>{text}</span>
}

/** Badge class for one tone. */
function badgeClass(tone: BadgeTone): string {
  switch (tone) {
    case 'ok': return css.badgeOk
    case 'warn': return css.badgeWarn
    case 'error': return css.badgeError
    case 'idle': return css.badgeIdle
  }
}

/** Reading of the automad row: absent, installed, or installed but not loaded. */
function automadText(tool: { installed: string; bundled: boolean } | undefined, t: TranslateNS<typeof NS>): string {
  if (tool === undefined || tool.installed === '') return t('automad.missing')
  return tool.bundled ? t('automad.installed') : t('automad.notBundled')
}

/** Reading of the fingerprint state, which may come from the shared record. */
function fingerprintState(field: FieldView | undefined, t: TranslateNS<typeof NS>): string {
  if (field?.shared === true) return t('status.fingerprint.shared')
  if (field?.configured === true) return t('status.fingerprint.own')
  return t('status.fingerprint.none')
}

/** Reading of one field's stored state. */
function fieldState(field: FieldView, t: TranslateNS<typeof NS>): string {
  if (field.id === 'fingerprint') return fingerprintState(field, t)
  return field.configured ? t('field.configured') : t('field.empty')
}