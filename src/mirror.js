// Formal Mirror Plugin Host for PearTube relays:
//   - Integrates the durable HTTP/debrid acquirer (`jobs.json`) as the core `http-acquire` plugin
//   - Automatically backfills all previously saved tracker blobs into this relay's single-writer Channel (`channel-backfill`)
//   - Mirrors local media folders (`watch-dir`, e.g. `/data/import` on Unraid) without re-ingesting unchanged files
//   - Mirrors remote JSON manifests or peer relay `/v1/entries` catalogs (`feed-mirror`)
//   - Dynamically loads custom user plugins dropped into `/data/plugins/*.mjs` or `*.js`
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { basename, extname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import b4a from 'b4a'

const VALID_ID = /^[a-z0-9]+:[a-z0-9]+(:s\d{2}e\d{2,3})?$/
const MEDIA_EXT = new Set(['.mp4', '.mkv', '.webm', '.avi', '.mov', '.m4v', '.ts', '.m2ts', '.mpg', '.mpeg', '.ogv', '.ogg', '.flac', '.mp3', '.opus', '.wav', '.aac'])

function fetchJson (url, headers = {}, redirects = 0) {
  return new Promise((resolveJson, reject) => {
    const parsed = new URL(url)
    const fn = parsed.protocol === 'https:' ? httpsRequest : httpRequest
    const req = fn(parsed, { headers: { accept: 'application/json', ...headers } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume?.()
        resolveJson(fetchJson(new URL(res.headers.location, parsed).href, headers, redirects + 1))
        return
      }
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume?.()
        reject(new Error(`Feed ${url} answered ${res.statusCode}`))
        return
      }
      const chunks = []
      let total = 0
      res.on('data', chunk => {
        const buf = typeof chunk === 'string' ? b4a.from(chunk) : chunk
        total += buf.length
        if (total > 8 * 1024 * 1024) { req.destroy(new Error('Feed payload exceeded 8 MiB')); return }
        chunks.push(buf)
      })
      res.on('end', () => {
        try { resolveJson(JSON.parse(b4a.toString(b4a.concat(chunks)))) } catch (err) { reject(err) }
      })
    })
    req.on('error', reject)
    req.end()
  })
}

// Infers a canonical PearTube ID (`imdb:tt...:s01e02`, `imdb:tt...`, or `clip:<slug>`) from a filename or sidecar.
export function inferMediaMeta (filePath, sidecar = null) {
  const stem = basename(filePath, extname(filePath))
  if (sidecar && typeof sidecar.id === 'string' && VALID_ID.test(sidecar.id.toLowerCase())) {
    return { id: sidecar.id.toLowerCase(), title: String(sidecar.title || stem).slice(0, 300) }
  }
  const imdb = stem.match(/\b(tt\d{6,10})\b/i)
  const ep = stem.match(/\bs(\d{2})e(\d{2,3})\b/i)
  if (imdb && ep) {
    const cleanTitle = stem.replace(/\btt\d{6,10}\b/ig, '').replace(/\bs\d{2}e\d{2,3}\b/ig, '').replace(/[._-]+/g, ' ').trim()
    return { id: `imdb:${imdb[1].toLowerCase()}:s${ep[1]}e${ep[2]}`, title: cleanTitle || stem }
  }
  if (imdb) {
    const cleanTitle = stem.replace(/\btt\d{6,10}\b/ig, '').replace(/[._-]+/g, ' ').trim()
    return { id: `imdb:${imdb[1].toLowerCase()}`, title: cleanTitle || stem }
  }
  const slug = stem.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const suffix = slug.length >= 4 ? slug.slice(0, 24) : createHash('sha256').update(stem).digest('hex').slice(0, 12)
  return { id: `clip:${suffix}`, title: stem.replace(/[._]+/g, ' ').trim() || stem }
}

export async function createMirrorHost ({
  node,
  storage,
  acquirer,
  mirrorChannel = true,
  watchDir = null,
  feeds = [],
  pluginsDir = join(storage, 'plugins'),
  pollIntervalMs = 60_000,
  onchange = null
}) {
  const plugins = new Map()
  const stats = new Map()
  const watchStateFile = join(storage, 'mirror-watch.json')
  let watchLedger = {}
  try { watchLedger = JSON.parse(readFileSync(watchStateFile, 'utf8')) } catch {}
  let closed = false

  function saveWatchLedger () {
    writeFileSync(watchStateFile + '.tmp', JSON.stringify(watchLedger, null, 2), { mode: 0o600 })
    renameSync(watchStateFile + '.tmp', watchStateFile)
  }

  function ctxFor (pluginName) {
    return {
      node,
      storage,
      acquirer,
      async has ({ id = null, sha256 = null } = {}) {
        if (acquirer) {
          const active = acquirer.list().some(j =>
            (j.status === 'queued' || j.status === 'running' || j.status === 'announcing' || j.status === 'done') &&
            ((id && j.id === id) || (sha256 && j.sha256 === sha256))
          )
          if (active) return true
        }
        const entries = await node.search(id || null)
        return entries.some(e => (id ? e.id === id : true) && (sha256 ? e.sha256 === sha256 : true) && (e.local || !sha256))
      },
      enqueue ({ id, title, source, channel = mirrorChannel }) {
        if (!acquirer) throw new Error('HTTP acquirer unavailable on this peer')
        const job = acquirer.add({ id, title, source, channel, plugin: pluginName })
        onchange?.()
        return job
      },
      async ingestStream ({ id, title, stream, channel = mirrorChannel }) {
        const op = await node.put({ id, title }, stream)
        await node.append(op)
        if (channel) await node.publishChannel(op)
        onchange?.()
        return op
      },
      async repost (entry, { pin = false, channel = mirrorChannel, tracker = true } = {}) {
        const op = { type: 'announce', id: entry.id, title: entry.title, size: entry.size, sha256: entry.sha256, blobs: entry.blobs, blob: entry.blob }
        if (tracker) await node.append(op)
        if (channel) await node.publishChannel(op)
        if (pin) await node.warm(op)
        onchange?.()
        return op
      },
      async publishDirectory ({ sourceKey, kind = 'channel', title, target = 'both' }) {
        const res = await node.publishSource({ sourceKey, kind, title }, { target })
        onchange?.()
        return res
      }
    }
  }

  function register (plugin) {
    if (!plugin || typeof plugin.name !== 'string' || !plugin.name.trim()) {
      throw new Error('Mirror plugin requires a non-empty name')
    }
    const name = plugin.name.trim()
    plugins.set(name, plugin)
    if (!stats.has(name)) stats.set(name, { runs: 0, lastRunAt: null, lastResult: null, lastError: null })
    return plugin
  }

  async function run (name, payload = {}) {
    const plugin = plugins.get(name)
    if (!plugin) throw Object.assign(new Error(`Unknown mirror plugin: ${name}`), { status: 404 })
    if (typeof plugin.run !== 'function') throw new Error(`Plugin ${name} has no run handler`)
    const st = stats.get(name)
    st.runs++
    st.lastRunAt = Date.now()
    st.lastError = null
    try {
      const result = await plugin.run(payload, ctxFor(name))
      st.lastResult = result
      onchange?.()
      return result
    } catch (err) {
      st.lastError = err.message
      throw err
    }
  }

  // 1. Built-in plugin: durable HTTP/HTTPS debrid acquirer (`jobs.json`).
  register({
    name: 'http-acquire',
    description: 'Durable HTTP/HTTPS stream acquirer backed by jobs.json',
    async run (payload, ctx) {
      const { id, title, source, channel = mirrorChannel, dedupe = false } = payload || {}
      if (dedupe && id && await ctx.has({ id })) return { skipped: true, id, reason: 'already_present' }
      return { queued: true, job: ctx.enqueue({ id, title, source, channel }) }
    },
    info () {
      const list = acquirer ? acquirer.list() : []
      return {
        totalJobs: list.length,
        activeJobs: list.filter(j => j.status === 'queued' || j.status === 'running' || j.status === 'announcing').length,
        doneJobs: list.filter(j => j.status === 'done').length
      }
    }
  })

  // 2. Built-in plugin: zero-copy backfill of existing saved tracker blobs into the single-writer Hyperbee channel.
  register({
    name: 'channel-backfill',
    description: 'Backfills previously saved local tracker blobs into this relay\'s single-writer channel with zero byte duplication',
    async run () {
      return node.syncLocalChannel()
    }
  })

  // 3. Built-in plugin: local directory Drop/Watch folder mirror (e.g. /data/import on Unraid).
  let scanningWatchDir = false
  async function scanFolder (dir, ctx) {
    if (!dir || !existsSync(dir)) return { scanned: 0, ingested: 0, items: [] }
    if (scanningWatchDir) return { scanned: 0, ingested: 0, busy: true, items: [] }
    scanningWatchDir = true
    try {
      const root = resolve(dir)
      const names = readdirSync(root).sort()
      let scanned = 0
      const ingested = []
      for (const name of names) {
        if (closed) break
        const ext = extname(name).toLowerCase()
        if (!MEDIA_EXT.has(ext)) continue
        const full = join(root, name)
        let st
        try { st = statSync(full) } catch { continue }
        if (!st.isFile() || st.size <= 0) continue
        scanned++
        const prev = watchLedger[name]
        if (prev && prev.size === st.size && prev.mtimeMs === Math.trunc(st.mtimeMs)) continue
        let sidecar = null
        const sidecarPath = `${full}.json`
        if (existsSync(sidecarPath)) {
          try { sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8')) } catch {}
        }
        const meta = inferMediaMeta(full, sidecar)
        const op = await ctx.ingestStream({ id: meta.id, title: meta.title, stream: createReadStream(full), channel: mirrorChannel })
        watchLedger[name] = { size: st.size, mtimeMs: Math.trunc(st.mtimeMs), id: op.id, sha256: op.sha256, ingestedAt: Date.now() }
        saveWatchLedger()
        ingested.push({ file: name, id: op.id, title: op.title, size: op.size, sha256: op.sha256 })
      }
      return { scanned, ingested: ingested.length, items: ingested }
    } finally {
      scanningWatchDir = false
    }
  }

  register({
    name: 'watch-dir',
    description: 'Ingests media files dropped into a local folder (PEARTUBE_WATCH_DIR) once, tracking fingerprints in mirror-watch.json',
    async run (payload, ctx) {
      return scanFolder(payload?.dir || watchDir, ctx)
    },
    async poll (ctx) {
      if (watchDir) return scanFolder(watchDir, ctx)
      return null
    },
    info: () => ({ watchDir: watchDir || null, trackedFiles: Object.keys(watchLedger).length })
  })

  // 4. Built-in plugin: JSON manifest & remote PearTube relay `/v1/entries` mirror.
  const configuredFeeds = [...feeds]
  async function mirrorFeedItems (items, headers, ctx) {
    let enqueued = 0
    let skipped = 0
    const jobs = []
    for (const item of items) {
      if (!item || typeof item !== 'object') continue
      const id = String(item.id || '').toLowerCase()
      if (!VALID_ID.test(id)) continue
      const sha256 = typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(item.sha256) ? item.sha256.toLowerCase() : null
      if (await ctx.has({ id, sha256 })) { skipped++; continue }
      const url = item.source?.url || item.url || item.streamUrl
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) { skipped++; continue }
      const job = ctx.enqueue({
        id,
        title: item.title || id,
        source: { url, headers: { ...headers, ...(item.source?.headers || item.headers || {}) } },
        channel: mirrorChannel
      })
      enqueued++
      jobs.push(job)
    }
    return { enqueued, skipped, jobs }
  }

  register({
    name: 'feed-mirror',
    description: 'Mirrors remote JSON manifests or peer PearTube relay /v1/entries catalogs with idempotent deduplication',
    async run (payload, ctx) {
      if (Array.isArray(payload?.items)) return mirrorFeedItems(payload.items, payload.headers || {}, ctx)
      const targetUrls = payload?.url ? [payload.url] : configuredFeeds
      let enqueued = 0
      let skipped = 0
      for (const u of targetUrls) {
        const data = await fetchJson(u, payload?.headers || {})
        const list = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : (Array.isArray(data?.results) ? data.results : []))
        const res = await mirrorFeedItems(list, payload?.headers || {}, ctx)
        enqueued += res.enqueued
        skipped += res.skipped
      }
      return { feeds: targetUrls.length, enqueued, skipped }
    },
    async poll (ctx) {
      if (!configuredFeeds.length) return null
      return this.run({}, ctx)
    },
    info: () => ({ feeds: configuredFeeds })
  })

  // Load any external user plugins placed in `/data/plugins/*.mjs` or `*.js`.
  if (pluginsDir && existsSync(pluginsDir)) {
    for (const file of readdirSync(pluginsDir).sort()) {
      if (!file.endsWith('.mjs') && !file.endsWith('.js')) continue
      try {
        const mod = await import(`file://${resolve(pluginsDir, file)}`)
        const plug = typeof mod.default === 'function' ? await mod.default({ storage, node }) : (mod.default || mod)
        if (plug?.name) register(plug)
      } catch (err) {
        console.error(JSON.stringify({ msg: 'plugin load error', file, error: err?.message || String(err) }))
      }
    }
  }

  // Backfill any previously saved tracker entries into this relay's single-writer channel right on boot!
  if (mirrorChannel) {
    await run('channel-backfill').catch(() => {})
  }
  if (watchDir) {
    mkdirSync(watchDir, { recursive: true })
    await run('watch-dir').catch(() => {})
  }
  if (configuredFeeds.length) {
    run('feed-mirror').catch(() => {})
  }

  const timer = pollIntervalMs > 0
    ? setInterval(async () => {
        if (closed) return
        for (const [name, p] of plugins) {
          if (typeof p.poll !== 'function') continue
          try {
            const res = await p.poll(ctxFor(name))
            if (res) {
              const st = stats.get(name)
              st.lastRunAt = Date.now()
              st.lastResult = res
            }
          } catch (err) {
            const st = stats.get(name)
            st.lastError = err.message
          }
        }
      }, pollIntervalMs)
    : null
  timer?.unref?.()

  function list () {
    return [...plugins.entries()].map(([name, p]) => ({
      name,
      description: p.description || '',
      ...(typeof p.info === 'function' ? p.info() : {}),
      ...stats.get(name)
    }))
  }

  async function close () {
    closed = true
    clearInterval(timer)
    for (const p of plugins.values()) await p.stop?.()
  }

  return { register, run, list, close }
}
