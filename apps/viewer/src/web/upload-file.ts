/** Thin HTTP adapter: Electron's decrypt/retry semantics, with decryption in the
 * parse service's bounded process. Never persist a password or put it in a URL. */
export async function uploadFile(
  server: string,
  file: Blob,
  format: string,
  token: string,
  dialogs = {
    prompt: (message: string) => window.prompt(message),
    alert: (message: string) => window.alert(message),
  },
  send: typeof fetch = (...args) => fetch(...args),
): Promise<{ fileId: string; sha256: string; size: number; format: string; createdAt: string }> {
  let password: string | undefined
  for (;;) {
    const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {}
    if (password !== undefined)
      headers['X-Office-Password'] = btoa(
        String.fromCharCode(...new TextEncoder().encode(password)),
      )
    const response = await send(`${server}/v1/files`, { method: 'POST', body: file, headers })
    if (response.ok) return response.json()
    const body = (await response.json().catch(() => ({}))) as { code?: string; message?: string }
    if (
      format === 'docx' &&
      (body.code === 'encrypted_document' || body.code === 'wrong_password')
    ) {
      if (password !== undefined && body.code === 'encrypted_document')
        throw new Error('解析服务尚未支持加密 Word，请更新解析服务后重新打开')
      if (body.code === 'wrong_password') dialogs.alert('密码不正确，请重试。')
      const answer = dialogs.prompt('请输入 Word 打开密码')
      if (answer === null) throw new Error('已取消密码输入')
      password = answer
      continue
    }
    throw new Error(`上传到解析服务失败：${body.message || `HTTP ${response.status}`}`)
  }
}
