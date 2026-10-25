// Dedicated Web Worker driving peartube-media's compiled Rust/OxideAV WebAssembly engine over HTTP Range blocks.
let wasm = null
let streamUrl = ''
let streamLen = 0
let firstChunk = null
let mainClock = 0
let furthestVideo = 0
let furthestAudio = 0
let hasVideo = false
let hasAudio = false
let useMse = false
let eof = false
let pumping = false
let closed = true
let activeSeq = 0
const dec = new TextDecoder()
const enc = new TextEncoder()

function probeStream (url) {
  const xhr = new XMLHttpRequest()
  xhr.open('GET', url, false)
  xhr.responseType = 'arraybuffer'
  xhr.setRequestHeader('Range', 'bytes=0-65535')
  xhr.send()
  if (xhr.status !== 200 && xhr.status !== 206) {
    throw new Error('Stream HTTP ' + xhr.status)
  }
  const buf = new Uint8Array(xhr.response || new ArrayBuffer(0))
  const cr = xhr.getResponseHeader('Content-Range') || ''
  const m = cr.match(/\/(\d+)\s*$/)
  if (m) {
    streamLen = Number(m[1])
  } else {
    const cl = Number(xhr.getResponseHeader('Content-Length') || 0)
    streamLen = cl > 0 ? cl : buf.byteLength
  }
  firstChunk = buf
}

function readAtSync (offset, dstPtr, len) {
  if (offset >= streamLen || len === 0) return 0
  if (offset === 0 && firstChunk && len <= firstChunk.byteLength) {
    new Uint8Array(wasm.memory.buffer, dstPtr, len).set(firstChunk.subarray(0, len))
    return len
  }
  const end = Math.min(streamLen - 1, offset + len - 1)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', streamUrl, false)
      xhr.responseType = 'arraybuffer'
      xhr.setRequestHeader('Range', 'bytes=' + offset + '-' + end)
      xhr.send()
      if (xhr.status !== 200 && xhr.status !== 206) continue
      const src = new Uint8Array(xhr.response || new ArrayBuffer(0))
      const copyLen = Math.min(len, src.byteLength)
      if (copyLen > 0) {
        new Uint8Array(wasm.memory.buffer, dstPtr, copyLen).set(src.subarray(0, copyLen))
      }
      return copyLen
    } catch {}
  }
  return -1
}

async function ensureWasm (wasmUrl) {
  if (wasm) return wasm
  const imports = {
    env: {
      host_stream_len: () => BigInt(streamLen),
      host_read_at: (offBig, dstPtr, len) => readAtSync(Number(offBig), dstPtr >>> 0, len >>> 0)
    }
  }
  let inst
  if (WebAssembly.instantiateStreaming) {
    try {
      const res = await fetch(wasmUrl)
      inst = (await WebAssembly.instantiateStreaming(res, imports)).instance
    } catch {}
  }
  if (!inst) {
    const bytes = await fetch(wasmUrl).then(r => r.arrayBuffer())
    inst = (await WebAssembly.instantiate(bytes, imports)).instance
  }
  wasm = inst.exports
  return wasm
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
  const maxAhead = useMse ? 12.0 : 2.2
  const vOk = !hasVideo || (furthestVideo - mainClock) >= maxAhead
  const aOk = !hasAudio || (furthestAudio - mainClock) >= (useMse ? 8.0 : 3.0)
  return hasVideo || hasAudio ? (vOk && aOk) : false
}

function schedulePump (delay = 0) {
  if (pumping || closed || eof) return
  pumping = true
  setTimeout(pump, delay)
}

function pump () {
  pumping = false
  if (closed || eof || !wasm) return
  if (bufferedAhead()) return

  const seq = activeSeq
  const budget = useMse ? 24 : 8
  for (let i = 0; i < budget; i++) {
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
      furthestVideo = Math.max(furthestVideo, end)
      self.postMessage({ type: 'mseSeg', seq, start, end, buf }, [buf])
    } else if (code === 3) {
      const buf = copyOutBuf()
      const pts = wasm.pt_out_pts()
      const w = wasm.pt_out_w() >>> 0
      const h = wasm.pt_out_h() >>> 0
      furthestVideo = Math.max(furthestVideo, pts)
      self.postMessage({ type: 'videoFrame', seq, pts, w, h, buf }, [buf])
    } else if (code === 4) {
      const buf = copyOutBuf()
      const pts = wasm.pt_out_pts()
      const rate = wasm.pt_out_rate() >>> 0
      const samples = wasm.pt_out_samples() >>> 0
      furthestAudio = Math.max(furthestAudio, pts + (rate ? samples / rate : 0))
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
    if (bufferedAhead()) return
  }
  schedulePump(0)
}

self.onmessage = async ev => {
  const msg = ev.data || {}
  try {
    if (msg.cmd === 'open') {
      closed = false
      eof = false
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
        self.postMessage({ type: 'error', seq: activeSeq, error: payload.error || 'Failed to open media' })
        return
      }
      self.postMessage({ type: 'manifest', manifest: payload, byteLength: streamLen })
    } else if (msg.cmd === 'start') {
      activeSeq = msg.seq || 1
      hasVideo = msg.videoStream >= 0
      hasAudio = msg.audioStream >= 0
      useMse = Boolean(msg.useMse)
      mainClock = 0
      furthestVideo = 0
      furthestAudio = 0
      eof = false
      const rc = wasm.pt_configure(msg.videoStream, msg.audioStream, msg.subStream, useMse ? 1 : 0)
      if (rc < 0) {
        self.postMessage({ type: 'error', seq: activeSeq, error: readJson().error || 'Configure failed' })
        return
      }
      schedulePump(0)
    } else if (msg.cmd === 'seek') {
      activeSeq = msg.seq
      hasVideo = msg.videoStream >= 0
      hasAudio = msg.audioStream >= 0
      useMse = Boolean(msg.useMse)
      mainClock = Math.max(0, Number(msg.time) || 0)
      furthestVideo = mainClock
      furthestAudio = mainClock
      eof = false
      wasm.pt_configure(msg.videoStream, msg.audioStream, msg.subStream, useMse ? 1 : 0)
      wasm.pt_seek(mainClock)
      self.postMessage({ type: 'flushed', seq: activeSeq, time: mainClock })
      schedulePump(0)
    } else if (msg.cmd === 'clock') {
      mainClock = Number(msg.time) || 0
      if (!eof && !bufferedAhead()) schedulePump(0)
    } else if (msg.cmd === 'close') {
      closed = true
      eof = true
      if (wasm) wasm.pt_close()
    }
  } catch (err) {
    self.postMessage({ type: 'error', seq: activeSeq, error: err?.message || String(err) })
  }
}
