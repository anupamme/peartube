// Dedicated Web Worker driving peartube-media's compiled Rust/OxideAV WebAssembly engine
// over lock-free 2 MiB synchronous HTTP Range blocks with serialized command dispatch.
let wasm = null
let wasmReady = null
let streamUrl = ''
let streamLen = 0
let streamingMode = false
let mainClock = 0
let queuedVideoSec = 0
let queuedAudioSec = 0
let lastVideoPts = null
let hasVideo = false
let hasAudio = false
let useMse = false
let eof = false
let pumping = false
let closed = true
let configured = false
let activeSeq = 0

const STREAM_BLOCK = 2 * 1024 * 1024
const MAX_BLOCKS = 12
const blockCache = new Map()
let blockStamp = 0
let headProbe = null

const dec = new TextDecoder()
const enc = new TextEncoder()

function putBlock (idx, data) {
  blockStamp++
  if (blockCache.has(idx)) {
    blockCache.get(idx).stamp = blockStamp
    return
  }
  if (blockCache.size >= MAX_BLOCKS) {
    let oldestKey = null
    let oldestStamp = Infinity
    for (const [k, v] of blockCache) {
      if (v.stamp < oldestStamp) { oldestStamp = v.stamp; oldestKey = k }
    }
    if (oldestKey !== null) blockCache.delete(oldestKey)
  }
  blockCache.set(idx, { data, stamp: blockStamp })
}

function probeStream (url) {
  blockCache.clear()
  headProbe = null
  const xhr = new XMLHttpRequest()
  xhr.open('GET', url, false)
  xhr.responseType = 'arraybuffer'
  xhr.setRequestHeader('Range', 'bytes=0-262143')
  xhr.send()
  if (xhr.status !== 200 && xhr.status !== 206) {
    throw new Error('Stream HTTP ' + xhr.status)
  }
  const buf = new Uint8Array(xhr.response || new ArrayBuffer(0))
  const cr = xhr.getResponseHeader('Content-Range') || ''
  const slash = cr.lastIndexOf('/')
  if (slash !== -1) {
    const total = Number(cr.slice(slash + 1).trim())
    streamLen = total > 0 ? total : buf.byteLength
  } else {
    const cl = Number(xhr.getResponseHeader('Content-Length') || 0)
    streamLen = cl > 0 ? cl : buf.byteLength
  }
  headProbe = buf
}

function readAtSync (offset, dstPtr, len) {
  if (offset >= streamLen || len === 0) return 0
  const maxLen = Math.min(len, streamLen - offset)
  if (headProbe && offset + maxLen <= headProbe.byteLength) {
    new Uint8Array(wasm.memory.buffer, dstPtr, maxLen).set(headProbe.subarray(offset, offset + maxLen))
    return maxLen
  }

  const bIdx = Math.floor(offset / STREAM_BLOCK)
  const bOff = offset - bIdx * STREAM_BLOCK
  const cached = blockCache.get(bIdx)
  if (cached && bOff < cached.data.byteLength) {
    cached.stamp = ++blockStamp
    const take = Math.min(maxLen, cached.data.byteLength - bOff)
    new Uint8Array(wasm.memory.buffer, dstPtr, take).set(cached.data.subarray(bOff, bOff + take))
    return take
  }

  const fetchStart = streamingMode ? bIdx * STREAM_BLOCK : offset
  const fetchEnd = streamingMode
    ? Math.min(streamLen - 1, fetchStart + STREAM_BLOCK - 1)
    : Math.min(streamLen - 1, offset + maxLen - 1)

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', streamUrl, false)
      xhr.responseType = 'arraybuffer'
      xhr.setRequestHeader('Range', 'bytes=' + fetchStart + '-' + fetchEnd)
      xhr.send()
      if (xhr.status !== 200 && xhr.status !== 206) continue
      const src = new Uint8Array(xhr.response || new ArrayBuffer(0))
      if (streamingMode && src.byteLength > 0) {
        putBlock(bIdx, src)
        const offInSrc = offset - fetchStart
        if (offInSrc >= src.byteLength) return 0
        const take = Math.min(maxLen, src.byteLength - offInSrc)
        new Uint8Array(wasm.memory.buffer, dstPtr, take).set(src.subarray(offInSrc, offInSrc + take))
        return take
      }
      const copyLen = Math.min(maxLen, src.byteLength)
      if (copyLen > 0) {
        new Uint8Array(wasm.memory.buffer, dstPtr, copyLen).set(src.subarray(0, copyLen))
      }
      return copyLen
    } catch {}
  }
  return -1
}

function ensureWasm (wasmUrl) {
  if (wasm) return Promise.resolve(wasm)
  if (wasmReady) return wasmReady
  const imports = {
    env: {
      host_stream_len: () => BigInt(streamLen),
      host_read_at: (offBig, dstPtr, len) => readAtSync(Number(offBig), dstPtr >>> 0, len >>> 0)
    }
  }
  wasmReady = (async () => {
    let inst
    if (WebAssembly.instantiateStreaming) {
      try {
        inst = (await WebAssembly.instantiateStreaming(fetch(wasmUrl), imports)).instance
      } catch {}
    }
    if (!inst) {
      const bytes = await fetch(wasmUrl).then(r => r.arrayBuffer())
      inst = (await WebAssembly.instantiate(bytes, imports)).instance
    }
    wasm = inst.exports
    return wasm
  })()
  return wasmReady
}

function readJson () {
  const ptr = wasm.pt_json_ptr() >>> 0
  const len = wasm.pt_json_len() >>> 0
  if (!len) return {}
  return JSON.parse(dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len)))
}

function copyOutBuf () {
  const ptr = wasm.pt_out_ptr() >>> 0
  const len = wasm.pt_out_len() >>> 0
  const copy = new Uint8Array(len)
  if (len > 0) copy.set(new Uint8Array(wasm.memory.buffer, ptr, len))
  return copy.buffer
}

function bufferedAhead () {
  const maxVideo = useMse ? 8.0 : 1.5
  const maxAudio = useMse ? 6.0 : 2.0
  const vOk = !hasVideo || queuedVideoSec >= maxVideo
  const aOk = !hasAudio || queuedAudioSec >= maxAudio
  return (hasVideo || hasAudio) ? (vOk && aOk) : false
}

function schedulePump (delay = 0) {
  if (!configured || pumping || closed || eof) return
  pumping = true
  setTimeout(pump, delay)
}

function pump () {
  pumping = false
  if (!configured || closed || eof || !wasm) return
  if (bufferedAhead()) return

  const seq = activeSeq
  const tStart = performance.now()
  const maxSliceMs = 22
  for (let i = 0; i < 64; i++) {
    if (closed || seq !== activeSeq) return
    const code = wasm.pt_step()
    if (code === 0) {
      eof = true
      self.postMessage({ type: 'eof', seq })
      return
    }
    if (code < 0) {
      const err = readJson()
      self.postMessage({ type: 'error', seq, error: err.error || 'WASM decode failed' })
      eof = true
      return
    }
    if (code === 1) {
      const buf = copyOutBuf()
      self.postMessage({ type: 'mseInit', seq, buf }, [buf])
    } else if (code === 2) {
      const buf = copyOutBuf()
      const start = wasm.pt_out_pts()
      const end = wasm.pt_out_dur()
      queuedVideoSec += Math.max(0.04, Math.min(4.0, end - start))
      self.postMessage({ type: 'mseSeg', seq, start, end, buf }, [buf])
    } else if (code === 3 || code === 7) {
      const buf = copyOutBuf()
      const pts = wasm.pt_out_pts()
      const w = wasm.pt_out_w() >>> 0
      const h = wasm.pt_out_h() >>> 0
      const step = lastVideoPts !== null ? Math.max(0.01, Math.min(0.2, pts - lastVideoPts)) : (1 / 30)
      lastVideoPts = pts
      queuedVideoSec += step
      self.postMessage({ type: 'videoFrame', seq, pts, w, h, yuv: code === 7, buf }, [buf])
    } else if (code === 4) {
      const buf = copyOutBuf()
      const pts = wasm.pt_out_pts()
      const rate = wasm.pt_out_rate() >>> 0
      const samples = wasm.pt_out_samples() >>> 0
      if (rate > 0) queuedAudioSec += samples / rate
      self.postMessage({ type: 'audioChunk', seq, pts, rate, samples, buf }, [buf])
    } else if (code === 5) {
      const ptr = wasm.pt_out_ptr() >>> 0
      const len = wasm.pt_out_len() >>> 0
      const text = dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len))
      self.postMessage({ type: 'subText', seq, start: wasm.pt_out_pts(), end: wasm.pt_out_dur(), text })
    } else if (code === 6) {
      const buf = copyOutBuf()
      self.postMessage({
        type: 'subBitmap',
        seq,
        start: wasm.pt_out_pts(),
        end: wasm.pt_out_dur(),
        x: wasm.pt_out_x(),
        y: wasm.pt_out_y(),
        w: wasm.pt_out_w() >>> 0,
        h: wasm.pt_out_h() >>> 0,
        cw: wasm.pt_out_cw() >>> 0,
        ch: wasm.pt_out_ch() >>> 0,
        buf
      }, [buf])
    }
    if (bufferedAhead() || (performance.now() - tStart) >= maxSliceMs) break
  }
  if (!bufferedAhead()) schedulePump(0)
}

async function handleCmd (msg) {
  if (msg.cmd === 'warmup') {
    await ensureWasm(msg.wasmUrl)
    self.postMessage({ type: 'warm' })
  } else if (msg.cmd === 'open') {
    closed = true
    if (wasm) wasm.pt_close()
    closed = false
    configured = false
    eof = false
    streamingMode = false
    activeSeq = msg.seq || 1
    streamUrl = msg.streamUrl
    await ensureWasm(msg.wasmUrl)
    probeStream(streamUrl)
    const extBytes = enc.encode(msg.ext || '')
    let ptr = 0
    if (extBytes.length > 0) {
      ptr = wasm.pt_alloc(extBytes.length) >>> 0
      new Uint8Array(wasm.memory.buffer, ptr, extBytes.length).set(extBytes)
    }
    const rc = wasm.pt_open(ptr, extBytes.length)
    if (ptr) wasm.pt_free(ptr, extBytes.length)
    const payload = readJson()
    if (rc < 0) {
      self.postMessage({ type: 'error', seq: msg.seq, error: payload.error || 'Failed to open media' })
      return
    }
    self.postMessage({ type: 'manifest', seq: msg.seq, manifest: payload, byteLength: streamLen })
  } else if (msg.cmd === 'start') {
    activeSeq = msg.seq || activeSeq
    hasVideo = msg.videoStream >= 0
    hasAudio = msg.audioStream >= 0
    useMse = Boolean(msg.useMse)
    streamingMode = true
    mainClock = 0
    queuedVideoSec = 0
    queuedAudioSec = 0
    lastVideoPts = null
    eof = false
    const rc = wasm.pt_configure(msg.videoStream, msg.audioStream, msg.subStream, useMse ? 1 : 0)
    if (rc < 0) {
      self.postMessage({ type: 'error', seq: activeSeq, error: readJson().error || 'Configure failed' })
      return
    }
    configured = true
    wasm.pt_set_clock?.(0)
    schedulePump(0)
  } else if (msg.cmd === 'seek') {
    activeSeq = msg.seq
    hasVideo = msg.videoStream >= 0
    hasAudio = msg.audioStream >= 0
    useMse = Boolean(msg.useMse)
    streamingMode = true
    mainClock = Math.max(0, Number(msg.time) || 0)
    queuedVideoSec = 0
    queuedAudioSec = 0
    lastVideoPts = null
    eof = false
    wasm.pt_configure(msg.videoStream, msg.audioStream, msg.subStream, useMse ? 1 : 0)
    wasm.pt_seek(mainClock)
    configured = true
    wasm.pt_set_clock?.(mainClock)
    self.postMessage({ type: 'flushed', seq: activeSeq, time: mainClock })
    schedulePump(0)
  } else if (msg.cmd === 'consumed') {
    queuedVideoSec = Math.max(0, queuedVideoSec - (Number(msg.videoSec) || 0))
    queuedAudioSec = Math.max(0, queuedAudioSec - (Number(msg.audioSec) || 0))
    mainClock = Number(msg.time) || mainClock
    if (wasm) wasm.pt_set_clock?.(mainClock)
    if (!eof && !bufferedAhead()) schedulePump(0)
  } else if (msg.cmd === 'close') {
    closed = true
    configured = false
    eof = true
    streamingMode = false
    blockCache.clear()
    if (wasm) wasm.pt_close()
  }
}

let cmdChain = Promise.resolve()
self.onmessage = ev => {
  const msg = ev.data || {}
  cmdChain = cmdChain.then(() => handleCmd(msg)).catch(err => {
    self.postMessage({ type: 'error', seq: activeSeq, error: err?.message || String(err) })
  })
}
