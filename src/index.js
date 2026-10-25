import Autobee from 'autobee'
import Hyperbee from 'hyperbee2'
import ProtomuxWakeup from 'protomux-wakeup'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import HyperDHT from 'hyperdht'
import Hyperblobs from 'hyperblobs'
import BlobServer from 'hypercore-blob-server'
import b4a from 'b4a'
import { createHash } from 'node:crypto'
import { pipelinePromise, Transform } from 'streamx'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tuneUdxSocket } from './lan.js'
const ID = /^[a-z0-9]+:[a-z0-9]+(:s\d{2}e\d{2,3})?$/
const HEX64 = /^[0-9a-f]{64}$/
const MAX_TITLE = 300
const BLOB_BLOCK_SIZE = 512 * 1024
const MAX_CONTENT_TOPICS = 24

// Every peer value is untrusted until decodeOp blesses it; typeof guards every regex.
const str = (v, re) => typeof v === 'string' && re.test(v)
const cleanText = (v, fallback = '') => String(v || fallback).slice(0, MAX_TITLE).toWellFormed()
const parseQuery = raw => {
  const out = {}
  if (!raw) return out
  for (const part of raw.split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = eq === -1 ? part : part.slice(0, eq)
    const v = eq === -1 ? '' : part.slice(eq + 1)
    try { out[decodeURIComponent(k)] = decodeURIComponent(v.replace(/\+/g, ' ')) } catch { out[k] = v }
  }
  return out
}

// Formats a zero-subscription magnet URI so any client can stream a blob swarm on sight.
export function formatWatchUri (entry, source = '', sourceKind = '') {
  const b = entry.blob || {}
  const q = [`id=${encodeURIComponent(entry.id)}`, `title=${encodeURIComponent(cleanText(entry.title, entry.id))}`]
  if (str(entry.sha256, HEX64)) q.push(`sha256=${entry.sha256}`)
  if (str(source, HEX64)) {
    q.push(`source=${source}`)
    if (sourceKind === 'channel' || sourceKind === 'tracker') q.push(`kind=${sourceKind}`)
  }
  return `peartube://watch/${entry.blobs}:${b.blockOffset}:${b.blockLength}:${b.byteOffset}:${b.byteLength}?${q.join('&')}`
}

// Strips peartube:// links and raw 64-hex keys down to an actionable source or instant watch payload.
export function parseUri (input, defaultKind = 'tracker') {
  if (typeof input !== 'string') throw new Error('URI or 64-hex key required')
  const raw = input.trim()
  const lower = raw.toLowerCase()
  if (HEX64.test(lower)) return { action: 'source', key: lower, kind: defaultKind === 'channel' ? 'channel' : 'tracker', alias: '' }
  const m = raw.match(/^peartube:(?:\/\/)?([a-z]+)\/([^?#]+)(?:\?([^#]*))?/i)
  if (!m) throw new Error('Invalid PearTube URI or 64-hex key')
  const verb = m[1].toLowerCase()
  const body = m[2].trim()
  const q = parseQuery(m[3] || '')
  if (verb === 'channel' || verb === 'tracker' || verb === 'add' || verb === 'source') {
    const key = body.toLowerCase()
    if (!HEX64.test(key)) throw new Error('Source key must be 64 hex characters')
    const kind = verb === 'channel' ? 'channel' : verb === 'tracker' ? 'tracker' : (q.kind === 'channel' ? 'channel' : 'tracker')
    return { action: 'source', key, kind, alias: cleanText(q.name || q.alias || '') }
  }
  if (verb === 'watch') {
    const parts = body.split(':')
    if (parts.length !== 5 || !HEX64.test(parts[0].toLowerCase())) throw new Error('Malformed peartube://watch blob pointer')
    const blobs = parts[0].toLowerCase()
    const [blockOffset, blockLength, byteOffset, byteLength] = parts.slice(1).map(Number)
    if (![blockOffset, blockLength, byteOffset, byteLength].every(n => Number.isSafeInteger(n) && n >= 0) || blockLength <= 0) {
      throw new Error('Malformed peartube://watch block bounds')
    }
    const sha256 = q.sha256 && HEX64.test(q.sha256.toLowerCase()) ? q.sha256.toLowerCase() : ( '0'.repeat(64) )
    const fallbackId = `clip:${(q.sha256 || blobs).toLowerCase().slice(0, 12)}`
    const id = str(q.id?.toLowerCase(), ID) ? q.id.toLowerCase() : fallbackId
    const title = cleanText(q.title, id)
    const sourceKey = q.source && HEX64.test(q.source.toLowerCase()) ? q.source.toLowerCase() : null
    const sourceKind = q.kind === 'tracker' ? 'tracker' : 'channel'
    return {
      action: 'watch',
      sourceKey,
      sourceKind,
      entry: { type: 'announce', id, title, size: byteLength, sha256, blobs, blob: { blockOffset, blockLength, byteOffset, byteLength } }
    }
  }
  throw new Error(`Unsupported PearTube URI action: ${verb}`)
}

export function decodeOp (value) {
  let op
  try { op = JSON.parse(typeof value === 'string' ? value : b4a.toString(value)) } catch { return null }
  if (op === null || typeof op !== 'object') return null
  if (op.type === 'remove') return typeof op.key === 'string' ? op : null
  if (op.type === 'peer') return str(op.publicKey, HEX64) && Number.isSafeInteger(op.expiresAt) && op.expiresAt > 0 ? op : null
  if (op.type === 'source') {
    if (!str(op.sourceKey, HEX64) || (op.kind !== 'tracker' && op.kind !== 'channel')) return null
    if (typeof op.title !== 'string' || op.title.length === 0 || op.title.length > MAX_TITLE) return null
    return op
  }
  if (op.type !== 'announce' || !str(op.id, ID) || !str(op.blobs, HEX64) || !str(op.sha256, HEX64)) return null
  if (typeof op.title !== 'string' || op.title.length > MAX_TITLE || !Number.isSafeInteger(op.size) || op.size < 0) return null
  const { blockOffset, blockLength, byteOffset, byteLength } = op.blob || {}
  if (![blockOffset, blockLength, byteOffset, byteLength].every(n => Number.isSafeInteger(n) && n >= 0)) return null
  return op
}

// Deterministic multi-writer gate: each writer may file or delete only under its own hex key.
async function apply (nodes, view, host) {
  for (const node of nodes) {
    const op = decodeOp(node.value)
    if (!op) continue
    await host.addWriter(node.key, { isIndexer: false })
    const writer = b4a.toString(node.key, 'hex')
    const w = view.write()
    if (op.type === 'remove') {
      if (op.key.split('/')[1] === writer) w.tryDelete(b4a.from(op.key))
    } else if (op.type === 'peer') {
      w.tryPut(b4a.from(`peer/${writer}`), node.value)
    } else if (op.type === 'source') {
      w.tryPut(b4a.from(`source/${writer}/${op.sourceKey}`), node.value)
    } else {
      w.tryPut(b4a.from(`${op.id}/${writer}/${op.blobs}:${op.blob.blockOffset}`), node.value)
    }
    await w.flush()
  }
}

export async function createNode ({
  storage,
  tracker: trackerKey = null,
  sources: initialSources = [],
  allowedPeers = null,
  streamHost = '127.0.0.1',
  streamPort = 0,
  bootstrap,
  privateHost = null,
  dhtPort,
  privateRouting = false,
  privateRelay = false,
  relayThrough = null,
  lan: createLan = null,
  onchange = null
}) {
  const store = new Corestore(join(storage, 'corestore'))
  const wakeup = new ProtomuxWakeup()
  let onPeersChanged = null
  let viewEpoch = 1
  const update = () => {
    viewEpoch++
    if (onchange) queueMicrotask(onchange)
    if (onPeersChanged) queueMicrotask(onPeersChanged)
  }
  // fastForward: false forces every peer to verify writer namespaces locally through apply.
  const tracker = new Autobee(store.namespace('tracker'), trackerKey && b4a.from(trackerKey, 'hex'), { apply, update, optimistic: true, fastForward: false, wakeup })
  await tracker.ready()
  let inflightRange = [48, 128]
  store.watch(core => core.replicator.setInflightRange(inflightRange[0], inflightRange[1]))
  const usePrimaryTracker = Boolean(trackerKey) || initialSources.length === 0
  if (!trackerKey && usePrimaryTracker && tracker.local.length === 0) {
    await tracker.append(b4a.from(JSON.stringify({ type: 'init' })))
    await tracker.updated()
  }
  const primaryKey = b4a.toString(tracker.key, 'hex')

  // Every node also owns an unforgeable single-writer Hyperbee channel; strangers can read & seed, never append.
  const localChannel = new Hyperbee(store.namespace('channel'), { writable: true, autoUpdate: false })
  await localChannel.ready()
  const channelKey = b4a.toString(localChannel.core.key, 'hex')
  let channelQueue = Promise.resolve()
  const withChannelLock = fn => {
    const next = channelQueue.then(fn, fn)
    channelQueue = next.catch(() => {})
    return next
  }

  const blobSlots = []
  async function openSlot (i) {
    const core = store.get({ name: i === 0 ? 'blobs' : `blobs-${i}` })
    await core.ready()
    const slot = { core, blobs: new Hyperblobs(core, { blockSize: BLOB_BLOCK_SIZE }), key: b4a.toString(core.key, 'hex'), busy: false }
    blobSlots.push(slot)
    return slot
  }
  for (let i = 0; i < 4; i++) await openSlot(i)
  for (let i = 4; i < 64; i++) {
    const core = store.get({ name: `blobs-${i}` })
    await core.ready()
    if (core.length === 0) { await core.close(); break }
    blobSlots.push({ core, blobs: new Hyperblobs(core, { blockSize: BLOB_BLOCK_SIZE }), key: b4a.toString(core.key, 'hex'), busy: false })
  }
  const blobsKey = blobSlots[0].key
  const blobCores = new Map(blobSlots.map(s => [s.key, s.core]))

  const host = privateHost ?? (Array.isArray(bootstrap) && bootstrap.some(b => String(b?.host || b).startsWith('127.')) ? '127.0.0.1' : undefined)
  const privateOpts = relay => ({ release: 'alpha', acknowledgeAlpha: true, mode: 'optional', profile: 'spliced', relay })
  const writerSecret = privateRelay ? tracker.local.keyPair?.secretKey : null
  if (privateRelay && !writerSecret) throw new Error('Private relay requires a local writer secret')
  const dhtRelay = privateRelay ? new HyperDHT({ host, bootstrap, seed: createHash('sha256').update('peartube/private-relay/v1').update(writerSecret).digest(), port: typeof privateRelay === 'number' ? privateRelay : (dhtPort || [0, 0]), ephemeral: false, firewalled: false, privateRouting: privateOpts(true) }) : null
  const dht = privateRouting ? new HyperDHT({ host, bootstrap, port: dhtRelay ? [0, 0] : (dhtPort || [0, 0]), privateRouting: typeof privateRouting === 'object' ? privateRouting : privateOpts(false) }) : null
  let closing = false
  if (host) {
    if (dhtRelay) await dhtRelay.privateRouting.ready()
    if (dht) await dht.privateRouting.ready()
  } else {
    if (dhtRelay) { dhtRelay.validateLocalAddresses = async () => []; dhtRelay.privateRouting.ready().catch(() => {}) }
    if (dht) { dht.validateLocalAddresses = async () => []; dht.privateRouting.ready().catch(() => {}) }
  }
  if (dht) {
    const descriptors = dht.plugins.get('private-route')?.storage?.service
    const resetCache = () => { if (descriptors) { descriptors.directoryExpiresAt = 0; descriptors.storage.bootstrapExpiresAt = 0 } }
    const retryListen = async fn => {
      for (;;) {
        try { return await fn() } catch (err) {
          if (closing || err?.code !== 'ERR_PRIVACY_UNAVAILABLE') throw err
          resetCache()
          await new Promise(resolve => setTimeout(resolve, 500))
        }
      }
    }
    const dhtResume = dht.resume.bind(dht)
    dht.resume = async opts => {
      resetCache()
      try { await dhtResume(opts) } catch (err) {
        if (err?.code !== 'ERR_PRIVACY_UNAVAILABLE') throw err
      }
    }
    dht.createServer = (opts, onconnection) => {
      const s = dht.privateRouting.createServer(opts, onconnection)
      const listen = s.listen.bind(s)
      s.listen = keyPair => retryListen(() => { s._listening = null; return listen(keyPair) })
      const resume = s.resume.bind(s)
      s.resume = () => { if (s._keyPair) retryListen(resume).catch(() => {}) }
      return s
    }
    dht.connect = (publicKey, opts) => {
      if (descriptors && descriptors.directory.length < 4) resetCache()
      const conn = dht.privateRouting.connect(publicKey, opts)
      conn.once('close', () => { if (!conn.rawBytesRead) resetCache() })
      return conn
    }
  }

  let allowedSet = Array.isArray(allowedPeers) && allowedPeers.length ? new Set(allowedPeers.map(k => String(k).toLowerCase())) : null
  const lanPeers = new Set()
  const hasLanPeer = keyBuf => Boolean(keyBuf && [...lanPeers].some(c => !c.destroyed && c.remotePublicKey && b4a.equals(c.remotePublicKey, keyBuf)))
  const firewall = remotePublicKey => (allowedSet ? !allowedSet.has(b4a.toString(remotePublicKey, 'hex')) : false) || hasLanPeer(remotePublicKey)
  const bucket = () => ({ closedRx: 0, closedTx: 0, prevRx: 0, prevTx: 0, downBps: 0, upBps: 0 })
  const traffic = { private: bucket(), public: bucket(), lan: bucket() }
  let prevRx = 0, prevTx = 0, prevAt = Date.now(), downBps = 0, upBps = 0
  const tuneDht = inst => inst?.ready?.().then(() => { tuneUdxSocket(inst.io?.serverSocket); tuneUdxSocket(inst.io?.clientSocket) }).catch(() => {})
  const trackConn = (conn, path) => {
    tuneUdxSocket(conn.rawStream?.socket)
    tuneUdxSocket(conn.rawStream?.rawStream?.socket)
    conn.once('close', () => {
      path.closedRx += conn.rawBytesRead || conn.rawStream?.bytesReceived || 0
      path.closedTx += conn.rawBytesWritten || conn.rawStream?.bytesTransmitted || 0
    })
    tracker.replicate(conn)
  }
  const swarm = new Hyperswarm({
    dht,
    maxParallel: 16,
    bootstrap,
    port: dhtPort || [0, 0],
    firewall,
    relayThrough: relayThrough && (force => force ? relayThrough.map(k => b4a.from(k, 'hex')) : null)
  })
  tuneDht(dhtRelay)
  tuneDht(swarm.dht)
  swarm.on('connection', conn => {
    if (hasLanPeer(conn.remotePublicKey)) { conn.destroy(); return }
    trackConn(conn, dht ? traffic.private : traffic.public)
  })
  const privateTopic = keyBuf => createHash('sha256').update('peartube/private/v1/').update(keyBuf).update(String(Math.floor(Date.now() / 86_400_000))).digest()
  const discoveries = new Map()
  const lanTopics = new Map()
  // lanPeers declared above so swarm firewall yields to direct LAN sockets
  let lan = null

  function joinOverlayTopic (id, keyBuf, discKey) {
    if (discoveries.has(id)) return
    const topic = dht ? privateTopic(keyBuf) : discKey
    const disc = swarm.join(topic, { server: !dht, client: true })
    discoveries.set(id, disc)
    lanTopics.set(id, discKey)
    lan?.join(discKey)
    if (dht && privateRelay) swarm.listen().then(() => { if (!closing) disc.refresh({ server: true, client: true }).catch(() => {}) }).catch(() => {})
  }

  async function leaveOverlayTopic (id) {
    const disc = discoveries.get(id)
    const discKey = lanTopics.get(id)
    discoveries.delete(id)
    lanTopics.delete(id)
    if (discKey) lan?.leave?.(discKey)
    if (disc) await swarm.leave(disc.topic).catch(() => {})
  }

  if (usePrimaryTracker) joinOverlayTopic(`tracker:${primaryKey}`, tracker.key, tracker.discoveryKey)
  if (localChannel.core.length > 0) joinOverlayTopic(`channel:${channelKey}`, localChannel.core.key, localChannel.core.discoveryKey)

  // Public content-swarm merging: peers watching the same blobs core across different channels find each other directly.
  const contentTopics = new Map()
  function joinContentSwarm (blobsHex) {
    if (dht || closing || !str(blobsHex, HEX64) || contentTopics.has(blobsHex)) return
    if (contentTopics.size >= MAX_CONTENT_TOPICS) {
      const oldest = contentTopics.keys().next().value
      const oldTopic = contentTopics.get(oldest)
      contentTopics.delete(oldest)
      swarm.leave(oldTopic).catch(() => {})
      lan?.leave?.(oldTopic)
    }
    const topic = createHash('sha256').update('peartube/blob/v1/').update(b4a.from(blobsHex, 'hex')).digest()
    contentTopics.set(blobsHex, topic)
    swarm.join(topic, { server: true, client: true })
    lan?.join(topic)
  }
  for (const s of blobSlots) if (s.core.length > 0) joinContentSwarm(s.key)

  const extraSources = new Map()
  const ephemeralWatches = new Map()
  let primaryAlias = ''
  let localChannelAlias = ''

  async function addSource (spec) {
    const parsed = typeof spec === 'string' ? parseUri(spec, 'channel') : parseUri(spec.uri || spec.key, spec.kind || 'channel')
    if (parsed.action !== 'source') throw new Error('Expected a channel or tracker source, not a watch URI')
    const { key, kind } = parsed
    const alias = cleanText(spec?.alias ?? parsed.alias)
    if (key === primaryKey && usePrimaryTracker) {
      if (alias) primaryAlias = alias
      update()
      return { key, kind: 'tracker', alias: primaryAlias, primary: true, writable: true }
    }
    if (key === channelKey) {
      if (alias) localChannelAlias = alias
      joinOverlayTopic(`channel:${channelKey}`, localChannel.core.key, localChannel.core.discoveryKey)
      update()
      return { key, kind: 'channel', alias: localChannelAlias, primary: false, writable: true }
    }
    const existing = extraSources.get(key)
    if (existing) {
      if (alias) existing.alias = alias
      update()
      return { key, kind: existing.kind, alias: existing.alias, primary: false, writable: false }
    }
    if (kind === 'tracker') {
      const bee = new Autobee(store.namespace(`tracker:${key}`), b4a.from(key, 'hex'), { apply, update, optimistic: true, fastForward: false, wakeup })
      await bee.ready()
      extraSources.set(key, { key, kind, alias, bee })
      joinOverlayTopic(`tracker:${key}`, bee.key, bee.discoveryKey)
      if (dht) swarm.listen().then(() => advertisePeer(true)).catch(() => {})
    } else {
      const bee = new Hyperbee(store.namespace(`channel:${key}`), { key: b4a.from(key, 'hex'), writable: false, autoUpdate: true })
      await bee.ready()
      const dl = bee.core.download({ start: 0, end: -1 })
      bee.on('update', update)
      extraSources.set(key, { key, kind: 'channel', alias, bee, dl })
      joinOverlayTopic(`channel:${key}`, bee.core.key, bee.core.discoveryKey)
    }
    onPeersChanged?.()
    update()
    return { key, kind, alias, primary: false, writable: false }
  }

  async function removeSource (key) {
    const k = String(key || '').trim().toLowerCase()
    const src = extraSources.get(k)
    if (!src) return { removed: false }
    extraSources.delete(k)
    src.dl?.destroy()
    await leaveOverlayTopic(`${src.kind}:${k}`)
    await src.bee.close().catch(() => {})
    update()
    return { removed: true }
  }

  function listSources () {
    const list = []
    if (usePrimaryTracker) list.push({ key: primaryKey, kind: 'tracker', alias: primaryAlias, primary: true, writable: true })
    if (localChannel.core.length > 0 || localChannelAlias) {
      list.push({ key: channelKey, kind: 'channel', alias: localChannelAlias, primary: false, writable: true })
    }
    for (const s of extraSources.values()) {
      list.push({ key: s.key, kind: s.kind, alias: s.alias, primary: false, writable: false })
    }
    return list
  }

  for (const s of initialSources) await addSource(s)

  const refreshTimer = dht ? setInterval(() => {
    if (closing || swarm.connections.size >= 16) return
    for (const d of discoveries.values()) d.refresh().catch(() => {})
  }, 20_000) : null
  refreshTimer?.unref?.()

  const roster = new Map()
  let scanningPeers = false
  async function scanPeers () {
    if (!dht || closing || scanningPeers) return
    scanningPeers = true
    try {
      const available = new Map()
      const now = Date.now()
      const views = [
        ...(usePrimaryTracker ? [tracker.view] : []),
        ...[...extraSources.values()].map(s => s.kind === 'tracker' ? s.bee.view : s.bee)
      ]
      for (const v of views) {
        for await (const node of v.createReadStream({ gte: b4a.from('peer/'), lt: b4a.from('peer/\xff') })) {
          const peer = decodeOp(node.value)
          if (!peer || peer.type !== 'peer' || peer.expiresAt <= now || peer.expiresAt > now + 60 * 60_000 || peer.publicKey === b4a.toString(swarm.keyPair.publicKey, 'hex')) continue
          if (available.size >= 64) break
          available.set(peer.publicKey, b4a.from(peer.publicKey, 'hex'))
        }
      }
      for (const [key, publicKey] of roster) if (!available.has(key)) swarm.leavePeer(publicKey)
      for (const [key, publicKey] of available) if (!roster.has(key)) swarm.joinPeer(publicKey)
      roster.clear()
      for (const [key, publicKey] of available) roster.set(key, publicKey)
    } finally {
      scanningPeers = false
    }
  }
  onPeersChanged = () => { scanPeers().catch(() => {}) }
  let advertisingPeer = false
  let lastPeerAdvertised = 0
  async function advertisePeer (force = false) {
    if (!dht || closing || advertisingPeer || (!force && Date.now() - lastPeerAdvertised < 3 * 60_000)) return
    advertisingPeer = true
    try {
      const peerOp = { type: 'peer', publicKey: b4a.toString(swarm.keyPair.publicKey, 'hex'), expiresAt: Date.now() + 10 * 60_000 }
      if (usePrimaryTracker) await append(peerOp)
      for (const s of extraSources.values()) {
        if (s.kind === 'tracker') {
          await s.bee.append(b4a.from(JSON.stringify(peerOp)), { optimistic: !s.bee.writable }).catch(() => {})
          await s.bee.updated().catch(() => {})
        }
      }
      if (localChannel.core.length > 0) {
        await withChannelLock(async () => {
          const w = localChannel.write()
          w.tryPut(b4a.from('peer/owner'), b4a.from(JSON.stringify(peerOp)))
          await w.flush()
        })
      }
      lastPeerAdvertised = Date.now()
    } finally {
      advertisingPeer = false
    }
  }
  const peerTimer = dht ? setInterval(() => {
    advertisePeer().catch(() => {})
    scanPeers().catch(() => {})
  }, 20_000) : null
  peerTimer?.unref?.()
  if (dht) swarm.listen().then(() => advertisePeer()).catch(() => {})
  onPeersChanged()

  async function setLan (factory) {
    const previous = lan
    lan = null
    await previous?.destroy()
    if (!factory || closing) return
    const next = factory(swarm.keyPair)
    next.on('connection', conn => {
      lanPeers.add(conn)
      conn.once('close', () => lanPeers.delete(conn))
      if (conn.remotePublicKey) {
        for (const sc of swarm.connections) {
          if (!sc.destroyed && sc.remotePublicKey && b4a.equals(sc.remotePublicKey, conn.remotePublicKey)) sc.destroy()
        }
      }
      trackConn(conn, traffic.lan)
    })
    try {
      await next.ready()
    } catch (err) {
      await next.destroy()
      throw err
    }
    if (closing) {
      await next.destroy()
      return
    }
    for (const discKey of lanTopics.values()) next.join(discKey)
    if (!dht) for (const topic of contentTopics.values()) next.join(topic)
    lan = next
  }
  await setLan(createLan)

  const server = new BlobServer(store, { host: streamHost, port: streamPort, token: null })
  await server.listen()

  function streamUrl (entry) {
    return server.getLink(b4a.from(entry.blobs, 'hex'), { blob: entry.blob })
  }

  function syncBlockCounter (core) {
    core._ptBlocks = core.length > 0 ? core.core.bitfield.countSet(0, core.length) : 0
    core._ptSeq = (core._ptSeq || 0) + 1
    core._ptSlices?.clear()
  }

  function ensureBlockCounter (core) {
    if (core._ptBlocks !== undefined) return
    core._ptSlices = new Map()
    syncBlockCounter(core)
    core.on('download', () => { core._ptBlocks++; core._ptSeq++; core._ptSlices.clear() })
    core.on('append', () => syncBlockCounter(core))
  }

  async function blobCore (hex) {
    let core = blobCores.get(hex)
    if (!core) {
      const slot = blobSlots.find(s => s.key === hex)
      core = slot ? slot.core : store.get({ key: b4a.from(hex, 'hex') })
      blobCores.set(hex, core)
    }
    if (!core.opened) await core.ready()
    ensureBlockCounter(core)
    return core
  }

  // Bounded head (4 MiB) + tail (1 MiB moov/cues) prefetcher so playback starts immediately.
  const warmRanges = new Map()
  async function warm (entry) {
    if (!entry?.blobs || !entry?.blob) return
    joinContentSwarm(entry.blobs)
    const core = await blobCore(entry.blobs)
    const tag = `${entry.blobs}:${entry.blob.blockOffset}`
    if (warmRanges.has(tag)) return
    if (warmRanges.size >= 8) {
      const oldest = warmRanges.keys().next().value
      for (const r of warmRanges.get(oldest)) r.destroy()
      warmRanges.delete(oldest)
    }
    const { blockOffset, blockLength } = entry.blob
    const endBlock = blockOffset + blockLength
    const headEnd = Math.min(endBlock, blockOffset + 8)
    const ranges = [core.download({ start: blockOffset, end: headEnd, linear: true })]
    if (endBlock > headEnd) ranges.push(core.download({ start: Math.max(headEnd, endBlock - 2), end: endBlock, linear: true }))
    warmRanges.set(tag, ranges)
  }

  function entryCachedBytes (core, entry) {
    const { blockOffset, blockLength } = entry.blob
    if (!core?.opened || blockLength <= 0 || core.length <= blockOffset) return 0
    ensureBlockCounter(core)
    if (core._ptBlocks === 0) return 0
    const len = Math.min(blockLength, core.length - blockOffset)
    const tag = `${blockOffset}:${len}`
    let blocks = core._ptSlices.get(tag)
    if (blocks === undefined) {
      blocks = core.core.bitfield.countSet(blockOffset, len)
      if (core._ptSlices.size >= 512) core._ptSlices.clear()
      core._ptSlices.set(tag, blocks)
    }
    if (blocks <= 0) return 0
    return blocks >= blockLength ? entry.size : Math.min(entry.size, Math.round((blocks / blockLength) * entry.size))
  }

  async function readChannelEntries (bee, id, sourceKey) {
    const out = []
    const prefix = id ? `entry/${id}/` : 'entry/'
    for await (const node of bee.createReadStream({ gte: b4a.from(prefix), lt: b4a.from(`${prefix}\xff`) })) {
      const op = decodeOp(node.value)
      if (op?.type === 'announce') out.push({ key: `channel:${sourceKey}/${b4a.toString(node.key).slice(6)}`, entry: op, source: sourceKey, sourceKind: 'channel' })
    }
    return out
  }

  async function search (id = null, { source: filterSource = null } = {}) {
    const raw = []
    const primarySlices = new Set()
    if (usePrimaryTracker && (!filterSource || filterSource === primaryKey)) {
      await tracker.update()
      const range = id ? { gte: b4a.from(`${id}/`), lt: b4a.from(`${id}/\xff`) } : {}
      for await (const node of tracker.view.createReadStream(range)) {
        const key = b4a.toString(node.key)
        if (key.startsWith('peer/') || key.startsWith('source/')) continue
        const op = decodeOp(node.value)
        if (op?.type === 'announce') {
          primarySlices.add(`${op.id}/${op.blobs}:${op.blob.blockOffset}`)
          raw.push({ key, entry: op, source: primaryKey, sourceKind: 'tracker' })
        }
      }
    }
    if (localChannel.core.length > 0 && (!filterSource || filterSource === channelKey)) {
      for (const item of await readChannelEntries(localChannel, id, channelKey)) {
        if (!filterSource && primarySlices.has(`${item.entry.id}/${item.entry.blobs}:${item.entry.blob.blockOffset}`)) continue
        raw.push(item)
      }
    }
    for (const s of extraSources.values()) {
      if (filterSource && filterSource !== s.key) continue
      if (s.kind === 'tracker') {
        await s.bee.update()
        const range = id ? { gte: b4a.from(`${id}/`), lt: b4a.from(`${id}/\xff`) } : {}
        for await (const node of s.bee.view.createReadStream(range)) {
          const sub = b4a.toString(node.key)
          if (sub.startsWith('peer/') || sub.startsWith('source/')) continue
          const op = decodeOp(node.value)
          if (op?.type === 'announce') raw.push({ key: `tracker:${s.key}/${sub}`, entry: op, source: s.key, sourceKind: 'tracker' })
        }
      } else {
        raw.push(...(await readChannelEntries(s.bee, id, s.key)))
      }
    }
    for (const [key, item] of ephemeralWatches) {
      if ((!id || item.entry.id === id) && (!filterSource || filterSource === 'direct')) raw.push({ key, ...item })
    }
    await Promise.all([...new Set(raw.map(r => r.entry.blobs))].map(blobCore))
    return raw.map(({ key, entry, source, sourceKind }) => {
      const core = blobCores.get(entry.blobs)
      const cached = entryCachedBytes(core, entry)
      if (cached > 0) joinContentSwarm(entry.blobs)
      return {
        key,
        id: entry.id,
        title: cleanText(entry.title, entry.id),
        size: entry.size,
        sha256: entry.sha256,
        local: blobSlots.some(s => s.key === entry.blobs),
        cachedBytes: cached,
        streamUrl: streamUrl(entry),
        magnetUrl: formatWatchUri(entry, source, sourceKind),
        source,
        sourceKind
      }
    })
  }

  let discoveredCache = null
  let discoveredAtEpoch = 0
  async function discoveredSources () {
    if (discoveredCache && discoveredAtEpoch === viewEpoch) return discoveredCache
    const epochSnap = viewEpoch
    const active = new Set(listSources().map(s => s.key))
    const found = new Map()
    const scan = async (view, via) => {
      for await (const node of view.createReadStream({ gte: b4a.from('source/'), lt: b4a.from('source/\xff') })) {
        const op = decodeOp(node.value)
        if (op?.type === 'source' && !active.has(op.sourceKey) && !found.has(op.sourceKey)) {
          found.set(op.sourceKey, { key: op.sourceKey, kind: op.kind, title: cleanText(op.title, op.sourceKey.slice(0, 12)), via })
        }
      }
    }
    if (usePrimaryTracker) { await tracker.update(); await scan(tracker.view, primaryKey) }
    if (localChannel.core.length > 0) await scan(localChannel, channelKey)
    for (const s of extraSources.values()) {
      if (s.kind === 'tracker') await s.bee.update()
      await scan(s.kind === 'tracker' ? s.bee.view : s.bee, s.key)
    }
    const list = [...found.values()]
    discoveredCache = list
    discoveredAtEpoch = epochSnap
    return list
  }

  async function findEntry (key) {
    if (ephemeralWatches.has(key)) return ephemeralWatches.get(key).entry
    if (key.startsWith(`channel:${channelKey}/`)) {
      const n = await localChannel.get(b4a.from(`entry/${key.slice(channelKey.length + 9)}`))
      return n ? decodeOp(n.value) : null
    }
    const chMatch = key.match(/^channel:([0-9a-f]{64})\/(.+)$/)
    if (chMatch) {
      const src = extraSources.get(chMatch[1])
      const n = src?.kind === 'channel' ? await src.bee.get(b4a.from(`entry/${chMatch[2]}`)) : null
      return n ? decodeOp(n.value) : null
    }
    const trMatch = key.match(/^tracker:([0-9a-f]{64})\/(.+)$/)
    if (trMatch) {
      const src = extraSources.get(trMatch[1])
      if (src?.kind !== 'tracker') return null
      await src.bee.update()
      const n = await src.bee.view.get(b4a.from(trMatch[2]))
      return n ? decodeOp(n.value) : null
    }
    await tracker.update()
    const n = await tracker.view.get(b4a.from(key))
    return n ? decodeOp(n.value) : null
  }

  const dbDir = join(storage, 'corestore', 'db')
  function dbDiskBytes () {
    try {
      let sum = 0
      for (const f of readdirSync(dbDir)) sum += statSync(join(dbDir, f)).size
      return sum
    } catch { return 0 }
  }

  async function clearDownloadedSpans (core) {
    const bf = core.core.bitfield
    const len = core.length
    let pos = 0
    while (pos < len) {
      const start = bf.firstSet(pos)
      if (start < 0 || start >= len) break
      const unset = bf.firstUnset(start)
      const end = unset < 0 || unset > len ? len : unset
      await core.clear(start, end)
      pos = end
    }
  }

  let gcQueue = Promise.resolve()
  function gcStorage ({ full = false } = {}) {
    const run = async () => {
      const st = store.storage
      if (closing || !st || st.closed) return { beforeBytes: 0, afterBytes: 0, reclaimedBytes: 0 }
      const beforeBytes = dbDiskBytes()
      await st.ready?.().catch(() => {})
      await st.rocks?.flush?.().catch(() => {})
      await st.db?.flush?.().catch(() => {})
      if (!closing && !st.closed && typeof st.compact === 'function') {
        const hasLocalBlobs = blobSlots.some(s => s.core.length > 0 && s.core.core.bitfield.countSet(0, s.core.length) > 0)
        await st.compact(full && !hasLocalBlobs
          ? { exclusive: true, blobGarbageCollectionPolicy: 1, blobGarbageCollectionAgeCutoff: 1.0, bottommostLevelCompaction: 2 }
          : { exclusive: true, blobGarbageCollectionPolicy: 0, bottommostLevelCompaction: 2 }
        )
      }
      const afterBytes = dbDiskBytes()
      return { beforeBytes, afterBytes, reclaimedBytes: Math.max(0, beforeBytes - afterBytes) }
    }
    const next = gcQueue.then(run, run)
    gcQueue = next.catch(() => ({ beforeBytes: 0, afterBytes: 0, reclaimedBytes: 0 }))
    return next
  }

  async function gcUnreferencedSlotBlob (entry) {
    if (!entry?.blobs || !entry?.blob) return
    const slot = blobSlots.find(s => s.key === entry.blobs)
    if (!slot || !(entry.blob.blockLength > 0)) return
    const all = await search('').catch(() => [])
    if (all.some(item => item.magnetUrl?.includes(`${entry.blobs}:${entry.blob.blockOffset}`))) return
    const end = Math.min(slot.core.length, entry.blob.blockOffset + entry.blob.blockLength)
    if (end > entry.blob.blockOffset) {
      await slot.core.clear(entry.blob.blockOffset, end)
      await gcStorage({ full: false })
    }
  }

  async function clearCache (key = null) {
    if (key) {
      const entry = await findEntry(key)
      if (!entry || blobSlots.some(s => s.key === entry.blobs)) return { clearedBytes: 0, reclaimedBytes: 0 }
      const tag = `${entry.blobs}:${entry.blob.blockOffset}`
      if (warmRanges.has(tag)) {
        for (const r of warmRanges.get(tag)) r.destroy()
        warmRanges.delete(tag)
      }
      const core = await blobCore(entry.blobs)
      const clearedBytes = entryCachedBytes(core, entry)
      let reclaimedBytes = 0
      if (clearedBytes > 0 && entry.blob.blockLength > 0 && core.length > entry.blob.blockOffset) {
        await core.clear(entry.blob.blockOffset, Math.min(core.length, entry.blob.blockOffset + entry.blob.blockLength))
        syncBlockCounter(core)
        reclaimedBytes = (await gcStorage({ full: false })).reclaimedBytes
        update()
      }
      return { clearedBytes, reclaimedBytes }
    }
    for (const ranges of warmRanges.values()) for (const r of ranges) r.destroy()
    warmRanges.clear()
    await search('').catch(() => {})
    let clearedBytes = 0
    for (const [hex, core] of blobCores) {
      if (blobSlots.some(s => s.key === hex) || !core.opened || core.length === 0) continue
      ensureBlockCounter(core)
      const blocks = core._ptBlocks
      if (blocks > 0) {
        clearedBytes += Math.min(core.byteLength, Math.round((blocks / core.length) * core.byteLength))
        await clearDownloadedSpans(core)
        syncBlockCounter(core)
      }
    }
    const { reclaimedBytes } = await gcStorage({ full: true })
    update()
    return { clearedBytes, reclaimedBytes }
  }

  async function put ({ id, title }, source, onData = null) {
    if (!str(id, ID)) throw new Error(`Invalid id ${id}`)
    const slot = blobSlots.find(s => !s.busy) || await openSlot(blobSlots.length)
    slot.busy = true
    try {
      const hash = createHash('sha256')
      let size = 0
      let buf = []
      let bufLen = 0
      const hasher = new Transform({
        transform (chunk, cb) {
          hash.update(chunk)
          size += chunk.length
          if (onData) onData(size)
          buf.push(chunk)
          bufLen += chunk.length
          if (bufLen >= BLOB_BLOCK_SIZE) {
            const full = buf.length === 1 ? buf[0] : b4a.concat(buf, bufLen)
            let off = 0
            while (off + BLOB_BLOCK_SIZE <= full.length) this.push(full.subarray(off, off += BLOB_BLOCK_SIZE))
            buf = off < full.length ? [full.subarray(off)] : []
            bufLen = full.length - off
          }
          cb(null)
        },
        flush (cb) {
          if (bufLen > 0) this.push(bufLen === buf[0]?.length ? buf[0] : b4a.concat(buf, bufLen))
          cb(null)
        }
      })
      const writer = slot.blobs.createWriteStream()
      await pipelinePromise(source, hasher, writer)
      joinContentSwarm(slot.key)
      return { type: 'announce', id, title: cleanText(title, id), size, sha256: hash.digest('hex'), blobs: slot.key, blob: writer.id }
    } finally {
      slot.busy = false
    }
  }

  async function publish (meta, source) {
    const op = await put(meta, source)
    await append(op)
    return { ...op, streamUrl: streamUrl(op), magnetUrl: formatWatchUri(op, primaryKey, 'tracker') }
  }

  // Writes an announce op (either freshly streamed or re-curated) into this node's single-writer Hyperbee channel.
  async function publishChannel (metaOrOp, source = null) {
    const op = source ? await put(metaOrOp, source) : decodeOp(JSON.stringify({ ...metaOrOp, type: 'announce' }))
    if (!op || op.type !== 'announce') throw new Error('Invalid channel announce payload')
    const subKey = `${op.id}/${op.blobs}:${op.blob.blockOffset}`
    await withChannelLock(async () => {
      const w = localChannel.write()
      w.tryPut(b4a.from(`entry/${subKey}`), b4a.from(JSON.stringify(op)))
      await w.flush()
    })
    joinOverlayTopic(`channel:${channelKey}`, localChannel.core.key, localChannel.core.discoveryKey)
    joinContentSwarm(op.blobs)
    update()
    return {
      ...op,
      key: `channel:${channelKey}/${subKey}`,
      channel: channelKey,
      streamUrl: streamUrl(op),
      magnetUrl: formatWatchUri(op, channelKey, 'channel')
    }
  }

  async function removeChannel (key) {
    const prefix = `channel:${channelKey}/`
    const fullKey = key.startsWith(prefix) ? key : `${prefix}${key.replace(/^entry\//, '')}`
    const prev = key.startsWith('source/') ? null : await findEntry(fullKey).catch(() => null)
    const sub = key.startsWith(prefix) ? `entry/${key.slice(prefix.length)}` : key.startsWith('source/') ? key : `entry/${key}`
    await withChannelLock(async () => {
      const w = localChannel.write()
      w.tryDelete(b4a.from(sub))
      await w.flush()
    })
    await gcUnreferencedSlotBlob(prev).catch(() => {})
    update()
  }

  // Publishes a gossip/directory recommendation for another channel or tracker.
  async function publishSource ({ sourceKey, kind = 'channel', title }, { target = 'channel' } = {}) {
    const op = decodeOp(JSON.stringify({ type: 'source', sourceKey: String(sourceKey || '').toLowerCase(), kind, title: cleanText(title, String(sourceKey).slice(0, 12)) }))
    if (!op) throw new Error('Invalid source directory record')
    if (target === 'channel' || target === 'both') {
      await withChannelLock(async () => {
        const w = localChannel.write()
        w.tryPut(b4a.from(`source/${op.sourceKey}`), b4a.from(JSON.stringify(op)))
        await w.flush()
      })
      joinOverlayTopic(`channel:${channelKey}`, localChannel.core.key, localChannel.core.discoveryKey)
    }
    if ((target === 'tracker' || target === 'both') && usePrimaryTracker) {
      await append(op)
    }
    update()
    return op
  }

  async function unpublishSource (sourceKey) {
    const k = String(sourceKey || '').trim().toLowerCase()
    if (!HEX64.test(k)) throw new Error('Invalid source key')
    if (localChannel.core.length > 0) {
      await withChannelLock(async () => {
        const w = localChannel.write()
        w.tryDelete(b4a.from(`source/${k}`))
        await w.flush()
      })
    }
    if (usePrimaryTracker) {
      const writer = b4a.toString(tracker.local.key, 'hex')
      const trKey = `source/${writer}/${k}`
      await tracker.update()
      if (await tracker.view.get(b4a.from(trKey))) await append({ type: 'remove', key: trKey })
    }
    update()
    return { unpublished: true, key: k }
  }

  async function publishedSources () {
    const out = new Map()
    if (localChannel.core.length > 0) {
      for await (const node of localChannel.createReadStream({ gte: b4a.from('source/'), lt: b4a.from('source/\xff') })) {
        const op = decodeOp(node.value)
        if (op?.type === 'source') out.set(op.sourceKey, { key: op.sourceKey, kind: op.kind, title: cleanText(op.title, op.sourceKey.slice(0, 12)) })
      }
    }
    if (usePrimaryTracker) {
      await tracker.update()
      const writer = b4a.toString(tracker.local.key, 'hex')
      const pfx = `source/${writer}/`
      for await (const node of tracker.view.createReadStream({ gte: b4a.from(pfx), lt: b4a.from(`${pfx}\xff`) })) {
        const op = decodeOp(node.value)
        if (op?.type === 'source' && !out.has(op.sourceKey)) out.set(op.sourceKey, { key: op.sourceKey, kind: op.kind, title: cleanText(op.title, op.sourceKey.slice(0, 12)) })
      }
    }
    return [...out.values()]
  }

  async function openUri (uri) {
    const parsed = parseUri(uri, 'channel')
    if (parsed.action === 'source') return { action: 'source', source: await addSource(parsed) }
    if (parsed.sourceKey) await addSource({ key: parsed.sourceKey, kind: parsed.sourceKind }).catch(() => {})
    const { entry } = parsed
    const key = `watch/${entry.blobs}:${entry.blob.blockOffset}`
    ephemeralWatches.set(key, { entry, source: parsed.sourceKey || 'direct', sourceKind: 'watch' })
    await warm(entry)
    update()
    return {
      action: 'watch',
      entry: {
        key,
        id: entry.id,
        title: entry.title,
        size: entry.size,
        sha256: entry.sha256,
        local: blobSlots.some(s => s.key === entry.blobs),
        cachedBytes: entryCachedBytes(blobCores.get(entry.blobs), entry),
        streamUrl: streamUrl(entry),
        magnetUrl: formatWatchUri(entry, parsed.sourceKey || '', parsed.sourceKind),
        source: parsed.sourceKey || 'direct',
        sourceKind: 'watch'
      }
    }
  }

  // Backfills all locally stored tracker entries into this node's single-writer channel with zero blob copies.
  async function syncLocalChannel () {
    if (!usePrimaryTracker) return { backfilled: 0, total: 0 }
    return withChannelLock(async () => {
      await tracker.update()
      const writer = b4a.toString(tracker.local.key, 'hex')
      const existing = new Set()
      if (localChannel.core.length > 0) {
        for await (const n of localChannel.createReadStream({ gte: b4a.from('entry/'), lt: b4a.from('entry/\xff') })) {
          existing.add(b4a.toString(n.key))
        }
      }
      let backfilled = 0
      const w = localChannel.write()
      for await (const n of tracker.view.createReadStream()) {
        const key = b4a.toString(n.key)
        if (key.startsWith('peer/') || key.startsWith('source/')) continue
        const op = decodeOp(n.value)
        if (!op || op.type !== 'announce') continue
        if (key.split('/')[1] !== writer && !blobSlots.some(s => s.key === op.blobs)) continue
        const chKey = `entry/${op.id}/${op.blobs}:${op.blob.blockOffset}`
        if (!existing.has(chKey)) {
          w.tryPut(b4a.from(chKey), b4a.from(JSON.stringify(op)))
          joinContentSwarm(op.blobs)
          backfilled++
        }
      }
      if (backfilled > 0) {
        await w.flush()
        joinOverlayTopic(`channel:${channelKey}`, localChannel.core.key, localChannel.core.discoveryKey)
        update()
      }
      return { backfilled, total: existing.size + backfilled }
    })
  }

  async function remove (key) {
    if (key.startsWith(`channel:${channelKey}/`)) return removeChannel(key)
    const prev = await findEntry(key).catch(() => null)
    const parts = key.split('/')
    if (parts.length === 3 && parts[1] === b4a.toString(tracker.local.key, 'hex') && localChannel.core.length > 0) {
      await removeChannel(`${parts[0]}/${parts[2]}`).catch(() => {})
    }
    await append({ type: 'remove', key })
    await gcUnreferencedSlotBlob(prev).catch(() => {})
  }

  async function append (op) {
    const before = tracker.local.length
    await tracker.append(b4a.from(JSON.stringify(op)), { optimistic: !tracker.writable })
    await tracker.updated()
    while (tracker.local.length <= before) {
      if (closing) throw new Error('Node closed before the write was durable')
      await new Promise(resolve => setTimeout(resolve, 500))
      await tracker.update()
    }
  }

  function setAllowedPeers (keys) {
    allowedSet = Array.isArray(keys) && keys.length ? new Set(keys.map(k => String(k).toLowerCase())) : null
  }

  // Tit-for-tat reciprocity: seeders holding cached/published blocks earn wider inflight windows than empty leechers.
  function applyReciprocity (seededBytes, txBytes, rxBytes, contributingPeers) {
    const tier = seededBytes > 0 && (txBytes > 0 || blobSlots.some(s => s.core.byteLength > 0) || privateRelay || seededBytes >= BLOB_BLOCK_SIZE)
      ? 'seeder'
      : (seededBytes > 0 || contributingPeers > 0 ? 'peer' : 'leecher')
    const next = tier === 'seeder' ? [64, 192] : tier === 'peer' ? [48, 128] : [24, 64]
    if (next[1] !== inflightRange[1]) {
      inflightRange = next
      for (const c of store.cores) c.replicator?.setInflightRange(next[0], next[1])
    }
    const ratio = rxBytes > 0 ? Math.round((txBytes / rxBytes) * 100) / 100 : (txBytes > 0 ? 1 : 0)
    return { tier, seededBytes, contributingPeers, ratio, inflightMax: next[1] }
  }

  function status () {
    let rttSum = 0, rttCount = 0, retransmits = 0, contributingPeers = 0
    const now = Date.now(), dt = now - prevAt
    function measure (path, connections) {
      let rxBytes = path.closedRx, txBytes = path.closedTx
      if (connections) for (const c of connections) {
        const crx = c.rawBytesRead || c.rawStream?.bytesReceived || 0
        const ctx = c.rawBytesWritten || c.rawStream?.bytesTransmitted || 0
        if (crx > 0) contributingPeers++
        rxBytes += crx
        txBytes += ctx
        const r = c.rawStream
        if (r?.rtt > 0) { rttSum += r.rtt; rttCount++ }
        if (r?.retransmits > 0) retransmits += r.retransmits
      }
      if (dt >= 500) {
        path.downBps = Math.max(0, Math.round(((rxBytes - path.prevRx) * 1000) / dt))
        path.upBps = Math.max(0, Math.round(((txBytes - path.prevTx) * 1000) / dt))
        path.prevRx = rxBytes; path.prevTx = txBytes
      }
      return { peers: connections?.size || 0, rxBytes, txBytes, downBps: path.downBps, upBps: path.upBps }
    }
    const routes = {
      private: measure(traffic.private, dht ? swarm.connections : null),
      public: measure(traffic.public, dht ? null : swarm.connections),
      lan: measure(traffic.lan, lanPeers)
    }
    const rxBytes = routes.private.rxBytes + routes.public.rxBytes + routes.lan.rxBytes
    const txBytes = routes.private.txBytes + routes.public.txBytes + routes.lan.txBytes
    if (dt >= 500) {
      downBps = Math.max(0, Math.round(((rxBytes - prevRx) * 1000) / dt))
      upBps = Math.max(0, Math.round(((txBytes - prevTx) * 1000) / dt))
      prevRx = rxBytes; prevTx = txBytes; prevAt = now
    }
    let inflightBlocks = 0, cachedBytes = 0
    for (const c of store.cores) inflightBlocks += c.replicator?._inflight?.length || 0
    for (const [k, c] of blobCores) {
      if (!blobSlots.some(s => s.key === k) && c.opened && c.length > 0 && c.byteLength > 0) {
        ensureBlockCounter(c)
        const blocks = c._ptBlocks
        if (blocks > 0) {
          cachedBytes += Math.min(coreByteLen(c), Math.round((blocks / c.length) * coreByteLen(c)))
          joinContentSwarm(k)
        }
      }
    }
    const blobBytes = blobSlots.reduce((sum, s) => sum + s.core.byteLength, 0)
    const reciprocity = applyReciprocity(blobBytes + cachedBytes, txBytes, rxBytes, contributingPeers)
    return {
      tracker: usePrimaryTracker ? primaryKey : (extraSources.keys().next().value || primaryKey),
      channel: channelKey,
      writer: b4a.toString(tracker.local.key, 'hex'),
      blobs: blobsKey,
      blobBytes,
      cachedBytes,
      peers: swarm.connections.size,
      lanPeers: lanPeers.size,
      downBps,
      upBps,
      rxBytes,
      txBytes,
      routes,
      inflightBlocks,
      rtt: rttCount ? Math.round(rttSum / rttCount) : 0,
      retransmits,
      sources: listSources(),
      reciprocity
    }
  }

  function coreByteLen (c) { return c.byteLength || 0 }

  async function close () {
    closing = true
    clearInterval(peerTimer)
    clearInterval(refreshTimer)
    for (const ranges of warmRanges.values()) for (const r of ranges) r.destroy()
    warmRanges.clear()
    await lan?.destroy()
    for (const d of swarm.topics()) d._needsUnannounce = false
    await swarm.clear()
    await Promise.all([swarm.destroy({ force: true }), dhtRelay?.destroy({ force: true })])
    for (const s of extraSources.values()) { s.dl?.destroy(); await s.bee.close().catch(() => {}) }
    extraSources.clear()
    await localChannel.close().catch(() => {})
    await tracker.close()
    wakeup.destroy()
    await server.close()
    await store.close()
  }

  return {
    store,
    findEntry,
    blobCore,
    privateRouting: Boolean(dht),
    bootstrap: bootstrap || null,
    relayThrough: relayThrough || null,
    hasLan: () => Boolean(lan),
    hasLanPeer,
    tracker,
    localChannel,
    swarm,
    search,
    put,
    append,
    publish,
    publishChannel,
    remove,
    removeChannel,
    publishSource,
    syncLocalChannel,
    unpublishSource,
    publishedSources,
    addSource,
    removeSource,
    listSources,
    discoveredSources,
    openUri,
    warm,
    setAllowedPeers,
    clearCache,
    status,
    streamUrl,
    blobServer: server,
    setLan,
    close,
    get closing () { return closing }
  }
}
