import Autobee from 'autobee'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import HyperDHT from 'hyperdht'
import Hyperblobs from 'hyperblobs'
import BlobServer from 'hypercore-blob-server'
import b4a from 'b4a'
import { createHash } from 'node:crypto'
import { pipelinePromise, Transform } from 'streamx'
import { join } from 'node:path'

const ID = /^[a-z0-9]+:[a-z0-9]+(:s\d{2}e\d{2,3})?$/
const HEX64 = /^[0-9a-f]{64}$/
const MAX_TITLE = 300
const BLOB_BLOCK_SIZE = 512 * 1024

// A tracker entry is public and replicated to every relay. apply is the only
// gate: it keeps well-formed announces and files each under its writer's key,
// so a writer can add or remove only its own entries.
// Values here come from any peer, so every check must be total: typeof before regex.
const str = (v, re) => typeof v === 'string' && re.test(v)

export function decodeOp (value) {
  let op
  try { op = JSON.parse(value) } catch { return null }
  if (op === null || typeof op !== 'object') return null
  if (op.type === 'remove') return typeof op.key === 'string' ? op : null
  if (op.type !== 'announce' || !str(op.id, ID) || !str(op.blobs, HEX64) || !str(op.sha256, HEX64)) return null
  if (typeof op.title !== 'string' || op.title.length > MAX_TITLE || !Number.isSafeInteger(op.size) || op.size < 0) return null
  const { blockOffset, blockLength, byteOffset, byteLength } = op.blob || {}
  if (![blockOffset, blockLength, byteOffset, byteLength].every(n => Number.isSafeInteger(n) && n >= 0)) return null
  return op
}

// A relay's first well-formed op arrives optimistically, as a join request.
// Granting it as a non-indexer writer lets its later ops be ordinary appends;
// an ungranted optimistic writer cannot append again.
async function apply (nodes, view, host) {
  for (const node of nodes) {
    const op = decodeOp(node.value)
    if (!op) continue
    await host.addWriter(node.key, { isIndexer: false })
    const writer = b4a.toString(node.key, 'hex')
    const w = view.write()
    if (op.type === 'remove') {
      if (op.key.split('/')[1] === writer) w.tryDelete(b4a.from(op.key))
    } else {
      w.tryPut(b4a.from(`${op.id}/${writer}/${op.blobs}:${op.blob.blockOffset}`), node.value)
    }
    await w.flush()
  }
}

// lan: optional keyPair => HyperDHT-like LAN discovery (see src/lan.js). The
// relay passes it in so this module stays free of Node-only imports and also
// runs in the mobile app's Bare worklet.
// onchange: optional, called after the tracker's view changes.
export async function createNode ({
  storage,
  tracker: trackerKey = null,
  streamHost = '127.0.0.1',
  streamPort = 0,
  bootstrap,
  dhtPort,
  privateRouting = false,
  privateRelay = false,
  relayThrough = null,
  lan: createLan = null,
  onchange = null
}) {
  const store = new Corestore(join(storage, 'corestore'))
  store.watch(core => core.replicator.setInflightRange(16, 48))
  // Autobee reports view changes only through its update handler (its 'update'
  // event fires on interrupts). The handler runs inside the update loop, where
  // a throw would close the tracker, so onchange is queued instead of called.
  const update = onchange && (() => queueMicrotask(onchange))
  // fastForward: false - Autobee's default lets a peer that is far enough
  // ahead hand over its built view, skipping our apply. On an open tracker any
  // relay could then forge entries under other writers' keys; every node must
  // build its own view with apply.
  const tracker = new Autobee(store.namespace('tracker'), trackerKey && b4a.from(trackerKey, 'hex'), { apply, update, optimistic: true, fastForward: false })
  await tracker.ready()
  // A fresh tracker ignores everyone's writes until its founder writes once.
  if (!trackerKey && tracker.local.length === 0) {
    await tracker.append(b4a.from(JSON.stringify({ type: 'init' })))
    await tracker.updated()
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
  const blobsKey = blobSlots[0].key
  const blobCores = new Map(blobSlots.map(s => [s.key, s.core]))
  // Optional alpha private routing: 4-hop relay circuits (2 destination, 2 source)
  // with period-blinded descriptors stored on a 3-node DHT quorum. A relay node
  // (privateRelay) contributes hop + descriptor-storage capacity on dhtPort; an
  // endpoint (privateRouting) routes swarm listen/connect over private circuits.
  const host = Array.isArray(bootstrap) && bootstrap.some(b => String(b?.host || b).startsWith('127.')) ? '127.0.0.1' : undefined
  const privateOpts = relay => ({ release: 'alpha', acknowledgeAlpha: true, mode: 'optional', profile: 'spliced', relay })
  const dhtRelay = privateRelay ? new HyperDHT({ host, bootstrap, seed: tracker.local.key, port: typeof privateRelay === 'number' ? privateRelay : dhtPort, ephemeral: false, firewalled: false, privateRouting: privateOpts(true) }) : null
  const dht = privateRouting ? new HyperDHT({ host, bootstrap, port: dhtRelay ? 0 : dhtPort, privateRouting: typeof privateRouting === 'object' ? privateRouting : privateOpts(false) }) : null
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
  // Double-randomized NATs cannot holepunch; relayThrough lets them meet via a blind relay.
  let closedRx = 0, closedTx = 0, prevRx = 0, prevTx = 0, prevAt = Date.now(), downBps = 0, upBps = 0
  const stripePools = new Map()
  const stripeConns = new Set()
  const peerLaneKeys = new Map()
  const laneServers = []
  let localLaneBuf = b4a.alloc(0)
  const STRIPE_LANES = 7
  const rawCodec = {
    preencode (s, b) { s.end += b.byteLength },
    encode (s, b) { s.buffer.set(b, s.start); s.start += b.byteLength },
    decode (s) { const b = b4a.from(s.buffer.subarray(s.start, s.end)); s.start = s.end; return b }
  }
  const trackConn = conn => {
    conn.once('close', () => {
      closedRx += conn.rawBytesRead || conn.rawStream?.bytesReceived || 0
      closedTx += conn.rawBytesWritten || conn.rawStream?.bytesTransmitted || 0
    })
    tracker.replicate(conn)
  }
  function stripePeer (pubKey, count = STRIPE_LANES) {
    if (!dht || closing || !pubKey) return
    const hex = b4a.toString(pubKey, 'hex')
    let pool = stripePools.get(hex)
    if (!pool) { pool = new Set(); stripePools.set(hex, pool) }
    const targets = peerLaneKeys.get(hex) || [pubKey]
    let idx = pool.size
    while (pool.size < count) {
      const lane = dht.connect(targets[idx++ % targets.length])
      lane.on('error', () => {})
      pool.add(lane)
      stripeConns.add(lane)
      lane.once('close', () => { pool.delete(lane); stripeConns.delete(lane) })
      trackConn(lane)
    }
  }
  function stripeCore (hex, count = STRIPE_LANES) {
    if (!dht || closing || blobSlots.some(s => s.key === hex)) return
    const core = blobCores.get(hex)
    if (!core?.opened) return
    for (const p of core.core.replicator.peers) {
      if (swarm.connections.has(p.stream) && (p._remoteContiguousLength > 0 || p.remoteLength > 0)) {
        stripePeer(p.remotePublicKey, count)
      }
    }
  }
  const laneChannels = new Set()
  const attachLaneMux = conn => {
    const mux = conn.userData
    if (!dht || !mux?.isProtomux || !conn.remotePublicKey) return
    const hex = b4a.toString(conn.remotePublicKey, 'hex')
    const onKeys = buf => {
      if (!buf?.byteLength || peerLaneKeys.has(hex)) return
      const keys = [conn.remotePublicKey]
      for (let i = 0; i + 32 <= buf.byteLength; i += 32) keys.push(buf.subarray(i, i + 32))
      peerLaneKeys.set(hex, keys)
      if (keys.length > 1 && stripePools.has(hex)) {
        for (let i = 1; i < keys.length; i++) {
          const lane = dht.connect(keys[i])
          lane.on('error', () => {})
          stripePools.get(hex).add(lane)
          stripeConns.add(lane)
          lane.once('close', () => { stripePools.get(hex)?.delete(lane); stripeConns.delete(lane) })
          trackConn(lane)
        }
      }
    }
    const open = () => {
      if (mux.opened({ protocol: 'peartube/lanes' })) return
      const ch = mux.createChannel({
        protocol: 'peartube/lanes',
        handshake: rawCodec,
        messages: [{ encoding: rawCodec, onmessage: onKeys }],
        onopen: onKeys,
        onclose () { laneChannels.delete(ch) }
      })
      if (ch) { laneChannels.add(ch); ch.open(localLaneBuf) }
    }
    mux.pair({ protocol: 'peartube/lanes' }, open)
    conn.opened?.then(ok => { if (ok && !closing) open() }).catch(() => {})
  }
  const swarm = new Hyperswarm({ dht, maxParallel: 16, bootstrap, port: dhtPort, relayThrough: relayThrough && (force => force ? relayThrough.map(k => b4a.from(k, 'hex')) : null) })
  swarm.on('connection', conn => {
    trackConn(conn)
    attachLaneMux(conn)
    conn.once('close', () => {
      const hex = conn.remotePublicKey && b4a.toString(conn.remotePublicKey, 'hex')
      if (hex && ![...swarm.connections].some(c => c.remotePublicKey && b4a.toString(c.remotePublicKey, 'hex') === hex)) {
        peerLaneKeys.delete(hex)
        const pool = stripePools.get(hex)
        if (pool) { stripePools.delete(hex); for (const l of pool) l.destroy() }
      }
    })
  })
  const topic = dht ? createHash('sha256').update('peartube/private/v1/').update(tracker.key).update(String(Math.floor(Date.now() / 86_400_000))).digest() : tracker.discoveryKey
  const discovery = swarm.join(topic, { server: !dht, client: true })
  if (dht) {
    swarm.listen().then(async () => {
      if (closing) return
      discovery.refresh({ server: true, client: true }).catch(() => {})
      if (dhtRelay || blobSlots.some(s => s.core.length > 0)) {
        const keys = []
        for (let i = 0; i < 3 && !closing; i++) {
          const s = dht.createServer({}, c => trackConn(c))
          laneServers.push(s)
          await s.listen().catch(() => {})
          if (s.publicKey) keys.push(s.publicKey)
        }
        localLaneBuf = b4a.concat(keys)
        if (localLaneBuf.byteLength) for (const ch of laneChannels) ch.messages[0].send(localLaneBuf)
      }
    }).catch(() => {})
  }
  const refreshTimer = dht ? setInterval(() => { if (!closing && swarm.connections.size < 16) discovery.refresh().catch(() => {}) }, 20_000) : null
  refreshTimer?.unref?.()

  // Optional LAN path (mDNS + isolated DHT) for peers the public DHT cannot
  // connect, e.g. two randomized NATs on one network. Same key pair as the
  // swarm. setLan replaces it, so the app can follow its device from network
  // to network; calls must not overlap.
  const lanPeers = new Set()
  let lan = null
  let closing = false
  async function setLan (factory) {
    const previous = lan
    lan = null
    await previous?.destroy()
    if (!factory || closing) return
    const next = factory(swarm.keyPair)
    next.on('connection', conn => {
      lanPeers.add(conn)
      conn.once('close', () => lanPeers.delete(conn))
      trackConn(conn)
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
    next.join(tracker.discoveryKey)
    lan = next
  }
  await setLan(createLan)

  // No stream token for now: stream URLs are open, like the API.
  const server = new BlobServer(store, {
    host: streamHost,
    port: streamPort,
    token: null,
    resolve: async key => { stripeCore(b4a.toString(key, 'hex'), STRIPE_LANES); return { key, encryptionKey: null } }
  })
  await server.listen()

  function streamUrl (entry) {
    return server.getLink(b4a.from(entry.blobs, 'hex'), { blob: entry.blob })
  }

  async function blobCore (hex) {
    let core = blobCores.get(hex)
    if (!core) {
      const slot = blobSlots.find(s => s.key === hex)
      core = slot ? slot.core : store.get({ key: b4a.from(hex, 'hex') })
      if (!slot && dht && !dhtRelay) {
        core.on('peer-add', p => { if (swarm.connections.has(p.stream)) stripePeer(p.remotePublicKey, 3) })
      }
      blobCores.set(hex, core)
    }
    if (!core.opened) await core.ready()
    if (dht && !dhtRelay) stripeCore(hex, 3)
    return core
  }

  function entryCachedBytes (core, entry) {
    const { blockOffset, blockLength } = entry.blob
    if (!core?.opened || blockLength <= 0 || core.length <= blockOffset) return 0
    const len = Math.min(blockLength, core.length - blockOffset)
    const blocks = core.core.bitfield.countSet(blockOffset, len)
    if (blocks <= 0) return 0
    return blocks >= blockLength ? entry.size : Math.min(entry.size, Math.round((blocks / blockLength) * entry.size))
  }

  // Every tracker entry for id, or every entry in the tracker without one.
  async function search (id = null) {
    await tracker.update()
    const raw = []
    const range = id ? { gte: b4a.from(`${id}/`), lt: b4a.from(`${id}/\xff`) } : {}
    for await (const node of tracker.view.createReadStream(range)) {
      raw.push({ key: b4a.toString(node.key), entry: JSON.parse(node.value) })
    }
    await Promise.all([...new Set(raw.map(r => r.entry.blobs))].map(blobCore))
    return raw.map(({ key, entry }) => ({
      key,
      id: entry.id,
      title: entry.title,
      size: entry.size,
      sha256: entry.sha256,
      local: blobSlots.some(s => s.key === entry.blobs),
      cachedBytes: entryCachedBytes(blobCores.get(entry.blobs), entry),
      streamUrl: streamUrl(entry)
    }))
  }

  async function clearCache (key = null) {
    await tracker.update()
    if (key) {
      const node = await tracker.view.get(b4a.from(key))
      if (!node) return { clearedBytes: 0 }
      const entry = JSON.parse(node.value)
      if (blobSlots.some(s => s.key === entry.blobs)) return { clearedBytes: 0 }
      const core = await blobCore(entry.blobs)
      const clearedBytes = entryCachedBytes(core, entry)
      if (clearedBytes > 0 && entry.blob.blockLength > 0 && core.length > entry.blob.blockOffset) {
        await core.clear(entry.blob.blockOffset, Math.min(core.length, entry.blob.blockOffset + entry.blob.blockLength))
      }
      return { clearedBytes }
    }
    let clearedBytes = 0
    for (const [hex, core] of blobCores) {
      if (blobSlots.some(s => s.key === hex) || !core.opened || core.length === 0) continue
      const blocks = core.core.bitfield.countSet(0, core.length)
      if (blocks > 0) {
        clearedBytes += Math.min(core.byteLength, Math.round((blocks / core.length) * core.byteLength))
        await core.clear(0, core.length)
      }
    }
    return { clearedBytes }
  }

  // Store a readable stream as a blob and hash it on the way in. Returns the
  // announce op without publishing it. pipelinePromise destroys every stream
  // on failure, which releases the Hyperblobs write lock; an abandoned writer
  // would hang every later put.
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
          if (bufLen > 0) this.push(buf.length === 1 ? buf[0] : b4a.concat(buf, bufLen))
          cb(null)
        }
      })
      const writer = slot.blobs.createWriteStream()
      await pipelinePromise(source, hasher, writer)
      return { type: 'announce', id, title: String(title || id).slice(0, MAX_TITLE).toWellFormed(), size, sha256: hash.digest('hex'), blobs: slot.key, blob: writer.id }
    } finally {
      slot.busy = false
    }
  }

  async function publish (meta, source) {
    const op = await put(meta, source)
    await append(op)
    return { ...op, streamUrl: streamUrl(op) }
  }

  async function remove (key) {
    await append({ type: 'remove', key })
  }

  // Resolves once op is in the local oplog. A relay that has not synced the
  // tracker yet holds optimistic writes in memory only, and a restart would
  // drop them; this waits until the write is durable (for a joiner, until it
  // first syncs).
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

  function status () {
    let rxBytes = closedRx, txBytes = closedTx, rttSum = 0, rttCount = 0, retransmits = 0
    for (const c of [...swarm.connections, ...lanPeers, ...stripeConns]) {
      rxBytes += c.rawBytesRead || c.rawStream?.bytesReceived || 0
      txBytes += c.rawBytesWritten || c.rawStream?.bytesTransmitted || 0
      const r = c.rawStream
      if (r?.rtt > 0) { rttSum += r.rtt; rttCount++ }
      if (r?.retransmits > 0) retransmits += r.retransmits
    }
    const now = Date.now(), dt = now - prevAt
    if (dt >= 500) {
      downBps = Math.max(0, Math.round(((rxBytes - prevRx) * 1000) / dt))
      upBps = Math.max(0, Math.round(((txBytes - prevTx) * 1000) / dt))
      prevRx = rxBytes; prevTx = txBytes; prevAt = now
    }
    let inflightBlocks = 0, cachedBytes = 0
    for (const c of store.cores) inflightBlocks += c.replicator?._inflight?.length || 0
    for (const [k, c] of blobCores) {
      if (!blobSlots.some(s => s.key === k) && c.opened && c.length > 0 && c.byteLength > 0) {
        const blocks = c.core.bitfield.countSet(0, c.length)
        if (blocks > 0) cachedBytes += Math.min(c.byteLength, Math.round((blocks / c.length) * c.byteLength))
      }
    }
    return {
      tracker: b4a.toString(tracker.key, 'hex'),
      writer: b4a.toString(tracker.local.key, 'hex'),
      blobs: blobsKey,
      blobBytes: blobSlots.reduce((sum, s) => sum + s.core.byteLength, 0),
      cachedBytes,
      peers: swarm.connections.size,
      lanPeers: lanPeers.size,
      downBps,
      upBps,
      rxBytes,
      txBytes,
      inflightBlocks,
      rtt: rttCount ? Math.round(rttSum / rttCount) : 0,
      retransmits
    }
  }

  async function close () {
    closing = true
    clearInterval(refreshTimer)
    await lan?.destroy()
    for (const d of swarm.topics()) d._needsUnannounce = false
    for (const l of stripeConns) l.destroy()
    await Promise.all(laneServers.map(s => s.close().catch(() => {})))
    await swarm.clear()
    await Promise.all([swarm.destroy({ force: true }), dhtRelay?.destroy({ force: true })])
    await tracker.close()
    await server.close()
    await store.close()
  }

  return { tracker, swarm, search, put, append, publish, remove, clearCache, status, streamUrl, setLan, close, get closing () { return closing } }
}
