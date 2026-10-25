import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { Readable } from 'node:stream'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import HyperDHT from 'hyperdht'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'peartube-private-discovery-'))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

async function until (fn, ms = 120000) {
  const end = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() > end) throw new Error('Private peers did not converge')
    await wait(500)
  }
}

test('a private-only seeder streams exact bytes without appearing in the tracker DHT announcement', { timeout: 240000 }, async t => {
  const testnet = await createTestnet(3)
  const nodes = []
  let observer
  t.after(async () => {
    await Promise.allSettled(nodes.map(node => node.close()))
    await observer?.destroy({ force: true })
    await testnet.destroy()
  })
  const relay = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, privateRouting: true, privateRelay: true })
  nodes.push(relay)
  const tracker = relay.status().tracker
  for (let i = 0; i < 3; i++) {
    const next = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker, privateRouting: true, privateRelay: true })
    nodes.push(next)
  }
  const seeder = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker, privateRouting: true })
  nodes.push(seeder)
  const reader = await createNode({ storage: tmp(), bootstrap: testnet.bootstrap, tracker, privateRouting: true })
  nodes.push(reader)
  const bytes = randomBytes(1024 * 1024 + 17)
  await seeder.publish({ id: 'imdb:tt0100001', title: 'Private seeder' }, Readable.from([bytes]))
  const [entry] = await until(async () => (await reader.search('imdb:tt0100001')).length && reader.search('imdb:tt0100001'))
  const response = await fetch(entry.streamUrl)
  assert.equal(response.status, 200)
  assert.equal(createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex'), entry.sha256)
  assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex'))
  const transferred = reader.status()
  assert.ok(transferred.routes.private.rxBytes >= bytes.length, 'the uncached bytes entered over private circuits')
  assert.equal(transferred.routes.public.rxBytes, 0, 'no public DHT stream carried the bytes')
  assert.equal(transferred.routes.lan.rxBytes, 0, 'no LAN stream carried the bytes')
  assert.equal(transferred.rxBytes, transferred.routes.private.rxBytes, 'the path counters account for all received bytes')
  assert.ok(seeder.status().routes.private.txBytes >= bytes.length, 'the seeder sent the bytes over private circuits')

  observer = new HyperDHT({ bootstrap: testnet.bootstrap, port: 0 })
  const topic = createHash('sha256').update('peartube/private/v1/').update(Buffer.from(tracker, 'hex')).update(String(Math.floor(Date.now() / 86_400_000))).digest()
  const discovered = new Set()
  for await (const reply of observer.lookup(topic)) {
    for (const peer of reply.peers) discovered.add(Buffer.from(peer.publicKey).toString('hex'))
  }
  assert.ok(discovered.has(Buffer.from(relay.swarm.keyPair.publicKey).toString('hex')), 'a public relay remains discoverable')
  assert.equal(discovered.has(Buffer.from(seeder.swarm.keyPair.publicKey).toString('hex')), false, 'the private seeder does not announce its own IP')
  assert.equal(discovered.has(Buffer.from(reader.swarm.keyPair.publicKey).toString('hex')), false, 'the private reader does not announce its own IP')
  const publicWriterRelayKey = Buffer.from(HyperDHT.keyPair(Buffer.from(relay.status().writer, 'hex')).publicKey).toString('hex')
  const relayDirectory = new Set()
  for await (const reply of observer.lookup(HyperDHT.hash(Buffer.from('hyperdht/private-route-relays/v7/0')))) {
    for (const peer of reply.peers) relayDirectory.add(Buffer.from(peer.publicKey).toString('hex'))
  }
  assert.ok(relayDirectory.size > 0, 'the public relay directory is reachable')
  assert.equal(relayDirectory.has(publicWriterRelayKey), false, 'a published writer key cannot derive a relay private identity')
  const artifact = join(tmp(), 'result.json')
  writeFileSync(artifact, JSON.stringify({
    bytes: bytes.length,
    sha256: entry.sha256,
    privateSeederConnected: seeder.status().peers > 0,
    readerConnected: reader.status().peers > 0,
    relayAnnounced: true,
    routes: transferred.routes,
    privateEndpointsAnnounced: false
  }, null, 2))
  console.log(`Private seeding evidence: ${artifact}`)
})
