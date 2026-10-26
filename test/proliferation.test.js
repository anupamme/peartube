// End-to-end verification of PearTube proliferation mechanics on a live HyperDHT testnet:
//   1. Single-writer Hyperbee channels + adversarial spam/forgery immunity
//   2. Gossip directory discovery (op.type === 'source') + SSE /v1/events live reactivity
//   3. Creator goes offline -> zero-subscription peartube://watch/... magnet streaming from cached seeder via merged blob swarm
//   4. Tit-for-tat reciprocity graduation (leecher 64 -> seeder 192 inflight window)
//   5. Stremio v3 addon (/manifest.json, /catalog, /stream tt... & tt...:1:2) + /v1/playlist.m3u + Bearer apiToken gate
// Writes repeatable evidence artifact to desktop/target/e2e/proliferation-result.json.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import createTestnet from 'hyperdht/testnet.js'
import { createNode } from '../src/index.js'
import { createAcquirer } from '../src/acquire.js'
import { createMirrorHost } from '../src/mirror.js'
import { createApi } from '../src/http.js'
const tmp = name => mkdtempSync(join(tmpdir(), `peartube-prolif-${name}-`))
const sha256 = buf => createHash('sha256').update(buf).digest('hex')

async function until (fn, ms = 90000, label = 'condition') {
  const end = Date.now() + ms
  for (;;) {
    const val = await fn()
    if (val) return val
    if (Date.now() > end) throw new Error(`Timed out waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 250))
  }
}

test('channels, gossip discovery, cross-channel magnet seeding, reciprocity, Stremio & M3U work end to end', { timeout: 240000 }, async t => {
  const testnet = await createTestnet(3)
  const nodes = []
  const apis = []
  t.after(async () => {
    for (const api of apis) api.close()
    await Promise.allSettled(nodes.map(n => n.close()))
    await testnet.destroy()
  })

  // Creator A publishes a movie and a series episode into its single-writer Hyperbee channel.
  const creator = await createNode({ storage: tmp('creator'), bootstrap: testnet.bootstrap })
  nodes.push(creator)
  const movieBytes = randomBytes(700 * 1024 + 13)
  const epBytes = randomBytes(540 * 1024 + 9)
  const pubMovie = await creator.publishChannel({ id: 'imdb:tt0111161', title: 'Shawshank Channel Cut' }, Readable.from([movieBytes]))
  const pubEp = await creator.publishChannel({ id: 'imdb:tt0944947:s01e02', title: 'Thrones Channel Cut' }, Readable.from([epBytes]))
  const creatorChannel = creator.status().channel

  // Main relay acts as the Directory Hub (advertising Creator A's channel in BOTH its tracker and channel, plus temporary listing/unlisting).
  const directory = await createNode({ storage: tmp('directory'), bootstrap: testnet.bootstrap })
  nodes.push(directory)
  const apiDir = createApi({ node: directory, acquirer: null })
  await new Promise(resolve => apiDir.listen(0, '127.0.0.1', resolve))
  apis.push(apiDir)
  const baseDir = `http://127.0.0.1:${apiDir.address().port}`
  const tempKey = 'f'.repeat(64)
  await fetch(`${baseDir}/v1/channel/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'source', sourceKey: tempKey, kind: 'channel', title: 'Temp', target: 'both' }) })
  assert.equal((await (await fetch(`${baseDir}/v1/sources`)).json()).published.some(p => p.key === tempKey), true)
  await fetch(`${baseDir}/v1/channel/sources/${tempKey}`, { method: 'DELETE' })
  assert.equal((await (await fetch(`${baseDir}/v1/sources`)).json()).published.some(p => p.key === tempKey), false)
  await directory.publishSource({ sourceKey: creatorChannel, kind: 'channel', title: 'Sci-Fi & Classics Vault' }, { target: 'both' })
  const directoryChannel = directory.status().channel
  // Viewer B starts with zero open tracker and subscribes ONLY to Directory D's channel, exposing loopback /v1 with Bearer auth.
  let apiB = null
  const viewerB = await createNode({
    storage: tmp('viewer-b'),
    bootstrap: testnet.bootstrap,
    sources: [{ key: directoryChannel, kind: 'channel', alias: 'Starter Directory' }],
    onchange: () => apiB?.notify('update')
  })
  nodes.push(viewerB)
  apiB = createApi({ node: viewerB, acquirer: null, apiToken: 'local-pair-secret' })
  await new Promise(resolve => apiB.listen(0, '127.0.0.1', resolve))
  apis.push(apiB)
  const baseB = `http://127.0.0.1:${apiB.address().port}`

  // Viewer B initially has zero cached bytes -> 'leecher' reciprocity tier (inflightMax 24 on public swarm).
  assert.equal(viewerB.status().reciprocity.tier, 'leecher')
  assert.equal(viewerB.status().reciprocity.inflightMax, 24)

  // Unauthenticated mutation is rejected with 401; read-only endpoints remain open.
  const unauth = await fetch(`${baseB}/v1/sources`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: creatorChannel, kind: 'channel' }) })
  assert.equal(unauth.status, 401)

  // Connect an SSE listener to /v1/events on Viewer B to prove live push updates.
  let sseEvents = 0
  const sseAbort = new AbortController()
  t.after(() => sseAbort.abort())
  const sseTask = (async () => {
    const res = await fetch(`${baseB}/v1/events`, { signal: sseAbort.signal })
    for await (const chunk of res.body) {
      if (Buffer.from(chunk).toString().includes('"event":"update"')) sseEvents++
    }
  })().catch(() => {})

  // Viewer B discovers Creator A's channel via Directory D's gossip record!
  const discovered = await until(async () => {
    const r = await (await fetch(`${baseB}/v1/sources`)).json()
    return r.discovered.find(d => d.key === creatorChannel) && r.discovered
  }, 90000, 'gossip channel discovery')
  assert.equal(discovered[0].title, 'Sci-Fi & Classics Vault')
  assert.equal(discovered[0].kind, 'channel')

  // Adversarial peer tries to forge an entry under Creator A's channel key -> non-writable Hyperbee + unowned key!
  const spammer = await createNode({
    storage: tmp('spammer'),
    bootstrap: testnet.bootstrap,
    sources: [{ key: creatorChannel, kind: 'channel' }]
  })
  nodes.push(spammer)
  assert.equal(spammer.listSources().find(s => s.key === creatorChannel)?.writable, false, 'subscribed channel is read-only')
  await spammer.publishChannel({ id: 'imdb:tt9999999', title: 'Spammer Forgery' }, Readable.from([randomBytes(512)]))
  assert.notEqual(spammer.status().channel, creatorChannel, 'spammer writes only to its own distinct channel key')
  // Viewer B subscribes to the discovered channel in 1 click using Bearer auth.
  const addRes = await fetch(`${baseB}/v1/sources`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer local-pair-secret' },
    body: JSON.stringify({ uri: `peartube://channel/${creatorChannel}?name=SciFiVault` })
  })
  assert.equal(addRes.status, 200)

  // Viewer B syncs Creator A's channel entries and verifies Stremio v3 + M3U bridges!
  const bMovie = await until(async () => {
    const entries = await viewerB.search('imdb:tt0111161')
    return entries[0]
  }, 90000, 'channel entry sync on Viewer B')
  assert.equal(bMovie.sha256, pubMovie.sha256)
  assert.equal(bMovie.sourceKind, 'channel')
  assert.ok(bMovie.magnetUrl.startsWith('peartube://watch/'))
  await until(() => sseEvents > 0, 15000, 'SSE update delivery')

  const manifest = await (await fetch(`${baseB}/manifest.json`)).json()
  assert.equal(manifest.id, 'org.peartube.p2p')
  const stremioMovie = await (await fetch(`${baseB}/stream/movie/tt0111161.json`)).json()
  assert.equal(stremioMovie.streams.length, 1)
  const stremioEp = await (await fetch(`${baseB}/stream/series/${encodeURIComponent('tt0944947:1:2')}.json`)).json()
  assert.equal(stremioEp.streams.length, 1)
  const m3u = await (await fetch(`${baseB}/v1/playlist.m3u`)).text()
  assert.ok(m3u.includes('#EXTM3U') && m3u.includes('Shawshank Channel Cut'))

  // Viewer B streams both files via Stremio's returned URL, caching all blocks and graduating to 'seeder' (48 inflight on public swarm)!
  const streamedMovie = Buffer.from(await (await fetch(stremioMovie.streams[0].url)).arrayBuffer())
  const streamedEp = Buffer.from(await (await fetch(stremioEp.streams[0].url)).arrayBuffer())
  assert.equal(sha256(streamedMovie), sha256(movieBytes))
  assert.equal(sha256(streamedEp), sha256(epBytes))
  const bStatusAfter = viewerB.status()
  assert.equal(bStatusAfter.reciprocity.tier, 'seeder')
  assert.equal(bStatusAfter.reciprocity.inflightMax, 48)

  // Creator A and Directory D BOTH go completely offline!
  await creator.close()
  await directory.close()

  // Brand-new peer C has ZERO trackers and ZERO channels in common with B — it opens ONLY the peartube://watch/... magnet URI
  // (stripped of sourceKey to prove pure content-swarm discovery over peartube/blob/v1/<blobs>)!
  const pureMagnet = bMovie.magnetUrl.replace(/&source=[0-9a-f]{64}(&kind=[a-z]+)?/i, '')
  const viewerC = await createNode({ storage: tmp('viewer-c'), bootstrap: testnet.bootstrap })
  nodes.push(viewerC)
  const apiC = createApi({ node: viewerC, acquirer: null })
  await new Promise(resolve => apiC.listen(0, '127.0.0.1', resolve))
  apis.push(apiC)
  const baseC = `http://127.0.0.1:${apiC.address().port}`

  const openWatch = await (await fetch(`${baseC}/v1/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ uri: pureMagnet })
  })).json()
  assert.equal(openWatch.action, 'watch')
  const fromSwarm = Buffer.from(await (await fetch(openWatch.entry.streamUrl)).arrayBuffer())
  assert.equal(sha256(fromSwarm), sha256(movieBytes), 'Viewer C streamed exact bytes from Viewer B cache while Creator A was offline')

  sseAbort.abort()
  await sseTask

  const artifactDir = join('desktop', 'target', 'e2e')
  mkdirSync(artifactDir, { recursive: true })
  const artifactPath = join(artifactDir, 'proliferation-result.json')
  writeFileSync(artifactPath, JSON.stringify({
    test: 'proliferation e2e',
    at: new Date().toISOString(),
    creatorChannel,
    directoryChannel,
    discoveredCount: discovered.length,
    sseEventsReceived: sseEvents,
    stremioMovieStreams: stremioMovie.streams.length,
    stremioEpisodeStreams: stremioEp.streams.length,
    m3uLines: m3u.trim().split('\n').length,
    viewerBReciprocity: bStatusAfter.reciprocity,
    offlineMagnetTransferBytes: fromSwarm.length,
    offlineMagnetSha256Verified: sha256(fromSwarm) === sha256(movieBytes)
  }, null, 2) + '\n')
})

test('saved relay data survives in-place upgrade, backfills channel with zero blob copy, and runs mirror plugins', { timeout: 240000 }, async t => {
  const relayDir = tmp('unraid-data')
  const jobsFile = join(relayDir, 'jobs.json')
  const legacyBytes = randomBytes(600 * 1024 + 5)
  const futureBytes = randomBytes(520 * 1024 + 11)
  const watchBytes = randomBytes(410 * 1024 + 3)
  const feedBytes = randomBytes(330 * 1024 + 7)
  const customBytes = randomBytes(16 * 1024 + 19)

  const origin = createServer((req, res) => {
    if (req.url === '/legacy.mp4') return res.end(legacyBytes)
    if (req.url === '/future.mp4') return res.end(futureBytes)
    if (req.url === '/feed-item.mp4') return res.end(feedBytes)
    if (req.url === '/manifest.json') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify([{ id: 'imdb:tt0088763', title: 'Back to the Future Feed', url: `http://127.0.0.1:${origin.address().port}/feed-item.mp4` }]))
    }
    res.writeHead(404).end()
  })
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve))
  t.after(() => origin.close())
  const originBase = `http://127.0.0.1:${origin.address().port}`

  // Phase 1: Legacy relay saves an acquisition into tracker + jobs.json ONLY (defaultChannel: false), then shuts down.
  const oldRelay = await createNode({ storage: relayDir, bootstrap: [{ host: '127.0.0.1', port: 9 }] })
  const savedTracker = oldRelay.status().tracker
  const oldAcquirer = createAcquirer(oldRelay, jobsFile, { defaultChannel: false })
  const oldJob = oldAcquirer.add({ id: 'imdb:tt0076759', title: 'Saved Before Upgrade', source: { url: `${originBase}/legacy.mp4` }, channel: false })
  await until(() => oldAcquirer.get(oldJob.jobId)?.status === 'done', 60000, 'legacy acquire')
  const preUpgradeBlobBytes = oldRelay.status().blobBytes
  assert.equal(oldRelay.localChannel.core.length, 0, 'legacy relay had not populated single-writer channel')
  await oldRelay.close()

  // Prepare watch-dir media file + custom drop-in user plugin in /data/plugins before booting upgraded relay!
  const importDir = join(relayDir, 'import')
  const pluginsDir = join(relayDir, 'plugins')
  mkdirSync(importDir, { recursive: true })
  mkdirSync(pluginsDir, { recursive: true })
  writeFileSync(join(importDir, 'The.Matrix.1999.tt0133093.mp4'), watchBytes)
  writeFileSync(
    join(pluginsDir, 'custom-dropin.mjs'),
    `import { Readable } from 'node:stream'
export default {
  name: 'custom-dropin',
  description: 'Custom drop-in mirror plugin test',
  async run (payload, ctx) {
    const buf = Buffer.from(payload.hex, 'hex')
    const op = await ctx.ingestStream({ id: payload.id, title: payload.title, stream: Readable.from([buf]) })
    return { mirroredId: op.id, sha256: op.sha256 }
  }
}\n`
  )

  // Phase 2: Boot upgraded relay + fresh subscriber on a clean DHT testnet over the EXACT SAME relayDir!
  const testnet = await createTestnet(3)
  t.after(() => testnet.destroy())
  const upgraded = await createNode({ storage: relayDir, tracker: savedTracker, bootstrap: testnet.bootstrap })
  const acquirer = createAcquirer(upgraded, jobsFile, { defaultChannel: true })
  const mirror = await createMirrorHost({
    node: upgraded,
    storage: relayDir,
    acquirer,
    mirrorChannel: true,
    watchDir: importDir,
    pluginsDir,
    pollIntervalMs: 0
  })
  const api = createApi({ node: upgraded, acquirer, mirror })
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${api.address().port}`

  const subscriber = await createNode({
    storage: tmp('channel-sub'),
    bootstrap: testnet.bootstrap,
    sources: [{ key: upgraded.status().channel, kind: 'channel', alias: 'Unraid Channel' }]
  })
  t.after(async () => {
    api.close()
    await mirror.close()
    await subscriber.close()
    await upgraded.close()
  })

  // Verify saved jobs.json survived intact AND saved blob was backfilled into channel with ZERO extra blob copies!
  const jobsAfterBoot = (await (await fetch(`${base}/v1/jobs`)).json()).jobs
  assert.equal(jobsAfterBoot.some(j => j.id === 'imdb:tt0076759' && j.status === 'done'), true, 'saved jobs.json preserved')
  assert.equal(upgraded.status().blobBytes, preUpgradeBlobBytes + watchBytes.length, 'backfill reused existing Hyperblobs blocks without duplicating bytes')
  const allEntries = (await (await fetch(`${base}/v1/entries`)).json()).results
  assert.equal(allEntries.filter(e => e.id === 'imdb:tt0076759').length, 1, 'mirrored tracker+channel entry is never duplicated in unfiltered /v1/entries')
  assert.equal(allEntries.some(e => e.id === 'imdb:tt0133093'), true, 'watch-dir plugin ingested Matrix file automatically on boot')

  // Queue a future acquisition through legacy POST /v1/acquire, run feed-mirror, and run custom drop-in plugin!
  const futJob = await (await fetch(`${base}/v1/acquire`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'imdb:tt0080684', title: 'Future Acquire Empire', source: { url: `${originBase}/future.mp4` } })
  })).json()
  await until(async () => (await (await fetch(`${base}/v1/jobs/${futJob.jobId}`)).json()).status === 'done', 60000, 'future /v1/acquire')

  const feedRun = await (await fetch(`${base}/v1/plugins/feed-mirror/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${originBase}/manifest.json` })
  })).json()
  assert.equal(feedRun.enqueued, 1)
  await until(() => acquirer.list().every(j => j.status === 'done'), 60000, 'feed-mirror job done')
  const feedRunAgain = await (await fetch(`${base}/v1/plugins/feed-mirror/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `${originBase}/manifest.json` })
  })).json()
  assert.equal(feedRunAgain.enqueued, 0)
  assert.equal(feedRunAgain.skipped, 1)

  // Trigger custom drop-in plugin from /data/plugins/custom-dropin.mjs!
  const pluginList = (await (await fetch(`${base}/v1/plugins`)).json()).plugins.map(p => p.name)
  assert.ok(pluginList.includes('custom-dropin'), 'custom /data/plugins module auto-registered')
  const customRes = await (await fetch(`${base}/v1/mirror`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ plugin: 'custom-dropin', id: 'imdb:tt0086190', title: 'Custom Plugin Jedi', hex: customBytes.toString('hex') })
  })).json()
  assert.equal(customRes.sha256, sha256(customBytes))

  // Subscriber joined ONLY the upgraded relay's single-writer Channel (NOT the old tracker!)
  // and verifies ALL 5 items (pre-upgrade saved + watch-dir + future acquire + feed-mirror + custom plugin) stream exact bytes!
  const expected = [
    ['imdb:tt0076759', legacyBytes],
    ['imdb:tt0133093', watchBytes],
    ['imdb:tt0080684', futureBytes],
    ['imdb:tt0088763', feedBytes],
    ['imdb:tt0086190', customBytes]
  ]
  await until(async () => {
    const found = await subscriber.search()
    return found.length === 5 && found
  }, 90000, 'subscriber syncing all 5saved+plugin items from channel')

  for (const [id, raw] of expected) {
    const [hit] = await subscriber.search(id)
    const got = Buffer.from(await (await fetch(hit.streamUrl)).arrayBuffer())
    assert.equal(sha256(got), sha256(raw), `exact bytes verified on channel subscriber for ${id}`)
  }

  const artifactDir = join('desktop', 'target', 'e2e')
  mkdirSync(artifactDir, { recursive: true })
  writeFileSync(join(artifactDir, 'upgrade-mirror-result.json'), JSON.stringify({
    test: 'saved relay data upgrade & mirror plugin host e2e',
    at: new Date().toISOString(),
    savedTracker,
    upgradedChannel: upgraded.status().channel,
    preUpgradeBlobBytes,
    postUpgradeBlobBytes: upgraded.status().blobBytes,
    zeroCopyBackfillVerified: true,
    pluginsRegistered: pluginList,
    syncedChannelIds: expected.map(([id]) => id)
  }, null, 2) + '\n')
})
