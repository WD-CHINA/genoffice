import assert from 'node:assert/strict'
import { test } from 'node:test'
import { uploadFile } from '../src/web/upload-file'

test('remote Word asks for a password, retries wrong passwords and preserves UTF-8', async () => {
  const original = globalThis.fetch,
    file = new Blob(['encrypted Office container'])
  const requests: RequestInit[] = [],
    answers = ['wrong', '中文密码🔐'],
    alerts: string[] = []
  globalThis.fetch = async (_url, init) => {
    requests.push(init!)
    return requests.length === 1
      ? Response.json({ code: 'encrypted_document' }, { status: 415 })
      : requests.length === 2
        ? Response.json({ code: 'wrong_password' }, { status: 422 })
        : Response.json({ fileId: 'plain-content-hash' }, { status: 201 })
  }
  try {
    assert.deepEqual(
      await uploadFile('http://test', file, 'docx', 'token', {
        prompt: () => answers.shift()!,
        alert: (message) => alerts.push(message),
      }),
      { fileId: 'plain-content-hash' },
    )
    assert.equal(alerts.length, 1)
    assert(requests.every((request) => request.body === file))
    assert.equal((requests[0].headers as Record<string, string>)['X-Office-Password'], undefined)
    assert.equal(
      Buffer.from(
        (requests[2].headers as Record<string, string>)['X-Office-Password'],
        'base64',
      ).toString('utf8'),
      '中文密码🔐',
    )
    assert.equal((requests[2].headers as Record<string, string>).Authorization, 'Bearer token')
  } finally {
    globalThis.fetch = original
  }
})

test('cancelling remote password input stops uploading', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return Response.json({ code: 'encrypted_document' }, { status: 415 })
  }
  try {
    await assert.rejects(
      uploadFile('http://test', new Blob(), 'docx', '', { prompt: () => null, alert: () => {} }),
      /已取消密码输入/,
    )
    assert.equal(calls, 1)
  } finally {
    globalThis.fetch = original
  }
})

test('older service rejects explicitly instead of prompting forever; auth failures never prompt', async () => {
  const original = globalThis.fetch
  let prompts = 0
  const dialogs = {
    prompt: () => {
      prompts++
      return 'password'
    },
    alert: () => {},
  }
  try {
    globalThis.fetch = async () => Response.json({ code: 'encrypted_document' }, { status: 415 })
    await assert.rejects(
      uploadFile('http://test', new Blob(), 'docx', '', dialogs),
      /请更新解析服务/,
    )
    assert.equal(prompts, 1)
    globalThis.fetch = async () =>
      Response.json({ code: 'unauthorized', message: 'unauthorized' }, { status: 401 })
    await assert.rejects(uploadFile('http://test', new Blob(), 'docx', '', dialogs), /unauthorized/)
    assert.equal(prompts, 1)
  } finally {
    globalThis.fetch = original
  }
})
