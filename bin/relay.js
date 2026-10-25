#!/usr/bin/env bare
import 'bare-process/global'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { request } from 'node:http'
import { join } from 'node:path'
import os from 'node:os'
import { createNode } from '../src/index.js'
import { createLan } from '../src/lan.js'
import { createAcquirer } from '../src/acquire.js'
import { createApi } from '../src/http.js'
import { createMirrorHost } from '../src/mirror.js'
import { createCastController } from '../src/cast.js'
import { lanAddress } from '../src/lan.js'

const env = process.env

// Keep a VPN-configured seeder off the public overlay if its tunnel drops.
// OpenVPN can leave the host default route behind while its split /1 routes go.
function vpnRouteActive () {
  try {
    const routes = readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1).map(line => {
      const [iface, destination, , flags, , , metric, mask] = line.trim().split(/\s+/)
      let prefix = 0
      for (let bits = Number.parseInt(mask, 16) >>> 0; bits; bits &= bits - 1) prefix++
      return { iface, destination: Number.parseInt(destination, 16) >>> 0, flags: Number.parseInt(flags, 16), metric: Number(metric), mask: Number.parseInt(mask, 16) >>> 0, prefix }
    })
    return [0x01010101, 0x01010181].every(address => {
      let selected = null
      for (const route of routes) {
        if (!(route.flags & 1) || (address & route.mask) !== (route.destination & route.mask)) continue
        if (!selected || route.prefix > selected.prefix || (route.prefix === selected.prefix && route.metric < selected.metric)) selected = route
      }
      return selected?.iface === 'tun0'
    })
  } catch {
    return false
  }
}

if (env.VPN_SERVICE_PROVIDER) {
  for (let i = 0; i < 60 && !vpnRouteActive(); i++) await new Promise(resolve => setTimeout(resolve, 1000))
  if (!vpnRouteActive()) throw new Error('VPN routing unavailable; refusing to seed over the host network')
  setInterval(() => {
    if (!vpnRouteActive()) {
      console.error('VPN routing lost; stopping the seeder before it uses the host network')
      process.exit(1)
    }
  }, 2000).unref?.()
}
const storage = env.PEARTUBE_STORAGE || './peartube-data'
mkdirSync(storage, { recursive: true, mode: 0o700 })
const jobsFile = join(storage, 'jobs.json')
const sourcesFile = join(storage, 'sources.json')
function loadSavedSources () {
  const saved = (() => { try { return JSON.parse(readFileSync(sourcesFile, 'utf8')) } catch { return [] } })()
  const fromEnv = env.PEARTUBE_SOURCES ? env.PEARTUBE_SOURCES.split(',').map(s => s.trim()).filter(Boolean) : []
  return [...saved, ...fromEnv]
}
const isDirectory = Boolean(env.PEARTUBE_DIRECTORY)
async function syncDirectory (list) {
  if (!isDirectory || !state.node) return
  const published = new Set((await state.node.publishedSources()).map(p => p.key))
  for (const s of list) {
    if (s.primary || published.has(s.key)) continue
    await state.node.publishSource({ sourceKey: s.key, kind: s.kind, title: s.alias || s.key.slice(0, 12) }, { target: 'both' }).catch(() => {})
  }
}
function saveSources (list) {
  const keep = list.filter(s => !s.primary && !s.writable).map(({ key, kind, alias }) => ({ key, kind, alias }))
  writeFileSync(sourcesFile + '.tmp', JSON.stringify(keep), { mode: 0o600 })
  renameSync(sourcesFile + '.tmp', sourcesFile)
  syncDirectory(list).catch(() => {})
}
const emptyRoute = () => ({ peers: 0, rxBytes: 0, txBytes: 0, downBps: 0, upBps: 0 })
const state = {
  node: null,
  acquirer: null,
  mirror: null,
  cast: null,
  apiToken: env.PEARTUBE_API_TOKEN || null,
  onSourcesChanged: saveSources,
  fallbackStatus: { tracker: env.PEARTUBE_TRACKER || '', channel: '', writer: '', blobs: '', blobBytes: 0, cachedBytes: 0, peers: 0, lanPeers: 0, downBps: 0, upBps: 0, rxBytes: 0, txBytes: 0, routes: { private: emptyRoute(), public: emptyRoute(), lan: emptyRoute() }, inflightBlocks: 0, rtt: 0, retransmits: 0, sources: [], reciprocity: { tier: 'leecher', seededBytes: 0, contributingPeers: 0, ratio: 0, inflightMax: 64 } },
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
  await state.mirror?.close().catch(() => {})
  await state.node?.close().catch(() => {})
  await state.cast?.close().catch(() => {})
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
  sources: loadSavedSources(),
  allowedPeers: env.PEARTUBE_ALLOWED_PEERS ? env.PEARTUBE_ALLOWED_PEERS.split(',').map(s => s.trim()).filter(Boolean) : null,
  streamHost: env.PEARTUBE_STREAM_HOST || '127.0.0.1',
  streamPort: Number(env.PEARTUBE_STREAM_PORT || 8175),
  bootstrap: env.PEARTUBE_BOOTSTRAP ? env.PEARTUBE_BOOTSTRAP.split(',') : undefined,
  dhtPort,
  privateRouting: Boolean(env.PEARTUBE_PRIVATE_ROUTING),
  privateRelay: env.PEARTUBE_PRIVATE_RELAY_PORT ? Number(env.PEARTUBE_PRIVATE_RELAY_PORT) : Boolean(env.PEARTUBE_PRIVATE_RELAY),
  relayThrough: env.PEARTUBE_RELAY_THROUGH ? env.PEARTUBE_RELAY_THROUGH.split(',') : null,
  lan: env.PEARTUBE_LAN_HOST ? keyPair => createLan({ host: env.PEARTUBE_LAN_HOST, port: Number(env.PEARTUBE_LAN_PORT || 49799), keyPair }) : null,
  onchange: () => api.notify('update')
})
state.node = node
if (isDirectory) await syncDirectory(node.listSources())
const mirrorChannel = env.PEARTUBE_PUBLISH_CHANNEL ? env.PEARTUBE_PUBLISH_CHANNEL !== '0' : true
state.acquirer = createAcquirer(node, jobsFile, { defaultChannel: mirrorChannel, onDone: () => api.notify('update') })
state.mirror = await createMirrorHost({
  node,
  storage,
  acquirer: state.acquirer,
  mirrorChannel,
  watchDir: env.PEARTUBE_WATCH_DIR || null,
  feeds: env.PEARTUBE_MIRROR_FEEDS ? env.PEARTUBE_MIRROR_FEEDS.split(',').map(s => s.trim()).filter(Boolean) : [],
  pluginsDir: env.PEARTUBE_PLUGINS_DIR || join(storage, 'plugins'),
  onchange: () => api.notify('update')
})
state.cast = createCastController({
  storage,
  getNode: () => state.node,
  getLanHost: () => env.PEARTUBE_LAN_HOST || lanAddress(os.networkInterfaces()),
  onchange: () => api.notify('cast')
})
await state.cast.setLanHost(env.PEARTUBE_LAN_HOST || lanAddress(os.networkInterfaces())).catch(() => {})

console.log(JSON.stringify({ msg: 'relay ready', api: apiPort, ...node.status() }))
setInterval(() => console.log(JSON.stringify({ msg: 'heartbeat', ...node.status() })), 60_000).unref()

if (env.PEARTUBE_PRIVATE_RELAY && !env.PEARTUBE_DHT_PORT) {
  setInterval(async () => {
    const port = await readForwardedPort()
    if (port > 0 && port !== dhtPort) await shutdown()
  }, 15_000).unref()
}
