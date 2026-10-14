export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}
export async function api(path: string, init?: RequestInit) {
  const response = await fetch('/api/' + path, init)
  const text = await response.text()
  let data: { error?: string }
  try {
    data = text ? JSON.parse(text) : {}
  } catch {
    throw new ApiError(response.status, '服务返回了空响应，请刷新页面后重试')
  }
  if (!response.ok) throw new ApiError(response.status, data.error || '请求失败')
  return data
}
export function post(path: string, data: unknown) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}
