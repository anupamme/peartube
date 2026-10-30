// Where does streaming throughput go? One 100 MB blob, three readings:
//   1. the local blob server (core -> HTTP, no peers)
//   2. a peer across a HyperDHT testnet (P2P replication + the same blob server)
//   3. four concurrent ranges from that peer (is one reader serialising the pipeline?)
// Writes desktop/target/e2e/stream-throughput-result.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'

const MB = 200
const tmp = label => mkdtempSync(join(tmpdir(), `peartube-speed-${label}-`))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function readRange (url, from, to) {
  const started = performance.now()
  const res = await fetch(url, { headers: { range: `bytes=${from}-${to}` } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  let bytes = 0
  for await (const chunk of res.body) bytes += chunk.length
  const seconds = (performance.now() - started) / 1000
  // Prime the connection: the first range pays for the seek and the core waking up.
  return { bytes, seconds, mbs: bytes / 1e6 / seconds }
}

test('stream throughput: local, peer-to-peer, and concurrent ranges', { timeout: 600_000 }, async () => {
  const testnet = await createTestnet(3)
  const cleanups = []
  try {
    const writer = await createNode({ storage: tmp('writer'), bootstrap: testnet.bootstrap })
    cleanups.push(() => writer.close())
    const blob = Buffer.alloc(MB * 1024 * 1024, 5)
    const putStarted = performance.now()
    const op = await writer.put({ id: 'clip:speed', title: 'Speed Probe' }, Readable.from([blob]))
    const putSeconds = (performance.now() - putStarted) / 1000

    const localUrl = writer.streamUrl(op)
    const local = await readRange(localUrl, 0, MB * 1024 * 1024 - 1)
    console.log(`# stage local ${local.mbs.toFixed(1)} MB/s in ${local.seconds.toFixed(1)} s`)

    await writer.append(op)
    const viewer = await createNode({ storage: tmp('viewer'), bootstrap: testnet.bootstrap, tracker: writer.status().tracker })
    cleanups.push(() => viewer.close())
    let entry = null
    for (let i = 0; i < 60 && !entry; i++) {
      entry = (await viewer.search()).find(e => e.id === 'clip:speed') || null
      if (!entry) await sleep(2000)
    }
    assert.ok(entry?.streamUrl, 'the viewer lists the entry with a blob URL')
    // A local testnet only connects after dht-rpc's NAT check; a read started before the peer is
    // live credits nothing and waits on blocks for as long as undici's body timeout allows.
    let peers = 0
    for (let i = 0; i < 60; i++) {
      peers = viewer.status().peers || 0
      if (peers > 0) break
      await sleep(2000)
    }
    assert.ok(peers > 0, 'the viewer connects to the writer before reading')
    console.log(`# stage connected ${peers} peer(s)`)
    // Single stream on the first half; four parallel streams on the *other* half, still uncached,
    // so the concurrent reading measures replication rather than the local core.
    const half = MB * 1024 * 1024 / 2
    const peer = await readRange(entry.streamUrl, 0, half - 1)
    console.log(`# stage peer ${peer.mbs.toFixed(1)} MB/s in ${peer.seconds.toFixed(1)} s`)

    const quarter = half / 4
    const started = performance.now()
    const parts = await Promise.all([0, 1, 2, 3].map(i => readRange(entry.streamUrl, half + i * quarter, half + (i + 1) * quarter - 1)))
    const concurrent = {
      bytes: parts.reduce((sum, p) => sum + p.bytes, 0),
      seconds: (performance.now() - started) / 1000,
    }
    concurrent.mbs = concurrent.bytes / 1e6 / concurrent.seconds
    console.log(`# stage concurrent ${concurrent.mbs.toFixed(1)} MB/s in ${concurrent.seconds.toFixed(1)} s`)

    const result = {
      blockSize: 512 * 1024,
      putMBs: MB / putSeconds,
      local: { mbs: local.mbs, seconds: local.seconds },
      peer: { mbs: peer.mbs, seconds: peer.seconds },
      concurrent: { mbs: concurrent.mbs, seconds: concurrent.seconds, streams: 4 }
    }
    mkdirSync('desktop/target/e2e', { recursive: true })
    writeFileSync('desktop/target/e2e/stream-throughput-result.json', JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))

    // Loose floors: catch a real regression, not a slow CI box.
    assert.ok(result.local.mbs > 50, `local blob server ${result.local.mbs.toFixed(1)} MB/s`)
    assert.ok(result.peer.mbs > 10, `peer throughput ${result.peer.mbs.toFixed(1)} MB/s`)
  } finally {
    for (const fn of cleanups.reverse()) await fn().catch(() => {})
    await testnet.destroy().catch(() => {})
  }
})
