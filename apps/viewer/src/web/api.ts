export async function api(path: string, init?: RequestInit) {
  const response = await fetch('/api/' + path, init)
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '请求失败')
  return data
}
export function post(path: string, data: unknown) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
}
