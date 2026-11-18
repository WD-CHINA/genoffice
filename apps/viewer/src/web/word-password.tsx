import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PasswordDialog } from '@genoffice/viewer-renderers/docs/renderer/components/PasswordDialog'
import { LocaleProvider, useI18n } from '@genoffice/viewer-renderers/docs/renderer/i18n/locale'
import './password-dialog.css'

/** Host boundary for Electron's original form; keep it mounted through retries. */
export function createWordPasswordDialog(name = '文档', signal?: AbortSignal) {
  let host: HTMLDivElement | undefined, root: Root | undefined
  let value = '',
    error = '',
    busy = false,
    closed = false,
    cancelled = false
  let answer: ((value: string | null) => void) | undefined
  const submit = () => {
    if (!answer || !value || busy) return
    const resolve = answer
    answer = undefined
    busy = true
    render()
    resolve(value)
  }
  const cancel = () => {
    cancelled = true
    const resolve = answer
    answer = undefined
    resolve?.(null)
    close()
  }
  function Form() {
    const { t } = useI18n()
    return (
      <PasswordDialog
        title={t('appDocPwdTitle')}
        body={t('appDocPwdBody', { name })}
        label={t('appDocPwdLabel')}
        placeholder={t('appDocPwdPlaceholder')}
        value={value}
        error={error}
        busy={busy}
        submitLabel={t(busy ? 'appStartOpening' : 'appOk')}
        cancelLabel={t('appCancel')}
        onChange={(next) => {
          value = next
          error = ''
          render()
        }}
        onSubmit={submit}
        onCancel={cancel}
      />
    )
  }
  function render() {
    root?.render(
      <LocaleProvider initial="zh">
        <Form />
      </LocaleProvider>,
    )
  }
  function close() {
    if (closed) return
    closed = true
    signal?.removeEventListener('abort', cancel)
    const resolve = answer
    answer = undefined
    resolve?.(null)
    root?.unmount()
    host?.remove()
  }
  signal?.addEventListener('abort', cancel, { once: true })
  return {
    get cancelled() {
      return cancelled
    },
    ask(wrong = false): Promise<string | null> {
      if (closed || signal?.aborted) return Promise.resolve(null)
      if (!host) {
        host = document.createElement('div')
        host.className = 'word-password-host'
        document.body.append(host)
        root = createRoot(host)
      }
      busy = false
      // Same translated inline error as App.tsx. No native prompt/alert on Android.
      error = wrong ? '密码不正确,请重试' : ''
      if (wrong) value = ''
      return new Promise((resolve) => {
        answer = resolve
        render()
      })
    },
    close,
  }
}
