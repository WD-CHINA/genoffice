import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { lanHosts, listenUrls, originAllowed } from '../src/server/lan.ts'

test('keeps loopback origins on other ports blocked', () => {
  assert.equal(originAllowed('http://127.0.0.1:9999', '127.0.0.1:3001'), false)
  assert.equal(originAllowed('http://203.0.113.10:5180', '127.0.0.1:3001'), false)
  assert.equal(originAllowed('http://127.0.0.1:3001', '127.0.0.1:3001'), true)
  assert.equal(originAllowed('http://127.0.0.1:5180', '127.0.0.1:3001'), true)
})

test('allows this machine LAN address and advertises it', () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal)
  assert.deepEqual(listenUrls('127.0.0.1', 3001), ['http://127.0.0.1:3001'])
  if (!lan) return
  assert.ok(lanHosts().includes(lan.address))
  assert.equal(originAllowed(`http://${lan.address}:5180`, '127.0.0.1:3001'), true)
  assert.ok(listenUrls('0.0.0.0', 3001).includes(`http://${lan.address}:3001`))
})

test('accepts a request sent to the LAN address', async () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((entry) => entry?.family === 'IPv4' && !entry.internal)
  if (!lan) return
  const server = createServer((req, res) => {
    res.end(req.headers.host)
  })
  await new Promise<void>((resolve) => server.listen(0, '0.0.0.0', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    const response = await fetch(`http://${lan.address}:${address.port}/`)
    assert.equal(response.status, 200)
    assert.equal(await response.text(), `${lan.address}:${address.port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
