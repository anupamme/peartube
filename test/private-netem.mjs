// Run only on a Linux machine with Podman, CAP_NET_ADMIN and an existing
// PearTube image with Node and tc. The shared-namespace fallback shapes lo in
// the disposable test namespace, never the host or production containers.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const usage = 'node test/private-netem.mjs --media <fixture.mp4> [--readers N] [--relays N] [--delay-ms N] [--jitter-ms N] [--loss-percent N] [--churn] [--shared-namespace] [--out DIR] [--image NAME]'
const { values: opts } = parseArgs({ options: {
  media: { type: 'string' }, readers: { type: 'string', default: '4' }, relays: { type: 'string', default: '3' },
  'delay-ms': { type: 'string', default: '80' }, 'jitter-ms': { type: 'string', default: '15' },
  'loss-percent': { type: 'string', default: '1' }, churn: { type: 'boolean', default: false },
  'shared-namespace': { type: 'boolean', default: false },
  out: { type: 'string' }, image: { type: 'string', default: 'localhost/peartube-relay:private-routing-secret-identity' },
  help: { type: 'boolean', short: 'h' }
} })
if (opts.help) { console.log(usage); process.exit(0) }
const numbers = Object.fromEntries(['readers', 'relays', 'delay-ms', 'jitter-ms', 'loss-percent'].map(key => [key, Number(opts[key])]))
if (!opts.media || !existsSync(opts.media) || !Number.isInteger(numbers.readers) || numbers.readers < 1 || numbers.readers > 24 ||
    !Number.isInteger(numbers.relays) || numbers.relays < 2 || numbers.relays > 16 ||
    !Number.isInteger(numbers['delay-ms']) || numbers['delay-ms'] < 0 || numbers['delay-ms'] > 2000 ||
    !Number.isInteger(numbers['jitter-ms']) || numbers['jitter-ms'] < 0 || numbers['jitter-ms'] > numbers['delay-ms'] ||
    !Number.isFinite(numbers['loss-percent']) || numbers['loss-percent'] < 0 || numbers['loss-percent'] > 20) throw new Error(usage)
const out = resolve(opts.out || join('android', 'build', 'e2e-private-netem', `run-${Date.now()}`))
if (existsSync(join(out, 'result.json'))) throw new Error(`Refusing to overwrite previous evidence: ${out}`)
const prefix = `ptbench-${process.pid}-${Date.now().toString(36)}`
const network = prefix
const containers = []
const evidence = {
  schema: 'peartube.private-netem.v1', startedAt: new Date().toISOString(), out,
  engine: null, topology: null,
  image: opts.image, config: { ...numbers, churn: opts.churn, sharedNamespace: opts['shared-namespace'] }, impairment: { applied: false, qdiscs: {} },
  fixture: null, tracker: null, readers: [], churn: [], passed: false, error: null
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
let engine = null
async function detectEngine () {
  if (engine) return engine
  for (const bin of ['podman', 'docker']) {
    try { await exec(bin, ['info'], { timeout: 10_000 }); engine = bin; return bin } catch {}
  }
  throw new Error('Neither podman nor docker daemon is running')
}
async function podman (...args) {
  const bin = await detectEngine()
  const { stdout } = await exec(bin, args, { timeout: 60_000, maxBuffer: 4 << 20 })
  return stdout.trim()
}
async function snapshot (name) {
  try { return JSON.parse(await readFile(join(out, name, 'result.json'), 'utf8')) } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}
async function until (name, predicate, ms = 180_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const state = await snapshot(name)
    if (state?.phase === 'failed') throw new Error(`${name}: ${state.error}`)
    if (state && predicate(state)) return state
    if (Date.now() >= deadline) {
      const logs = await podman('logs', `${prefix}-${name}`).catch(() => '')
      throw new Error(`${name} did not reach the expected stage (${ms}ms): ${logs.slice(-1000)}`)
    }
    await wait(250)
  }
}
let nextSubnetOctet = 1
async function start (role, name, options = [], shape = false) {
  await mkdir(join(out, name), { recursive: true })
  const id = `${prefix}-${name}`
  const bin = await detectEngine()
  const ro = bin === 'podman' ? 'ro,z' : 'ro'
  const rw = bin === 'podman' ? 'rw,z' : 'rw'
  const mounts = [
    '-v', `${join(out, 'code')}:/app/test:${ro}`,
    '-v', `${join(out, 'code', 'index.js')}:/app/src/index.js:${ro}`,
    '-v', `${join(out, 'code', 'private-overlay.js')}:/app/src/private-overlay.js:${ro}`,
    '-v', `${join(out, name)}:/bench/out:${rw}`
  ]
  const delay = numbers['delay-ms'], jitter = numbers['jitter-ms'], loss = numbers['loss-percent']
  const dev = opts['shared-namespace'] ? 'lo' : 'eth0'
  const shell = shape ? `tc qdisc replace dev ${dev} root netem limit 10000 delay ${delay}ms ${jitter}ms loss ${loss}% && tc qdisc show dev ${dev} && exec node "$@"` : 'exec node "$@"'
  const namespace = opts['shared-namespace'] && role !== 'testnet' ? `container:${prefix}-testnet` : network
  const ipArgs = opts['shared-namespace'] ? [] : ['--ip', `10.204.${nextSubnetOctet++}.10`]
  await podman('run', '--detach', '--rm', '--name', id, '--network', namespace, ...ipArgs, '--cap-add', 'NET_ADMIN',
    ...mounts, '--entrypoint', 'sh', opts.image, '-c', shell, '--', '/app/test/private-wan.mjs', role,
    '--out', '/bench/out', '--seconds', '900', ...(role === 'testnet' && !opts['shared-namespace'] ? [] : ['--private-host', opts['shared-namespace'] ? 'loopback' : 'auto']), ...options)
  containers.push(id)
  return id
}
async function main () {
  await mkdir(join(out, 'code'), { recursive: true })
  const activeEngine = await detectEngine()
  evidence.engine = activeEngine
  evidence.topology = opts['shared-namespace']
    ? `Single host, one isolated ${activeEngine} test namespace; lo impairment affects all test peers, no VPN tunnels or independent multi-ISP WAN`
    : `Single host, one isolated ${activeEngine} bridge, separate container network namespaces, addresses in distinct /24 prefix buckets; no VPN tunnels or independent multi-ISP WAN`
  await Promise.all([
    copyFile(join(root, 'src', 'index.js'), join(out, 'code', 'index.js')),
    copyFile(join(root, 'src', 'private-overlay.js'), join(out, 'code', 'private-overlay.js')),
    copyFile(join(root, 'test', 'private-wan.mjs'), join(out, 'code', 'private-wan.mjs')),
    copyFile(resolve(opts.media), join(out, 'code', 'fixture.mp4'))
  ])
  evidence.imageId = await podman('image', 'inspect', opts.image, '--format', '{{.Id}}')
  evidence.code = Object.fromEntries(await Promise.all(['index.js', 'private-overlay.js', 'private-wan.mjs'].map(async name =>
    [name, createHash('sha256').update(await readFile(join(out, 'code', name))).digest('hex')]
  )))
  await podman('network', 'create', '--subnet', '10.204.0.0/16', '--gateway', '10.204.0.1', network)
  await start('testnet', 'testnet')
  const testnet = await until('testnet', state => state.bootstrap?.length > 0, 30_000)
  const bootstrap = testnet.bootstrap.map(peer => `${peer.host}:${peer.port}`).join(',')
  const guardBuckets = new Set()
  evidence.guards = []
  for (let i = 0; i < numbers.relays; i++) {
    const name = `relay-${i}`
    await start('guard', name, ['--bootstrap', bootstrap])
    const gs = await until(name, state => state.phase === 'serving' && state.address?.host)
    const prefix24 = gs.address.host.split('.').slice(0, 3).join('.') + '.0/24'
    if (guardBuckets.has(prefix24)) throw new Error(`Guard ${name} collided on /24 subnet ${prefix24}`)
    guardBuckets.add(prefix24)
    evidence.guards.push({ name, publicKey: gs.publicKey, host: gs.address.host, port: gs.address.port, bucket: prefix24 })
  }
  await start('seeder', 'seeder', ['--bootstrap', bootstrap, '--media', '/app/test/fixture.mp4'])
  const seeded = await until('seeder', state => state.phase === 'serving' && state.published && state.tracker)
  evidence.tracker = seeded.tracker
  evidence.fixture = seeded.published
  const expected = seeded.published
  evidence.discoveryProbes = []
  for (let i = 0; i < 3; i++) {
    const name = `probe-${i}`
    await start('probe', name, ['--tracker', evidence.tracker, '--bootstrap', bootstrap])
    const probe = await until(name, state => state.role === 'probe', 30_000)
    evidence.discoveryProbes.push({ at: probe.at, directoryCount: probe.directoryCount, trackerTopicPeerCount: probe.trackerTopicPeerCount })
    if (probe.directoryCount >= 2 && probe.trackerTopicPeerCount >= 1) break
    await wait(5000)
  }
  const latest = evidence.discoveryProbes.at(-1)
  if (latest.directoryCount < 2 || latest.trackerTopicPeerCount < 1) throw new Error(`Stateless private guards never became discoverable: ${JSON.stringify(latest)}`)
  const readers = await Promise.all(Array.from({ length: numbers.readers }, async (_, index) => {
    const name = `reader-${index}`
    const id = await start('reader', name, ['--tracker', evidence.tracker, '--bootstrap', bootstrap,
      '--sha256', expected.sha256, '--bytes', String(expected.size)], !opts['shared-namespace'] || index === 0)
    return { name, id }
  }))
  for (const { name, id } of readers) {
    await until(name, state => state.role === 'reader', 30_000)
    const dev = opts['shared-namespace'] ? 'lo' : 'eth0'
    const qdisc = await podman('exec', id, 'tc', 'qdisc', 'show', 'dev', dev)
    evidence.impairment.qdiscs[name] = qdisc
    const delayShown = numbers['delay-ms'] === 0 ? !qdisc.includes('delay ') || qdisc.includes('delay 0ms') : qdisc.includes('delay ' + numbers['delay-ms'] + 'ms')
    const lossShown = numbers['loss-percent'] === 0 ? !qdisc.includes('loss ') || qdisc.includes('loss 0%') : qdisc.includes('loss ' + numbers['loss-percent'] + '%')
    if (!qdisc.includes('qdisc netem') || !qdisc.includes('limit 10000') || !delayShown || !lossShown) throw new Error(`${name} did not apply requested netem: ${qdisc}`)
  }
  evidence.impairment.applied = true
  if (opts.churn) {
    await until('reader-0', state => state.phase === 'reading' || state.phase === 'verified')
    const startedAt = new Date().toISOString()
    await podman('stop', '--time', '1', `${prefix}-relay-1`)
    await start('guard', 'relay-replacement', ['--bootstrap', bootstrap])
    await until('relay-replacement', state => state.phase === 'serving')
    evidence.churn.push({ stopped: 'relay-1', started: 'relay-replacement', startedAt, completedAt: new Date().toISOString() })
  }
  evidence.readers = await Promise.all(readers.map(async ({ name }) => {
    const result = await until(name, state => state.phase === 'verified')
    const routes = result.status.routes
    if (result.received.sha256 !== expected.sha256 || result.received.bytes !== expected.size ||
        routes.private.rxBytes < expected.size || routes.public.rxBytes !== 0 || routes.lan.rxBytes !== 0 ||
        result.directTrackerAnnouncement || result.exposure.directDestinationSends !== 0) throw new Error(`${name} failed exact-byte or private-only transport proof`)
    return { name, received: result.received, routes, rttMs: result.status.rtt, retransmits: result.status.retransmits }
  }))
  if (opts.churn && !evidence.churn.some(churn => evidence.readers.some(reader =>
    Date.parse(churn.startedAt) <= Date.parse(reader.received.completedAt) && Date.parse(churn.completedAt) >= Date.parse(reader.received.requestedAt)
  ))) throw new Error('No relay actually stopped during an active private transfer')
  evidence.passed = true
}
try {
  await main()
} catch (err) {
  evidence.error = err.stack || String(err)
  process.exitCode = 1
} finally {
  evidence.observations = Object.fromEntries((await Promise.all(
    ['relay-0', 'seeder', ...Array.from({ length: numbers.readers }, (_, i) => `reader-${i}`)].map(async name => {
      const state = await snapshot(name)
      return [name, state && { phase: state.phase, error: state.error, routingState: state.routingState,
        discovery: state.discovery, peers: state.status?.peers, routes: state.status?.routes,
        rttMs: state.status?.rtt, retransmits: state.status?.retransmits }]
    })
  )).filter(([, state]) => state))
  if (opts['shared-namespace'] && containers.includes(`${prefix}-testnet`)) {
    evidence.impairment.finalQdisc = await podman('exec', `${prefix}-testnet`, 'tc', '-s', 'qdisc', 'show', 'dev', 'lo')
      .catch(err => `unavailable: ${err.message}`)
  }
  for (const id of containers.reverse()) await podman('rm', '--force', ...(engine === 'podman' ? ['--ignore'] : []), id).catch(err => { (evidence.cleanupErrors ||= []).push(err.message) })
  await podman('network', 'rm', network).catch(err => { if (containers.length) (evidence.cleanupErrors ||= []).push(err.message) })
  evidence.endedAt = new Date().toISOString()
  await writeFile(join(out, 'result.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(`Isolated netem evidence: ${join(out, 'result.json')}; passed=${evidence.passed}`)
}
