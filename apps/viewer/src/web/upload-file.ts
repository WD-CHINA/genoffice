/** Thin HTTP adapter: Electron's decrypt/retry semantics, with decryption in the
 * parse service's bounded process. Never persist a password or put it in a URL. */
export async function uploadFile(
  server: string,
  file: Blob,
  format: string,
  token: string,
  dialogs?: {
    prompt(message: string): string | null | Promise<string | null>
    alert(message: string): void
  },
  send: typeof fetch = (...args) => fetch(...args),
): Promise<{ fileId: string; sha256: string; size: number; format: string; createdAt: string }> {
  let dialog: ReturnType<typeof import('./word-password').createWordPasswordDialog> | undefined
  let password: string | undefined
  try {
    for (;;) {
      const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
      if (password !== undefined)
        headers['X-Office-Password'] = btoa(
          String.fromCharCode(...new TextEncoder().encode(password)),
        )
      const response = await send(`${server}/v1/files`, { method: 'POST', body: file, headers })
      if (dialog?.cancelled) {
        await response.body?.cancel()
        throw new Error('已取消密码输入')
      }
      if (response.ok) return response.json()
      const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string }
      if (
        format === 'docx' &&
        (body.code === 'encrypted_document' || body.code === 'wrong_password')
      ) {
        if (password !== undefined && body.code === 'encrypted_document')
          throw new Error('解析服务尚未支持加密 Word，请更新解析服务后重新打开')
        if (body.code === 'wrong_password') dialogs?.alert('密码不正确，请重试。')
        if (!dialogs && !dialog)
          dialog = (await import('./word-password')).createWordPasswordDialog(
            typeof File !== 'undefined' && file instanceof File ? file.name : undefined,
          )
        const answer = dialogs
          ? await dialogs.prompt('请输入 Word 打开密码')
          : await dialog!.ask(body.code === 'wrong_password')
        if (answer === null) throw new Error('已取消密码输入')
        password = answer
        continue
      }
      throw new Error(`上传到解析服务失败：${body.message || `HTTP ${response.status}`}`)
    }
  } finally {
    dialog?.close()
  }
}
