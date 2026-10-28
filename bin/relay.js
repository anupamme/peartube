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
import { createSettings } from '../src/settings.js'
import { identify, posterUrl } from '../src/identify.js'

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

if (env.PEARTUBE_PRIVATE_RELAY || env.PEARTUBE_PRIVATE_RELAY_PORT) {
  if (env.PEARTUBE_TRACKER || env.PEARTUBE_SOURCES || env.PEARTUBE_PRIVATE_ROUTING || env.PEARTUBE_REPLICATE || env.PEARTUBE_WATCH_DIR || env.PEARTUBE_MIRROR_FEEDS) {
    throw new Error('PEARTUBE_PRIVATE_RELAY runs a standalone Corestore-free guard forwarder and cannot be combined with tracker or content flags; run peartube-private-relay separately')
  }
  let guardPort = Number(env.PEARTUBE_PRIVATE_RELAY_PORT || env.PEARTUBE_DHT_PORT || 0)
  if (!guardPort) {
    for (let i = 0; i < 15 && !guardPort; i++) {
      const p = await readForwardedPort()
      if (p > 0) { guardPort = p; break }
      if (!env.VPN_SERVICE_PROVIDER && i >= 5) break
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
  const { createPrivateGuard } = await import('../src/private-overlay.js')
  const bootstrap = env.PEARTUBE_BOOTSTRAP
    ? env.PEARTUBE_BOOTSTRAP.split(',').map(s => {
        const i = s.trim().lastIndexOf(':')
        return i > 0 ? { host: s.trim().slice(0, i), port: Number(s.trim().slice(i + 1)) } : s.trim()
      }).filter(Boolean)
    : undefined
  const guard = await createPrivateGuard({ host: env.PEARTUBE_PRIVATE_HOST || undefined, port: guardPort, bootstrap })
  const addr = guard.address()
  console.log(JSON.stringify({ msg: 'private-guard ready', publicKey: Buffer.from(guard.publicKey).toString('hex'), host: addr?.host || '0.0.0.0', port: addr?.port || guardPort }))
  const hb = setInterval(() => console.log(JSON.stringify({ msg: 'private-guard heartbeat', publicKey: Buffer.from(guard.publicKey).toString('hex'), ...guard.stats() })), 60_000)
  hb.unref?.()
  const stopGuard = async () => {
    clearInterval(hb)
    setTimeout(() => process.exit(0), 2000).unref?.()
    await guard.close().catch(() => {})
    process.exit(0)
  }
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, stopGuard)
  if (!env.PEARTUBE_DHT_PORT && !env.PEARTUBE_PRIVATE_RELAY_PORT) {
    setInterval(async () => {
      const p = await readForwardedPort()
      if (p > 0 && p !== guardPort) await stopGuard()
    }, 15_000).unref?.()
  }
  await new Promise(() => {})
}
const storage = env.PEARTUBE_STORAGE || './peartube-data'
mkdirSync(storage, { recursive: true, mode: 0o700 })
// Everything below reads settings: an env var wins, then settings.json (set from the UI), then the default.
const settings = createSettings(storage, env)
const cfg = settings.get
const jobsFile = join(storage, 'jobs.json')
const sourcesFile = join(storage, 'sources.json')
function loadSavedSources () {
  const saved = (() => { try { return JSON.parse(readFileSync(sourcesFile, 'utf8')) } catch { return [] } })()
  const fromEnv = env.PEARTUBE_SOURCES ? env.PEARTUBE_SOURCES.split(',').map(s => s.trim()).filter(Boolean) : []
  return [...saved, ...fromEnv]
}
const isDirectory = cfg('directory')
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
  settings,
  identify: link => identify(link, { cinemetaUrl: cfg('cinemetaUrl') }),
  posterUrl: imdb => posterUrl(cfg('cinemetaUrl'), imdb),
  onSourcesChanged: saveSources,
  fallbackStatus: { tracker: cfg('tracker'), channel: '', writer: '', blobs: '', blobBytes: 0, cachedBytes: 0, peers: 0, lanPeers: 0, downBps: 0, upBps: 0, rxBytes: 0, txBytes: 0, routes: { private: emptyRoute(), public: emptyRoute(), lan: emptyRoute() }, inflightBlocks: 0, rtt: 0, retransmits: 0, sources: [], reciprocity: { tier: 'leecher', seededBytes: 0, contributingPeers: 0, ratio: 0, inflightMax: 64 } },
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

const stagger = env.PEARTUBE_LAN_HOST ? Math.max(0, (Number(env.PEARTUBE_LAN_HOST.split('.')[3]) - 111) * 3000) : 0
if (stagger > 0) await new Promise(resolve => setTimeout(resolve, stagger))
const dhtPort = cfg('dhtPort') || undefined
const list = value => value.length ? value : null
const replicateValue = () => cfg('replicate') ? (cfg('replicateSources').length ? cfg('replicateSources') : true) : false
const lanHost = () => cfg('lanHost') || lanAddress(os.networkInterfaces())
// LAN discovery is a live setting: on with an address, off without one.
function lanFactory () {
  const host = cfg('lan') ? lanHost() : null
  return host ? keyPair => createLan({ host, keyPair }) : null
}

const replicateOpt = replicateValue()
const hiverelayOpt = {
  relays: cfg('hiverelays').join(','),
  apiKey: cfg('hiverelayApiKey') || null,
  discover: cfg('hiverelayDiscover') || env.PEARTUBE_HIVERELAY === '1' || env.PEARTUBE_HIVERELAY === 'true',
  replicas: cfg('hiverelayReplicas'),
  includeCached: Boolean(replicateOpt),
  uploadMbps: Math.max(0, cfg('hiverelayUploadMbps'))
}
const hiverelayEnabled = Boolean(hiverelayOpt.relays || hiverelayOpt.discover)
let replicateDebounce = null
function scheduleReplicate () {
  if ((!cfg('replicate') && !hiverelayEnabled) || shuttingDown || replicateDebounce) return
  replicateDebounce = setTimeout(() => {
    replicateDebounce = null
    if (shuttingDown) return
    if (cfg('replicate')) state.mirror?.run('p2p-replicate').catch(() => {})
    if (hiverelayEnabled) state.mirror?.run('hiverelay-seed').catch(() => {})
  }, 2000)
  replicateDebounce.unref?.()
}
const node = await createNode({
  storage,
  tracker: cfg('tracker') || null,
  sources: loadSavedSources(),
  allowedPeers: list(cfg('allowedPeers')),
  streamHost: cfg('streamHost'),
  streamPort: cfg('streamPort'),
  bootstrap: list(cfg('bootstrap')) || undefined,
  dhtPort,
  privateRouting: cfg('privateRouting'),
  privateRelay: false,
  relayThrough: list(cfg('relayThrough')),
  lan: lanFactory(),
  onchange: () => {
    api.notify('update')
    scheduleReplicate()
  }
})
state.node = node
// A relay started without a tracker founds its own, keyed by its writer. Saved sources would otherwise replace it as
// the primary catalog on the next start (createNode only keeps its own tracker when told the key), hiding its library.
if (!cfg('tracker')) {
  const { tracker, writer } = node.status()
  if (tracker === writer) settings.remember('tracker', writer)
  // Followed something before this fix: the founded tracker comes back after a restart, which the UI asks for.
  else settings.update({ tracker: writer })
}
if (isDirectory) await syncDirectory(node.listSources())
const mirrorChannel = cfg('publishChannel')
state.acquirer = createAcquirer(node, jobsFile, {
  concurrency: cfg('acquireConcurrency'),
  defaultChannel: mirrorChannel,
  onDone: () => {
    api.notify('update')
    scheduleReplicate()
  }
})
const mirrorConfig = () => ({
  watchDir: cfg('watchDir') || null,
  feeds: cfg('feeds'),
  replicate: replicateValue(),
  replicateMinFreeBytes: Math.max(0, cfg('replicateFreeGb')) * 1024 * 1024 * 1024,
  replicateMbps: Math.max(0, cfg('replicateMbps'))
})
state.mirror = await createMirrorHost({
  node,
  storage,
  acquirer: state.acquirer,
  mirrorChannel,
  rechunk: cfg('rechunk'),
  ...mirrorConfig(),
  hiverelay: hiverelayOpt,
  pluginsDir: env.PEARTUBE_PLUGINS_DIR || join(storage, 'plugins'),
  onchange: () => api.notify('update')
})
state.cast = createCastController({
  storage,
  getNode: () => state.node,
  getLanHost: lanHost,
  onchange: () => api.notify('cast')
})
await state.cast.setLanHost(lanHost()).catch(() => {})
state.extraStatus = () => ({ lan: node.lanEndpoint() ? { host: node.lanEndpoint().host, port: node.lanEndpoint().port } : null, privateRouting: node.privateRouting })
// Live settings apply here; the rest wait for a restart (the settings view lists them in `restartNeeded`).
state.applySettings = async changed => {
  const has = (...keys) => keys.some(k => changed.includes(k))
  if (has('allowedPeers')) node.setAllowedPeers(list(cfg('allowedPeers')))
  if (has('watchDir', 'feeds', 'replicate', 'replicateSources', 'replicateFreeGb', 'replicateMbps')) state.mirror.configure(mirrorConfig())
  if (has('lan', 'lanHost')) {
    await state.cast.setLanHost(lanHost()).catch(() => {})
    await node.setLan(lanFactory())
  }
  api.notify('update')
}
console.log(JSON.stringify({ msg: 'relay ready', api: apiPort, ...node.status() }))
setInterval(() => console.log(JSON.stringify({ msg: 'heartbeat', ...node.status() })), 60_000).unref()
