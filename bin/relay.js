#!/usr/bin/env bare
import 'bare-process/global'
import { mkdirSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import os from 'node:os'
import { createNode } from '../src/index.js'
import { createLan } from '../src/lan.js'
import { createAcquirer } from '../src/acquire.js'
import { createApi } from '../src/http.js'

const env = process.env
const storage = env.PEARTUBE_STORAGE || './peartube-data'
mkdirSync(storage, { recursive: true, mode: 0o700 })
const jobsFile = join(storage, 'jobs.json')
const state = {
  node: null,
  acquirer: null,
  fallbackStatus: { tracker: env.PEARTUBE_TRACKER || '', writer: '', blobs: '', blobBytes: 0, peers: 0, lanPeers: 0 },
  fallbackJobs () {
    try { return JSON.parse(readFileSync(jobsFile, 'utf8')).map(({ source, announce, ...j }) => j) } catch { return [] }
  }
}
const api = createApi(state)
const apiPort = Number(env.PEARTUBE_API_PORT || 8174)
api.listen(apiPort, env.PEARTUBE_API_HOST || '0.0.0.0')

let shuttingDown = false
async function shutdown () {
  if (shuttingDown) return
  shuttingDown = true
  const kill = () => { try { os.kill?.(process.pid, 9) } catch {} process.exit(0) }
  setTimeout(kill, 3000).unref()
  api.close()
  await state.node?.close().catch(() => {})
  kill()
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, shutdown)
}

function readForwardedPort () {
  try {
    const p = Number(readFileSync('/tmp/gluetun/forwarded_port', 'utf8').trim())
    if (p > 0) return Promise.resolve(p)
  } catch {}
  return new Promise(resolve => {
    const req = request('http://127.0.0.1:8000/v1/portforward', res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => { try { resolve(Number(JSON.parse(data).port) || 0) } catch { resolve(0) } })
    })
    req.on('error', () => resolve(0))
    req.end()
  })
}

const stagger = env.PEARTUBE_LAN_HOST ? Math.max(0, (Number(env.PEARTUBE_LAN_HOST.split('.')[3]) - 111) * 3000) : 0
if (stagger > 0) await new Promise(resolve => setTimeout(resolve, stagger))

let dhtPort = env.PEARTUBE_DHT_PORT ? Number(env.PEARTUBE_DHT_PORT) : undefined
if (!dhtPort && env.PEARTUBE_PRIVATE_RELAY) {
  for (let i = 0; i < 15 && !dhtPort; i++) {
    const port = await readForwardedPort()
    if (port > 0) { dhtPort = port; break }
    if (!env.VPN_SERVICE_PROVIDER && i >= 5) break
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

const node = await createNode({
  storage,
  tracker: env.PEARTUBE_TRACKER || null,
  streamHost: env.PEARTUBE_STREAM_HOST || '127.0.0.1',
  streamPort: Number(env.PEARTUBE_STREAM_PORT || 8175),
  bootstrap: env.PEARTUBE_BOOTSTRAP ? env.PEARTUBE_BOOTSTRAP.split(',') : undefined,
  dhtPort,
  privateRouting: Boolean(env.PEARTUBE_PRIVATE_ROUTING),
  privateRelay: env.PEARTUBE_PRIVATE_RELAY_PORT ? Number(env.PEARTUBE_PRIVATE_RELAY_PORT) : Boolean(env.PEARTUBE_PRIVATE_RELAY),
  relayThrough: env.PEARTUBE_RELAY_THROUGH ? env.PEARTUBE_RELAY_THROUGH.split(',') : null,
  lan: env.PEARTUBE_LAN_HOST ? keyPair => createLan({ host: env.PEARTUBE_LAN_HOST, port: Number(env.PEARTUBE_LAN_PORT || 49799), keyPair }) : null
})
state.node = node
state.acquirer = createAcquirer(node, jobsFile)

console.log(JSON.stringify({ msg: 'relay ready', api: apiPort, ...node.status() }))
setInterval(() => console.log(JSON.stringify({ msg: 'heartbeat', ...node.status() })), 60_000).unref()

if (env.PEARTUBE_PRIVATE_RELAY && !env.PEARTUBE_DHT_PORT) {
  setInterval(async () => {
    const port = await readForwardedPort()
    if (port > 0 && port !== dhtPort) await shutdown()
  }, 15_000).unref()
}
