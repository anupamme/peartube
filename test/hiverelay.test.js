// End-to-end verification of supplemental HiveRelay seeding on a live HyperDHT testnet:
//   1. Operator-authed HiveRelay (`POST /seed-core` + `/.well-known/hiverelay.json`) pins PearTube channel + 512 KiB Hyperblobs cores;
//      after the origin publisher dies, both a Channel subscriber (HTTP 206 Range + full stream) AND a sourceless
//      `peartube://watch/...` magnet viewer stream byte-exact video solely from the HiveRelay via `core.discoveryKey`.
//   2. Zero-URL DHT HiveRelay discovery (`hiverelay-discovery-v1` + `hiverelay-seed` Protomux channel):
//      verifies `hiverelay.seed-request.v3` signatures, `'review'`-mode signed deny telemetry, `'allowlist'` acceptance,
//      wire-exact classic Hyperdrive v11/v13 2-core beacon (`Header` + `YoloIndex` `Node` + `/manifest.json`), and full offline playback.
// Writes repeatable evidence artifact to `desktop/target/e2e/hiverelay-result.json`.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import createTestnet from 'hyperdht/testnet.js'
import Corestore from 'corestore'
import Hyperswarm from 'hyperswarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import sodium from 'sodium-native'
import b4a from 'b4a'
import { createNode } from '../src/index.js'
import { createMirrorHost } from '../src/mirror.js'
import { createApi } from '../src/http.js'

const tmp = label => mkdtempSync(join(tmpdir(), `peartube-hr-${label}-`))
const sha256 = buf => createHash('sha256').update(buf).digest('hex')

const RELAY_DISCOVERY_TOPIC = (() => {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.from('hiverelay-discovery-v1'))
  return out
})()

async function until (fn, ms = 90_000, label = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const val = await fn()
    if (val) return val
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 200))
  }
}

// Decodes protobuf length-delimited fields so our wire-exact mock HiveRelay proves Hyperbee v2 Header + Node validity.
function decodePbFields (buf, start = 0, end = buf.byteLength) {
  const fields = new Map()
  let off = start
  const readVarint = () => {
    let val = 0, shift = 0
    while (off < end) {
      const b = buf[off++]
      val += (b & 0x7f) * (2 ** shift)
      if ((b & 0x80) === 0) return val
      shift += 7
    }
    throw new Error('Truncated protobuf varint')
  }
  while (off < end) {
    const tag = readVarint()
    const field = tag >>> 3
    const wire = tag & 7
    assert.equal(wire, 2, 'expected length-delimited protobuf wire type')
    const len = readVarint()
    fields.set(field, buf.subarray(off, off += len))
  }
  return fields
}

function verifySeedRequestV3 (msg) {
  const dkHash = b4a.alloc(32)
  if (msg.discoveryKeys.length > 0) {
    sodium.crypto_generichash(dkHash, b4a.concat(msg.discoveryKeys))
  }
  const meta = b4a.alloc(40)
  const view = new DataView(meta.buffer, meta.byteOffset, 40)
  view.setUint8(0, msg.replicationFactor)
  view.setUint8(1, msg.revocable ? 1 : 0)
  view.setUint8(2, msg.durability || 0)
  view.setBigUint64(8, BigInt(msg.maxStorageBytes), false)
  view.setBigUint64(16, BigInt(msg.ttlSeconds), false)
  view.setUint32(24, msg.bountyRate || 0, false)
  view.setBigUint64(28, BigInt(msg.unseedFreezeMs || 0), false)
  const preimage = b4a.concat([b4a.from('hiverelay.seed-request.v3\0'), msg.appKey, dkHash, meta])
  return sodium.crypto_sign_verify_detached(msg.publisherSignature, preimage, msg.publisherPubkey)
}

const seedReqEnc = {
  preencode (s, m) {
    c.fixed32.preencode(s, m.appKey)
    c.uint.preencode(s, m.discoveryKeys.length)
    for (const dk of m.discoveryKeys) c.fixed32.preencode(s, dk)
    c.uint.preencode(s, m.replicationFactor)
    c.string.preencode(s, m.geoPreference)
    c.uint.preencode(s, m.maxStorageBytes)
    c.uint.preencode(s, m.bountyRate)
    c.uint.preencode(s, m.ttlSeconds)
    c.fixed32.preencode(s, m.publisherPubkey)
    c.fixed64.preencode(s, m.publisherSignature)
    c.uint.preencode(s, m.revocable)
    c.uint.preencode(s, m.unseedFreezeMs)
    c.uint.preencode(s, m.durability)
  },
  encode (s, m) {
    c.fixed32.encode(s, m.appKey)
    c.uint.encode(s, m.discoveryKeys.length)
    for (const dk of m.discoveryKeys) c.fixed32.encode(s, dk)
    c.uint.encode(s, m.replicationFactor)
    c.string.encode(s, m.geoPreference)
    c.uint.encode(s, m.maxStorageBytes)
    c.uint.encode(s, m.bountyRate)
    c.uint.encode(s, m.ttlSeconds)
    c.fixed32.encode(s, m.publisherPubkey)
    c.fixed64.encode(s, m.publisherSignature)
    c.uint.encode(s, m.revocable)
    c.uint.encode(s, m.unseedFreezeMs)
    c.uint.encode(s, m.durability)
  },
  decode (s) {
    const appKey = c.fixed32.decode(s)
    const n = c.uint.decode(s)
    const discoveryKeys = []
    for (let i = 0; i < n; i++) discoveryKeys.push(c.fixed32.decode(s))
    return {
      appKey,
      discoveryKeys,
      replicationFactor: c.uint.decode(s),
      geoPreference: c.string.decode(s),
      maxStorageBytes: c.uint.decode(s),
      bountyRate: c.uint.decode(s),
      ttlSeconds: c.uint.decode(s),
      publisherPubkey: c.fixed32.decode(s),
      publisherSignature: c.fixed64.decode(s),
      revocable: s.start < s.end ? c.uint.decode(s) : 1,
      unseedFreezeMs: s.start < s.end ? c.uint.decode(s) : 0,
      durability: s.start < s.end ? c.uint.decode(s) : 0
    }
  }
}

const seedAccEnc = {
  preencode (s, m) {
    c.fixed32.preencode(s, m.appKey)
    c.fixed32.preencode(s, m.relayPubkey)
    c.string.preencode(s, m.region)
    c.uint.preencode(s, m.availableStorageBytes)
    c.fixed64.preencode(s, m.relaySignature)
  },
  encode (s, m) {
    c.fixed32.encode(s, m.appKey)
    c.fixed32.encode(s, m.relayPubkey)
    c.string.encode(s, m.region)
    c.uint.encode(s, m.availableStorageBytes)
    c.fixed64.encode(s, m.relaySignature)
  },
  decode: () => ({})
}

const seedUnseedEnc = {
  preencode () {},
  encode () {},
  decode () { return {} }
}

const seedDenyEnc = {
  preencode (s, m) {
    c.fixed32.preencode(s, m.appKey)
    c.fixed32.preencode(s, m.relayPubkey)
    c.string.preencode(s, m.reasonCode)
    c.string.preencode(s, m.detail)
    c.fixed64.preencode(s, m.relaySignature)
  },
  encode (s, m) {
    c.fixed32.encode(s, m.appKey)
    c.fixed32.encode(s, m.relayPubkey)
    c.string.encode(s, m.reasonCode)
    c.string.encode(s, m.detail)
    c.fixed64.encode(s, m.relaySignature)
  },
  decode: () => ({})
}

// Spins up a wire-faithful p2p-hiverelay v0.24.x / v0.26.x RelayNode + Seeder + SeedProtocol peer on the testnet.
async function startMockHiveRelay ({ bootstrap, apiKey = 'hr-secret', acceptMode = 'open', allowlist = [], region = 'NA', availableBytes = 50 * 1024 ** 3 }) {
  const store = new Corestore(tmp('hiverelay-store'))
  await store.ready()
  const publicKey = b4a.alloc(32)
  const secretKey = b4a.alloc(64)
  sodium.crypto_sign_keypair(publicKey, secretKey)
  const keyPair = { publicKey, secretKey }
  const pubkeyHex = b4a.toString(publicKey, 'hex')

  const swarm = new Hyperswarm({ bootstrap, keyPair })
  const seededCores = new Map()
  let verifiedBeaconManifest = null

  async function seedCore (coreKeyHex, maxStorageBytes) {
    const k = coreKeyHex.toLowerCase()
    if (seededCores.has(k)) return seededCores.get(k)
    const core = store.get({ key: b4a.from(k, 'hex') })
    await core.ready()
    swarm.join(core.discoveryKey, { server: true, client: true })
    await until(async () => {
      await core.update({ wait: false }).catch(() => {})
      return core.length > 0
    }, 30_000, `seedCore head sync ${k.slice(0, 12)}`)
    assert.ok(core.byteLength <= maxStorageBytes, `HiveRelay verified ${core.byteLength} <= ${maxStorageBytes}`)
    const range = core.download({ start: 0, end: -1 })
    const entry = { core, range, bytesStored: 0, bytesServed: 0 }
    core.on('download', (_idx, len) => { entry.bytesStored += len })
    core.on('upload', (_idx, len) => { entry.bytesServed += len })
    seededCores.set(k, entry)
    return entry
  }

  async function seedHyperdriveBeacon (appKeyBuf, maxStorageBytes) {
    const dbCore = store.get({ key: appKeyBuf })
    await dbCore.ready()
    swarm.join(dbCore.discoveryKey, { server: true, client: true })
    await until(async () => {
      await dbCore.update({ wait: false }).catch(() => {})
      return dbCore.length >= 2
    }, 30_000, 'Hyperdrive beacon db head sync')
    const headerFields = decodePbFields(await dbCore.get(0))
    assert.equal(b4a.toString(headerFields.get(1)), 'hyperbee')
    const metaFields = decodePbFields(headerFields.get(2))
    const contentFeedKey = metaFields.get(1)
    assert.equal(contentFeedKey.byteLength, 32)
    const blobsCore = store.get({ key: contentFeedKey })
    await blobsCore.ready()
    swarm.join(blobsCore.discoveryKey, { server: true, client: true })
    await until(async () => {
      await blobsCore.update({ wait: false }).catch(() => {})
      return blobsCore.length > 0
    }, 30_000, 'Hyperdrive beacon blobs head sync')
    assert.ok(dbCore.byteLength + blobsCore.byteLength <= maxStorageBytes)
    const nodeFields = decodePbFields(await dbCore.get(dbCore.length - 1))
    assert.equal(b4a.toString(nodeFields.get(2)), 'files\0/manifest.json')
    const entryVal = JSON.parse(b4a.toString(nodeFields.get(3)))
    const rawManifest = await blobsCore.get(entryVal.blob.blockOffset)
    verifiedBeaconManifest = JSON.parse(b4a.toString(rawManifest))
    seededCores.set(b4a.toString(appKeyBuf, 'hex'), { core: dbCore, range: dbCore.download({ start: 0, end: -1 }), bytesStored: dbCore.byteLength, bytesServed: 0 })
    seededCores.set(b4a.toString(contentFeedKey, 'hex'), { core: blobsCore, range: blobsCore.download({ start: 0, end: -1 }), bytesStored: blobsCore.byteLength, bytesServed: 0 })
  }

  swarm.on('connection', conn => {
    store.replicate(conn)
    const mux = Protomux.from(conn)
    let acceptMsg, denyMsg
    const ch = mux.createChannel({
      protocol: 'hiverelay-seed',
      id: null,
      handshake: c.raw,
      onopen (handshake) {
        const hs = JSON.parse(b4a.toString(handshake))
        assert.equal(hs.major, 1)
      }
    })
    ch.addMessage({
      encoding: seedReqEnc,
      async onmessage (msg) {
        const sendDeny = (reasonCode, detail) => {
          const sig = b4a.alloc(64)
          sodium.crypto_sign_detached(sig, b4a.concat([msg.appKey, publicKey, b4a.from(reasonCode)]), secretKey)
          denyMsg.send({ appKey: msg.appKey, relayPubkey: publicKey, reasonCode, detail, relaySignature: sig })
        }
        if (!verifySeedRequestV3(msg)) return sendDeny('bad-signature', 'invalid v3 signature')
        const pubHex = b4a.toString(msg.publisherPubkey, 'hex')
        if (acceptMode === 'review') return sendDeny('queued-for-review', 'parked for operator approval')
        if (acceptMode === 'allowlist' && !allowlist.map(x => x.toLowerCase()).includes(pubHex)) {
          return sendDeny('accept-mode:allowlist', 'not on allowlist')
        }
        if (availableBytes < msg.maxStorageBytes) {
          return sendDeny('insufficient-storage', `relay has ${availableBytes} bytes available, request asked for ${msg.maxStorageBytes}`)
        }
        try {
          await seedHyperdriveBeacon(msg.appKey, msg.maxStorageBytes)
          for (const dk of msg.discoveryKeys) {
            const hex = b4a.toString(dk, 'hex')
            if (hex !== b4a.toString(msg.appKey, 'hex')) await seedCore(hex, msg.maxStorageBytes)
          }
          const sig = b4a.alloc(64)
          sodium.crypto_sign_detached(sig, b4a.concat([msg.appKey, publicKey, b4a.from(region)]), secretKey)
          acceptMsg.send({ appKey: msg.appKey, relayPubkey: publicKey, region, availableStorageBytes: availableBytes, relaySignature: sig })
        } catch (err) {
          sendDeny('storage-admission-blocked', err.message)
        }
      }
    })
    acceptMsg = ch.addMessage({ encoding: seedAccEnc })
    ch.addMessage({ encoding: seedUnseedEnc })
    denyMsg = ch.addMessage({ encoding: seedDenyEnc })
    ch.open(b4a.from('{"major":1,"minor":0}'))
  })

  swarm.join(RELAY_DISCOVERY_TOPIC, { server: true, client: false })
  await swarm.flush()

  const srv = createServer(async (req, res) => {
    const json = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.method === 'GET' && (req.url === '/.well-known/hiverelay.json' || req.url === '/api/capabilities')) {
      return json(200, { schemaVersion: 1, pubkey: pubkeyHex, version: '0.24.4', region })
    }
    if (req.method === 'GET' && req.url === '/status') {
      return json(200, { running: true, publicKey: pubkeyHex, region })
    }
    if (req.method === 'POST' && req.url === '/seed-core') {
      if (apiKey && req.headers.authorization !== `Bearer ${apiKey}`) {
        return json(401, { error: 'Unauthorized — API key required for /seed-core' })
      }
      const chunks = []
      for await (const ch of req) chunks.push(ch)
      const body = JSON.parse(b4a.toString(b4a.concat(chunks)))
      if (!Number.isSafeInteger(body.maxStorageBytes) || body.maxStorageBytes <= 0) {
        return json(400, { error: 'maxStorageBytes must be a positive safe integer' })
      }
      try {
        const entry = await seedCore(body.coreKey, body.maxStorageBytes)
        return json(200, { ok: true, coreKey: body.coreKey, length: entry.core.length })
      } catch (err) {
        return json(503, { error: err.message })
      }
    }
    json(404, { error: 'not found' })
  })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${srv.address().port}`

  async function allFullyDownloaded (keys) {
    for (const k of keys) {
      const e = seededCores.get(k)
      if (!e || e.core.length === 0) return false
      if (e.core.core.bitfield.countSet(0, e.core.length) < e.core.length) return false
    }
    return true
  }

  let mockClosed = false
  async function close () {
    if (mockClosed) return
    mockClosed = true
    srv.closeAllConnections?.()
    await new Promise(resolve => srv.close(() => resolve()))
    for (const e of seededCores.values()) {
      try { e.range.destroy() } catch {}
      await e.core.close().catch(() => {})
    }
    for (const d of swarm.topics()) d._needsUnannounce = false
    await swarm.clear()
    await swarm.destroy({ force: true })
    await store.close()
  }

  return {
    url,
    pubkey: pubkeyHex,
    seededCores,
    get verifiedBeaconManifest () { return verifiedBeaconManifest },
    setAllowlist: keys => { allowlist = keys },
    allFullyDownloaded,
    close
  }
}

test('existing HiveRelays (HTTP /seed-core and P2P hiverelay-seed DHT) serve PearTube channels and watch magnets after origin goes offline', { timeout: 240_000 }, async t => {
  const testnet = await createTestnet(3)
  const cleanups = []
  const activeNodes = new Set()
  const trackNode = n => { activeNodes.add(n); return n }
  const closeNode = async n => {
    if (!activeNodes.has(n)) return
    activeNodes.delete(n)
    await n.close()
  }
  t.after(async () => {
    for (const fn of cleanups.reverse()) await fn().catch(() => {})
    for (const n of [...activeNodes].reverse()) await closeNode(n).catch(() => {})
    await testnet.destroy()
  })

  // ── Part 1: Operator-authed HiveRelay (`POST /seed-core`) ──────────────────
  const hrOperator = await startMockHiveRelay({ bootstrap: testnet.bootstrap, apiKey: 'blindspark-token', region: 'EU' })
  cleanups.push(() => hrOperator.close())

  const publisher1 = trackNode(await createNode({ storage: tmp('pub1'), bootstrap: testnet.bootstrap }))
  const video1Bytes = randomBytes(1300 * 1024 + 37) // > 2 x 512 KiB uniform Hyperblobs blocks
  const pub1Entry = await publisher1.publishChannel({ id: 'imdb:tt0133093', title: 'The Matrix Supplemental Cut' }, Readable.from([video1Bytes]))
  const pub1Channel = publisher1.status().channel

  const mirror1 = await createMirrorHost({
    node: publisher1,
    storage: tmp('mirror1'),
    acquirer: null,
    rechunk: false,
    hiverelay: `${hrOperator.url}=blindspark-token`,
    pollIntervalMs: 0
  })
  cleanups.push(() => mirror1.close())

  const run1 = await mirror1.run('hiverelay-seed')
  assert.equal(run1.cores, 2, 'pinned both channel core and 512 KiB blobs slot core')
  assert.equal(run1.httpErrors.length, 0, JSON.stringify(run1.httpErrors))
  assert.equal(run1.httpPinned, 2, JSON.stringify(run1))
  await until(() => hrOperator.allFullyDownloaded(run1.coreKeys), 60_000, 'HiveRelay #1 full block download')

  // Kill the origin publisher completely — ONLY hrOperator holds the channel & video blocks now!
  await mirror1.close()
  await closeNode(publisher1)

  // Viewer A subscribes to `peartube://channel/<pub1Channel>` and streams HTTP 206 Range + full file from HiveRelay #1.
  const viewerA = trackNode(await createNode({
    storage: tmp('viewer-a'),
    bootstrap: testnet.bootstrap,
    sources: [{ key: pub1Channel, kind: 'channel', alias: 'Matrix Vault' }]
  }))

  const hitA = await until(async () => (await viewerA.search('imdb:tt0133093'))[0], 90_000, 'Viewer A channel sync from HiveRelay #1')
  assert.equal(hitA.sha256, sha256(video1Bytes))
  const rangeRes = await fetch(hitA.streamUrl, { headers: { Range: 'bytes=520000-1060000' } })
  assert.equal(rangeRes.status, 206)
  assert.deepEqual(Buffer.from(await rangeRes.arrayBuffer()), video1Bytes.subarray(520000, 1060001))
  const fullA = Buffer.from(await (await fetch(hitA.streamUrl)).arrayBuffer())
  assert.equal(sha256(fullA), sha256(video1Bytes))

  // Shut Viewer A down too so Viewer B cannot cheat off Viewer A's cache!
  await closeNode(viewerA)

  // Viewer B has ZERO channels/trackers — opens ONLY a sourceless `peartube://watch/...` magnet and pulls directly from HiveRelay #1 via `core.discoveryKey`!
  const pureMagnet1 = pub1Entry.magnetUrl.replace(/&source=[0-9a-f]{64}(&kind=[a-z]+)?/i, '')
  const viewerB = trackNode(await createNode({ storage: tmp('viewer-b'), bootstrap: testnet.bootstrap }))
  const apiB = createApi({ node: viewerB, acquirer: null })
  await new Promise(resolve => apiB.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => apiB.close())
  const openB = await (await fetch(`http://127.0.0.1:${apiB.address().port}/v1/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uri: pureMagnet1 })
  })).json()
  assert.equal(openB.action, 'watch')
  const fullB = Buffer.from(await (await fetch(openB.entry.streamUrl)).arrayBuffer())
  assert.equal(sha256(fullB), sha256(video1Bytes), 'sourceless magnet viewer streamed exact bytes from HiveRelay #1')
  await closeNode(viewerB)
  await hrOperator.close()

  // ── Part 2: Zero-key P2P `hiverelay-discovery-v1` DHT (`review` + `allowlist` HiveRelays) ──
  const hrReview = await startMockHiveRelay({ bootstrap: testnet.bootstrap, apiKey: 'locked-1', acceptMode: 'review', region: 'US' })
  cleanups.push(() => hrReview.close())
  const hrAllowlist = await startMockHiveRelay({ bootstrap: testnet.bootstrap, apiKey: 'locked-2', acceptMode: 'allowlist', allowlist: [], region: 'AP', availableBytes: 40 * 1024 * 1024 })
  cleanups.push(() => hrAllowlist.close())

  const publisher2 = trackNode(await createNode({ storage: tmp('pub2'), bootstrap: testnet.bootstrap }))
  // Simulate an oversized sibling blob slot (48 MiB > hrAllowlist's 40 MiB cap) alongside a fitting 1.15 MiB movie slot + channel!
  const oversizedSlot = publisher2.store.get({ name: 'blobs-1' })
  await oversizedSlot.ready()
  await oversizedSlot.append(Array.from({ length: 96 }, () => randomBytes(512 * 1024)))
  await oversizedSlot.close()
  const video2Bytes = randomBytes(1150 * 1024 + 19)
  const pub2Entry = await publisher2.publishChannel({ id: 'imdb:tt0816692', title: 'Interstellar DHT Seeded' }, Readable.from([video2Bytes]))
  const pub2Channel = publisher2.status().channel
  const mirror2 = await createMirrorHost({
    node: publisher2,
    storage: tmp('mirror2'),
    acquirer: null,
    rechunk: false,
    hiverelay: { discover: true, replicas: 2 },
    pollIntervalMs: 0
  })
  cleanups.push(() => mirror2.close())

  const pluginSnapshot = mirror2.list().find(p => p.name === 'hiverelay-seed')
  assert.match(pluginSnapshot.publisherPubkey, /^[0-9a-f]{64}$/)
  hrAllowlist.setAllowlist([pluginSnapshot.publisherPubkey])

  // Wait for DHT discovery to connect both HiveRelays over `hiverelay-discovery-v1`, then broadcast `hiverelay.seed-request.v3`.
  await until(async () => {
    await mirror2.run('hiverelay-seed')
    const st = mirror2.list().find(p => p.name === 'hiverelay-seed')
    return st.p2pAcceptedRelays.some(r => r.pubkey === hrAllowlist.pubkey) &&
      st.p2pDeniedRelays.some(r => r.pubkey === hrReview.pubkey && r.reasonCode === 'queued-for-review') &&
      st
  }, 90_000, 'P2P HiveRelay allowlist acceptance + review queue telemetry')

  assert.equal(hrAllowlist.verifiedBeaconManifest?.channel, pub2Channel, 'HiveRelay decoded zero-dep Hyperdrive v11/v13 beacon manifest')
  const fittingKeys = [pub2Channel, pub2Entry.blobs]
  await until(() => hrAllowlist.allFullyDownloaded(fittingKeys), 60_000, 'HiveRelay #2 P2P full block download of fitting cores despite oversized sibling slot')
  assert.equal(hrAllowlist.seededCores.has(b4a.toString(oversizedSlot.key, 'hex')), false, 'oversized sibling slot cleanly skipped without poisoning fitting cores')
  const finalPluginInfo = mirror2.list().find(p => p.name === 'hiverelay-seed')

  // Kill Publisher 2 completely — Viewer C must pull catalog + 1.15 MiB video solely from the DHT-recruited HiveRelay!
  await mirror2.close()
  await closeNode(publisher2)

  const viewerC = trackNode(await createNode({
    storage: tmp('viewer-c'),
    bootstrap: testnet.bootstrap,
    sources: [{ key: pub2Channel, kind: 'channel', alias: 'Interstellar Feed' }]
  }))
  const hitC = await until(async () => (await viewerC.search('imdb:tt0816692'))[0], 90_000, 'Viewer C sync from P2P-recruited HiveRelay')
  const fullC = Buffer.from(await (await fetch(hitC.streamUrl)).arrayBuffer())
  assert.equal(sha256(fullC), sha256(video2Bytes), 'Viewer C streamed exact bytes from P2P-recruited HiveRelay while origin was dead')

  const artifactDir = join('desktop', 'target', 'e2e')
  mkdirSync(artifactDir, { recursive: true })
  const artifactPath = join(artifactDir, 'hiverelay-result.json')
  writeFileSync(artifactPath, JSON.stringify({
    test: 'hiverelay supplemental seeder e2e',
    at: new Date().toISOString(),
    httpSeedCore: {
      relayPubkey: hrOperator.pubkey,
      pinnedCores: run1.coreKeys.length,
      offlineRangeVerified: true,
      offlineChannelFullBytes: fullA.byteLength,
      offlineSourcelessMagnetBytes: fullB.byteLength,
      sha256Verified: sha256(fullB) === sha256(video1Bytes)
    },
    p2pDhtSeedProtocol: {
      publisherPubkey: finalPluginInfo.publisherPubkey,
      beaconDriveKey: finalPluginInfo.beaconDriveKey,
      acceptedRelays: finalPluginInfo.p2pAcceptedRelays,
      reviewQueuedRelays: finalPluginInfo.p2pDeniedRelays,
      offlineChannelFullBytes: fullC.byteLength,
      sha256Verified: sha256(fullC) === sha256(video2Bytes)
    }
  }, null, 2) + '\n')
})
