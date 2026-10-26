// Fixed-block HTTP Range streamer over stock unmodified Hypercore sessions:
// turns 512 KiB / 64 KiB byte seeks into pure O(1) division with zero core.seek() network walks,
// sliding core.get() lookahead, and instant session cancellation the millisecond a viewer seeks.
import { createServer } from 'node:http'
import b4a from 'b4a'

const HEX64 = /^[0-9a-f]{64}$/i
const UNIFORM_SIZES = [524288, 65536]
const noop = () => {}

function uniformBlockSize (blob) {
  if (blob.blockLength <= 0 || blob.byteLength <= 0) return 0
  if (blob.blockLength === 1) return blob.byteLength
  for (const bs of UNIFORM_SIZES) {
    if ((blob.blockLength - 1) * bs < blob.byteLength && blob.byteLength <= blob.blockLength * bs) return bs
  }
  return 0
}

function parseRangeHeader (raw, size) {
  if (!raw || typeof raw !== 'string') return null
  if (!raw.startsWith('bytes=')) return 'invalid'
  const spec = raw.slice(6).split(',')[0].trim()
  const dash = spec.indexOf('-')
  if (dash === -1) return 'invalid'
  const left = spec.slice(0, dash).trim()
  const right = spec.slice(dash + 1).trim()
  if (left === '') {
    if (!/^\d+$/.test(right)) return 'invalid'
    const suffix = Number(right)
    if (!(suffix > 0) || size <= 0) return 'invalid'
    return { start: Math.max(0, size - suffix), end: size - 1 }
  }
  if (!/^\d+$/.test(left) || (right !== '' && !/^\d+$/.test(right))) return 'invalid'
  const start = Number(left)
  const end = right === '' ? size - 1 : Math.min(Number(right), size - 1)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) {
    return 'invalid'
  }
  return { start, end }
}

function decodeRequest (req) {
  const qIdx = (req.url || '').indexOf('?')
  if (qIdx === -1) return null
  const params = new URLSearchParams(req.url.slice(qIdx + 1))
  const keyHex = (params.get('key') || '').trim().toLowerCase()
  const blobRaw = (params.get('blob') || '').trim()
  if (!HEX64.test(keyHex) || !blobRaw) return null
  const parts = blobRaw.split(':')
  if (parts.length !== 4 || !parts.every(p => /^\d+$/.test(p))) return null
  const [blockOffset, blockLength, byteOffset, byteLength] = parts.map(Number)
  if (![blockOffset, blockLength, byteOffset, byteLength].every(n => Number.isSafeInteger(n) && n >= 0)) return null
  return {
    keyHex,
    key: b4a.from(keyHex, 'hex'),
    blob: { blockOffset, blockLength, byteOffset, byteLength },
    type: params.get('type') || 'application/octet-stream',
    token: params.get('token') || ''
  }
}

function listenServer (server, port, address) {
  return new Promise((resolve, reject) => {
    const onError = err => { server.off('listening', onListen); reject(err) }
    const onListen = () => { server.off('error', onError); resolve() }
    server.once('error', onError)
    server.once('listening', onListen)
    server.listen(port, address)
  })
}

export class BlobServer {
  constructor (store, opts = {}) {
    const {
      port = 49833,
      host = '127.0.0.1',
      address = host === '127.0.0.1' ? '127.0.0.1' : '0.0.0.0',
      token = null,
      protocol = 'http',
      anyPort = true,
      resolve = key => ({ key }),
      sandbox = true
    } = opts
    this.store = store
    this.host = host
    this.port = port
    this.address = address
    this.token = token ? String(token) : ''
    this.protocol = protocol
    this.anyPort = anyPort
    this.resolve = resolve
    this.sandbox = sandbox
    this.server = null
    this.connections = new Set()
    this.sessions = new Set()
    this.listening = null
    this.closing = null
  }

  listen () {
    if (this.listening) return this.listening
    this.listening = this._listen()
    return this.listening
  }

  async _listen () {
    if (this.server === null) {
      this.server = createServer((req, res) => { this._onrequest(req, res).catch(noop) })
      this.server.on('connection', socket => {
        if (this.closing) { socket.destroy(); return }
        this.connections.add(socket)
        socket.on('close', () => this.connections.delete(socket))
      })
    }
    try {
      await listenServer(this.server, this.port, this.address)
    } catch (err) {
      if (this.anyPort) await listenServer(this.server, 0, this.address)
      else throw err
    }
    this.port = this.server.address().port
  }

  getLink (key, opts = {}) {
    const {
      host = this.host,
      port = this.port,
      protocol = this.protocol,
      blob = null,
      url = true,
      type = 'application/octet-stream'
    } = opts
    if (!blob) throw new Error('Must specify a blob')
    const keyHex = typeof key === 'string' ? key.toLowerCase() : b4a.toString(key, 'hex')
    const p = (protocol === 'http' && port === 80) || (protocol === 'https' && port === 443) ? '' : ':' + port
    const b = `${blob.blockOffset}:${blob.blockLength}:${blob.byteOffset}:${blob.byteLength}`
    const tok = this.token ? `&token=${encodeURIComponent(this.token)}` : ''
    const path = `/?key=${keyHex}&blob=${b}&type=${encodeURIComponent(type)}${tok}`
    return url ? `${protocol}://${host}${p}${path}` : path
  }

  async _onrequest (req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges')
    res.setHeader('Cache-Control', 'no-store')

    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      res.end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.end()
      return
    }

    const info = decodeRequest(req)
    if (!info || (this.token && info.token !== this.token)) {
      res.statusCode = info ? 403 : 400
      res.end()
      return
    }

    let resolved = null
    try { resolved = await this.resolve(info.key, info) } catch {}
    if (!resolved || !resolved.key || this.closing) {
      res.statusCode = 404
      res.end()
      return
    }

    const { blob } = info
    const total = blob.byteLength
    if (this.sandbox) res.setHeader('Content-Security-Policy', 'sandbox')
    res.setHeader('Accept-Ranges', 'bytes')
    res.setHeader('Content-Type', info.type)

    if (total === 0) {
      if (req.headers.range) {
        res.statusCode = 416
        res.setHeader('Content-Range', 'bytes */0')
      } else {
        res.statusCode = 200
        res.setHeader('Content-Length', '0')
      }
      res.end()
      return
    }

    const parsedRange = parseRangeHeader(req.headers.range, total)
    if (parsedRange === 'invalid') {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${total}`)
      res.end()
      return
    }

    const start = parsedRange ? parsedRange.start : 0
    const end = parsedRange ? parsedRange.end : total - 1
    const contentLength = end - start + 1

    if (parsedRange) {
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
    } else {
      res.statusCode = 200
    }
    res.setHeader('Content-Length', String(contentLength))

    if (req.method === 'HEAD') {
      res.end()
      return
    }

    const core = this.store.get({ key: resolved.key })
    this.sessions.add(core)
    let aborted = false
    let wakeDrain = null
    let prefetch = null
    let prefetchEnd = 0
    const cleanup = () => {
      if (aborted) return
      aborted = true
      if (prefetch) { prefetch.destroy(); prefetch = null }
      this.sessions.delete(core)
      core.close().catch(noop)
      if (wakeDrain) { const fn = wakeDrain; wakeDrain = null; fn() }
    }
    res.once('close', cleanup)
    res.once('error', cleanup)

    try {
      await core.ready()
      if (aborted) return

      const bs = uniformBlockSize(blob)
      const avgBs = bs > 0 ? bs : Math.max(4096, Math.round(blob.byteLength / Math.max(1, blob.blockLength)))
      // Fit inside Linux's doubled 512 KiB sk_rcvbuf (2 * 256 KiB rmem_max) while keeping enough blocks in flight for 4K UHD.
      const minFlight = avgBs <= 131072 ? 6 : 4
      const maxFlight = avgBs <= 131072 ? 8 : 8
      if (core.core && core.core._ptMaxFlight !== maxFlight) {
        core.core._ptMaxFlight = maxFlight
        core.core._ptMinFlight = minFlight
        core.core.replicator?.setInflightRange(minFlight, maxFlight)
      }
      let blockIdx
      let relOffset
      let endBlockExcl
      if (start === 0) {
        blockIdx = blob.blockOffset
        relOffset = 0
        endBlockExcl = bs > 0
          ? blob.blockOffset + Math.min(blob.blockLength, Math.floor(end / bs) + 1)
          : blob.blockOffset + blob.blockLength
      } else if (bs > 0) {
        blockIdx = blob.blockOffset + Math.floor(start / bs)
        relOffset = start % bs
        endBlockExcl = blob.blockOffset + Math.min(blob.blockLength, Math.floor(end / bs) + 1)
      } else {
        // Pre-seed the 26-level Merkle subtree & bitfield page in 1 RTT so stock core.seek() never scans 59M sparse blocks.
        const estIdx = blob.blockOffset + Math.min(blob.blockLength - 1, Math.floor((start / blob.byteLength) * blob.blockLength))
        await core.get(estIdx).catch(noop)
        if (aborted) return
        const sought = await core.seek(blob.byteOffset + start)
        if (aborted || !sought) { if (!aborted) res.destroy(); return }
        blockIdx = sought[0]
        relOffset = sought[1]
        endBlockExcl = blob.blockOffset + blob.blockLength
      }

      const queue = new Map()
      let nextFetch = blockIdx
      let sent = 0
      let remaining = contentLength

      // Explicit sequential `blocks` skips Hypercore's `_addLastRangeBatch` 16 MiB tail-first hijack
      // while keeping `win = 2` so `core.get()` never bypasses `setInflightRange` via `_queued`.
      const windowBlocks = Math.min(256, Math.max(16, Math.ceil((12 * 1048576) / avgBs)))
      const stepBlocks = Math.max(8, windowBlocks >> 1)
      const advancePrefetch = () => {
        if (aborted || blockIdx >= endBlockExcl) return
        if (prefetch && prefetchEnd >= Math.min(endBlockExcl, blockIdx + stepBlocks)) return
        const prev = prefetch
        prefetchEnd = Math.min(endBlockExcl, blockIdx + windowBlocks)
        const count = prefetchEnd - blockIdx
        const blocks = new Array(count)
        for (let i = 0; i < count; i++) blocks[i] = blockIdx + i
        prefetch = core.download({ blocks })
        if (prev) prev.destroy()
      }
      const fillLookahead = () => {
        advancePrefetch()
        const win = 2
        while (!aborted && queue.size < win && nextFetch < endBlockExcl) {
          const idx = nextFetch++
          const p = core.get(idx)
          p.catch(noop)
          queue.set(idx, p)
        }
      }

      while (!aborted && remaining > 0 && blockIdx < endBlockExcl) {
        fillLookahead()
        let p = queue.get(blockIdx)
        if (!p) {
          p = core.get(blockIdx)
          p.catch(noop)
        } else {
          queue.delete(blockIdx)
        }
        const block = await p
        if (aborted) return
        if (!block || block.byteLength <= relOffset) {
          res.destroy()
          return
        }
        if (core.core) core.core._ptLastReadBlock = blockIdx
        const avail = block.byteLength - relOffset
        const take = Math.min(avail, remaining)
        const slice = relOffset === 0 && take === block.byteLength
          ? block
          : block.subarray(relOffset, relOffset + take)
        relOffset = 0
        blockIdx++
        remaining -= take
        sent += take
        fillLookahead()

        if (!res.write(slice) && !aborted && remaining > 0) {
          await new Promise(resolve => {
            wakeDrain = resolve
            res.once('drain', () => {
              if (wakeDrain === resolve) wakeDrain = null
              resolve()
            })
          })
        }
      }
      if (!aborted) res.end()
    } catch {
      if (!aborted) res.destroy()
    } finally {
      cleanup()
    }
  }

  close () {
    if (this.closing) return this.closing
    this.closing = this._close()
    return this.closing
  }

  async _close () {
    if (this.listening) await this.listening.catch(noop)
    for (const core of this.sessions) core.close().catch(noop)
    this.sessions.clear()
    await new Promise(resolve => {
      let waiting = 1
      const done = () => { if (--waiting === 0) resolve() }
      if (this.server !== null) {
        waiting++
        this.server.close(done)
        this.server.unref?.()
        this.server = null
      }
      for (const c of this.connections) {
        waiting++
        c.once('close', done)
        c.destroy()
      }
      done()
    })
    await this.store.close().catch(noop)
  }
}
