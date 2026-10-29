// Dedicated Web Worker driving peartube-media's SIMD128 Rust/OxideAV WebAssembly engine:
//   - Async fetch() 6 MiB read-ahead prefetcher over a 32 MiB RAM ring so WASM never stalls on sync XHR
//   - Zero-allocation OffscreenCanvas WebGL2/WebGL1 YUV420 + RGBA + WebCodecs GPU renderer inside the Worker
//   - Recycled Transferable ArrayBuffer pools for zero steady-state GC churn
let wasm = null
let wasmReady = null
let streamUrl = ''
let streamLen = 0
let streamingMode = false
let queuedVideoSec = 0
let queuedAudioSec = 0
let lastVideoPts = null
let hasVideo = false
let hasAudio = false
let useMse = false
let useWebCodecs = false
let wcConfig = null
let wcDecoder = null
let eof = false
let pumping = false
let closed = true
let configured = false
let activeSeq = 0

// Speaker-locked monotonic clock interpolated smoothly at Worker VSync rate
let clockMedia = 0
let clockWallMs = 0
let clockPlaying = false

// OffscreenCanvas WebGL renderer + zero-GC recycled buffer pools
let offRenderer = null
let renderQueue = []
let renderLoopActive = false
let drawnInSession = 0
const freeVideoPool = []
const freeAudioPool = []

const STREAM_BLOCK = 2 * 1024 * 1024
const MAX_BLOCKS = 16
const PREFETCH_AHEAD = 3
const MAX_PREFETCH_INFLIGHT = 2
const blockCache = new Map()
const inflightPrefetch = new Map()
let blockStamp = 0
let headProbe = null
let prefetchEpoch = 0

const dec = new TextDecoder()
const enc = new TextEncoder()
const nowWall = () => (self.performance.timeOrigin || 0) + self.performance.now()

function workerMediaTime () {
  if (!clockPlaying) return clockMedia
  return clockMedia + Math.max(0, (nowWall() - clockWallMs) / 1000)
}

function abortPrefetches () {
  prefetchEpoch++
  for (const ctl of inflightPrefetch.values()) {
    try { ctl.abort() } catch {}
  }
  inflightPrefetch.clear()
}

function putBlock (idx, data) {
  blockStamp++
  const existing = blockCache.get(idx)
  if (existing) {
    existing.stamp = blockStamp
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

// Asynchronous sliding read-ahead: fills bIdx+1..bIdx+3 on browser I/O threads while WASM decodes CPU frames.
function prefetchFrom (startBlockIdx) {
  if (!streamingMode || closed || !streamUrl || streamLen <= 0) return
  const totalBlocks = Math.ceil(streamLen / STREAM_BLOCK)
  const epoch = prefetchEpoch
  const url = streamUrl
  for (let idx = startBlockIdx; idx < Math.min(totalBlocks, startBlockIdx + PREFETCH_AHEAD); idx++) {
    if (inflightPrefetch.size >= MAX_PREFETCH_INFLIGHT) break
    if (blockCache.has(idx) || inflightPrefetch.has(idx)) continue
    const startByte = idx * STREAM_BLOCK
    const endByte = Math.min(streamLen - 1, startByte + STREAM_BLOCK - 1)
    if (startByte > endByte) continue
    const ctl = new AbortController()
    inflightPrefetch.set(idx, ctl)
    // Only this request's own settlement may clear its slot: after a seek, an aborted request settles late and would
    // otherwise untrack the new request for the same block, which then can't be aborted and holds a connection.
    const settle = () => { if (inflightPrefetch.get(idx) === ctl) inflightPrefetch.delete(idx) }
    fetch(url, { headers: { Range: 'bytes=' + startByte + '-' + endByte }, signal: ctl.signal })
      .then(res => (res.status === 200 || res.status === 206) ? res.arrayBuffer() : null)
      .then(ab => {
        settle()
        if (!ab || closed || epoch !== prefetchEpoch || url !== streamUrl) return
        const u8 = new Uint8Array(ab)
        if (u8.byteLength > 0) putBlock(idx, u8)
        prefetchFrom(idx + 1)
      })
      .catch(settle)
  }
}

function probeStream (url) {
  abortPrefetches()
  blockCache.clear()
  headProbe = null
  const xhr = new XMLHttpRequest()
  xhr.open('GET', url, false)
  xhr.responseType = 'arraybuffer'
  xhr.setRequestHeader('Range', 'bytes=0-' + (STREAM_BLOCK - 1))
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
  if (buf.byteLength > 0) putBlock(0, buf)
}

function readAtSync (offset, dstPtr, len) {
  if (offset >= streamLen || len === 0) return 0
  const maxLen = Math.min(len, streamLen - offset)
  if (headProbe && offset + maxLen <= headProbe.byteLength) {
    new Uint8Array(wasm.memory.buffer, dstPtr, maxLen).set(headProbe.subarray(offset, offset + maxLen))
    if (streamingMode) prefetchFrom(1)
    return maxLen
  }

  const bIdx = Math.floor(offset / STREAM_BLOCK)
  const bOff = offset - bIdx * STREAM_BLOCK
  const cached = blockCache.get(bIdx)
  if (cached && bOff < cached.data.byteLength) {
    cached.stamp = ++blockStamp
    const take = Math.min(maxLen, cached.data.byteLength - bOff)
    new Uint8Array(wasm.memory.buffer, dstPtr, take).set(cached.data.subarray(bOff, bOff + take))
    if (streamingMode) prefetchFrom(bIdx + 1)
    return take
  }

  // Cancel synchronous race if an async prefetch was already pulling this exact block, then warm ahead.
  const inflight = inflightPrefetch.get(bIdx)
  if (inflight) {
    try { inflight.abort() } catch {}
    inflightPrefetch.delete(bIdx)
  }

  const fetchStart = bIdx * STREAM_BLOCK
  const fetchEnd = Math.min(streamLen - 1, fetchStart + STREAM_BLOCK - 1)

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const xhr = new XMLHttpRequest()
      xhr.open('GET', streamUrl, false)
      // Workers allow timeouts on synchronous requests; one that never gets a connection is retried, not waited on forever.
      xhr.timeout = 20000
      xhr.responseType = 'arraybuffer'
      xhr.setRequestHeader('Range', 'bytes=' + fetchStart + '-' + fetchEnd)
      xhr.send()
      if (xhr.status !== 200 && xhr.status !== 206) continue
      const src = new Uint8Array(xhr.response || new ArrayBuffer(0))
      if (src.byteLength > 0) {
        putBlock(bIdx, src)
        if (streamingMode) prefetchFrom(bIdx + 1)
        const offInSrc = offset - fetchStart
        if (offInSrc >= src.byteLength) return 0
        const take = Math.min(maxLen, src.byteLength - offInSrc)
        new Uint8Array(wasm.memory.buffer, dstPtr, take).set(src.subarray(offInSrc, offInSrc + take))
        return take
      }
      return 0
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

function copyPooledBuf (pool) {
  const ptr = wasm.pt_out_ptr() >>> 0
  const len = wasm.pt_out_len() >>> 0
  let ab = null
  for (let i = 0; i < pool.length; i++) {
    if (pool[i].byteLength >= len) {
      ab = pool.splice(i, 1)[0]
      break
    }
  }
  if (!ab) ab = new ArrayBuffer(len)
  if (len > 0) {
    new Uint8Array(ab, 0, len).set(new Uint8Array(wasm.memory.buffer, ptr, len))
  }
  return { ab, len }
}

function recyclePool (pool, ab, maxItems) {
  if (ab && ab.byteLength > 0 && pool.length < maxItems) {
    pool.push(ab)
  }
}

// Dual-mode WebGL2/WebGL1 OffscreenCanvas renderer inside the Worker:
// mode 0 = planar YUV420P (R8 in WebGL2 / LUMINANCE in WebGL1), mode 1 = RGBA or zero-copy WebCodecs VideoFrame.
function initOffscreenRenderer (canvas) {
  const opts = { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance', desynchronized: true }
  const gl2 = canvas.getContext('webgl2', opts)
  const gl = gl2 || canvas.getContext('webgl', opts)
  if (!gl) return null
  const isGl2 = Boolean(gl2)
  const vsSrc = isGl2
    ? '#version 300 es\nin vec2 a_pos;out vec2 v_uv;void main(){v_uv=vec2(a_pos.x*0.5+0.5,0.5-a_pos.y*0.5);gl_Position=vec4(a_pos,0.0,1.0);}'
    : 'attribute vec2 a_pos;varying vec2 v_uv;void main(){v_uv=vec2(a_pos.x*0.5+0.5,0.5-a_pos.y*0.5);gl_Position=vec4(a_pos,0.0,1.0);}'
  const fsSrc = isGl2
    ? '#version 300 es\nprecision mediump float;in vec2 v_uv;out vec4 outColor;uniform int u_mode;uniform sampler2D u_y;uniform sampler2D u_u;uniform sampler2D u_v;void main(){if(u_mode==1){outColor=vec4(texture(u_y,v_uv).rgb,1.0);return;}float y=(texture(u_y,v_uv).r-0.062745)*1.164384;float u=texture(u_u,v_uv).r-0.5;float v=texture(u_v,v_uv).r-0.5;outColor=vec4(y+1.792741*v,y-0.213249*u-0.532909*v,y+2.112402*u,1.0);}'
    : 'precision mediump float;varying vec2 v_uv;uniform int u_mode;uniform sampler2D u_y;uniform sampler2D u_u;uniform sampler2D u_v;void main(){if(u_mode==1){gl_FragColor=vec4(texture2D(u_y,v_uv).rgb,1.0);return;}float y=(texture2D(u_y,v_uv).r-0.062745)*1.164384;float u=texture2D(u_u,v_uv).r-0.5;float v=texture2D(u_v,v_uv).r-0.5;gl_FragColor=vec4(y+1.792741*v,y-0.213249*u-0.532909*v,y+2.112402*u,1.0);}'

  const vs = gl.createShader(gl.VERTEX_SHADER)
  gl.shaderSource(vs, vsSrc); gl.compileShader(vs)
  const fs = gl.createShader(gl.FRAGMENT_SHADER)
  gl.shaderSource(fs, fsSrc); gl.compileShader(fs)
  const prog = gl.createProgram()
  gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)

  const quad = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, quad)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'a_pos')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)

  const mkTex = unit => {
    gl.activeTexture(gl.TEXTURE0 + unit)
    const t = gl.createTexture()
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.LINEAR ? gl.TEXTURE_MIN_FILTER : 0x2801, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }
  const texY = mkTex(0), texU = mkTex(1), texV = mkTex(2)
  gl.uniform1i(gl.getUniformLocation(prog, 'u_y'), 0)
  gl.uniform1i(gl.getUniformLocation(prog, 'u_u'), 1)
  gl.uniform1i(gl.getUniformLocation(prog, 'u_v'), 2)
  const modeLoc = gl.getUniformLocation(prog, 'u_mode')
  return { gl, isGl2, canvas, texY, texU, texV, modeLoc, w: 0, h: 0, mode: -1 }
}

function drawOnWorkerGl (item) {
  const r = offRenderer
  if (!r) return
  const { gl, isGl2 } = r
  if (item.hwFrame) {
    const vf = item.hwFrame
    const fw = vf.displayWidth || vf.codedWidth || 0
    const fh = vf.displayHeight || vf.codedHeight || 0
    if (fw > 0 && fh > 0 && (r.w !== fw || r.h !== fh)) {
      r.w = fw; r.h = fh
      r.canvas.width = fw; r.canvas.height = fh
      gl.viewport(0, 0, fw, fh)
    }
    if (r.mode !== 1) { r.mode = 1; gl.uniform1i(r.modeLoc, 1) }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, r.texY)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, vf)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    return
  }

  const resized = (r.w !== item.w || r.h !== item.h)
  if (resized) {
    r.w = item.w; r.h = item.h
    r.canvas.width = item.w; r.canvas.height = item.h
    gl.viewport(0, 0, item.w, item.h)
  }
  const u8 = new Uint8Array(item.ab, 0, item.len)
  if (item.yuv) {
    const modeChanged = r.mode !== 0
    if (modeChanged) { r.mode = 0; gl.uniform1i(r.modeLoc, 0) }
    const cw = (item.w + 1) >> 1, ch = (item.h + 1) >> 1
    const yLen = item.w * item.h, cLen = cw * ch
    const intFmt = isGl2 ? gl.R8 : gl.LUMINANCE
    const srcFmt = isGl2 ? gl.RED : gl.LUMINANCE
    const reinit = resized || modeChanged
    const up = (unit, tex, tw, th, data) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, tex)
      if (reinit) gl.texImage2D(gl.TEXTURE_2D, 0, intFmt, tw, th, 0, srcFmt, gl.UNSIGNED_BYTE, data)
      else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, tw, th, srcFmt, gl.UNSIGNED_BYTE, data)
    }
    up(0, r.texY, item.w, item.h, u8.subarray(0, yLen))
    up(1, r.texU, cw, ch, u8.subarray(yLen, yLen + cLen))
    up(2, r.texV, cw, ch, u8.subarray(yLen + cLen, yLen + cLen * 2))
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  } else {
    const modeChanged = r.mode !== 1
    if (modeChanged) { r.mode = 1; gl.uniform1i(r.modeLoc, 1) }
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, r.texY)
    if (resized || modeChanged) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, item.w, item.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, u8)
    else gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, item.w, item.h, gl.RGBA, gl.UNSIGNED_BYTE, u8)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
}

function releaseRenderItem (item) {
  if (!item) return
  if (item.hwFrame) {
    try { item.hwFrame.close() } catch {}
  } else if (item.ab) {
    recyclePool(freeVideoPool, item.ab, 24)
  }
}

function clearRenderQueue () {
  while (renderQueue.length > 0) releaseRenderItem(renderQueue.shift())
  drawnInSession = 0
}

function ensureRenderLoop () {
  if (renderLoopActive || !offRenderer || useMse || closed) return
  renderLoopActive = true
  const sched = self.requestAnimationFrame || (fn => setTimeout(fn, 16))
  const step = () => {
    if (closed || useMse || !offRenderer) {
      renderLoopActive = false
      return
    }
    if (renderQueue.length > 0) {
      if (drawnInSession === 0) {
        const first = renderQueue[0]
        drawOnWorkerGl(first)
        drawnInSession = 1
        self.postMessage({ type: 'videoPrimed', seq: activeSeq, hw: useWebCodecs })
      } else if (clockPlaying) {
        const now = workerMediaTime()
        let pick = null
        while (renderQueue.length > 0 && renderQueue[0].pts <= now + 0.015) {
          const item = renderQueue.shift()
          queuedVideoSec = Math.max(0, queuedVideoSec - item.step)
          if (pick) releaseRenderItem(pick)
          pick = item
        }
        if (pick) {
          drawOnWorkerGl(pick)
          drawnInSession++
          releaseRenderItem(pick)
          if (!eof && !bufferedAhead()) schedulePump(0)
        }
      }
    }
    if (!eof || renderQueue.length > 0) {
      sched(step)
    } else {
      renderLoopActive = false
    }
  }
  sched(step)
}

function closeWebCodecs () {
  if (wcDecoder) {
    try { if (wcDecoder.state !== 'closed') wcDecoder.close() } catch {}
    wcDecoder = null
  }
}

async function setupWebCodecsIfPossible (hint) {
  closeWebCodecs()
  if (!offRenderer || !hint || !hint.codec || typeof self.VideoDecoder !== 'function') return false
  const cfg = {
    codec: hint.codec,
    codedWidth: hint.width,
    codedHeight: hint.height,
    optimizeForLatency: true
  }
  if (hint.descriptionHex && hint.descriptionHex.length >= 2) {
    const bytes = new Uint8Array(hint.descriptionHex.length >> 1)
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Number.parseInt(hint.descriptionHex.slice(i * 2, i * 2 + 2), 16)
    }
    cfg.description = bytes
  }
  try {
    const sup = await self.VideoDecoder.isConfigSupported(cfg)
    if (!sup || !sup.supported) return false
    wcConfig = sup.config || cfg
    return true
  } catch {
    return false
  }
}

function openWebCodecsInstance (seq, minPts) {
  closeWebCodecs()
  if (!wcConfig || typeof self.VideoDecoder !== 'function') return false
  try {
    const decInst = new self.VideoDecoder({
      output: vf => {
        if (closed || seq !== activeSeq) {
          try { vf.close() } catch {}
          return
        }
        const pts = (vf.timestamp || 0) / 1e6
        if (pts + 0.025 < minPts) {
          try { vf.close() } catch {}
          return
        }
        const step = lastVideoPts !== null ? Math.max(0.01, Math.min(0.2, pts - lastVideoPts)) : (1 / 30)
        lastVideoPts = pts
        queuedVideoSec += step
        // Maintain presentation order across B-frame reorders
        let ins = renderQueue.length
        while (ins > 0 && renderQueue[ins - 1].pts > pts) ins--
        renderQueue.splice(ins, 0, { pts, step, hwFrame: vf })
        ensureRenderLoop()
      },
      error: () => {
        if (!closed && seq === activeSeq && useWebCodecs) {
          useWebCodecs = false
          closeWebCodecs()
          wasm.pt_configure(currentVideoStream, currentAudioStream, currentSubStream, 0)
          wasm.pt_seek(workerMediaTime())
          schedulePump(0)
        }
      }
    })
    decInst.configure(wcConfig)
    wcDecoder = decInst
    return true
  } catch {
    return false
  }
}

let currentVideoStream = -1
let currentAudioStream = -1
let currentSubStream = -1

function bufferedAhead () {
  const wcQueueSec = (useWebCodecs && wcDecoder) ? (wcDecoder.decodeQueueSize / 30) : 0
  const maxVideo = useMse ? 8.0 : (offRenderer ? 1.0 : 1.5)
  const maxAudio = useMse ? 6.0 : 2.2
  const vOk = !hasVideo || (queuedVideoSec + wcQueueSec) >= maxVideo
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
  const maxSliceMs = 16
  for (let i = 0; i < 96; i++) {
    if (closed || seq !== activeSeq) return
    if (clockPlaying) wasm.pt_set_clock?.(workerMediaTime())
    const code = wasm.pt_step()
    if (code === 0) {
      if (useWebCodecs && wcDecoder && wcDecoder.state === 'configured') {
        wcDecoder.flush().catch(() => {})
      }
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
      const { ab, len } = copyPooledBuf([])
      const exact = len === ab.byteLength ? ab : ab.slice(0, len)
      self.postMessage({ type: 'mseInit', seq, buf: exact }, [exact])
    } else if (code === 2) {
      const { ab, len } = copyPooledBuf([])
      const exact = len === ab.byteLength ? ab : ab.slice(0, len)
      const start = wasm.pt_out_pts()
      const end = wasm.pt_out_dur()
      queuedVideoSec += Math.max(0.04, Math.min(4.0, end - start))
      self.postMessage({ type: 'mseSeg', seq, start, end, buf: exact }, [exact])
    } else if (code === 8) {
      if (wcDecoder && wcDecoder.state === 'configured') {
        const ptr = wasm.pt_out_ptr() >>> 0
        const len = wasm.pt_out_len() >>> 0
        const pts = wasm.pt_out_pts()
        const dur = wasm.pt_out_dur()
        const isKey = (wasm.pt_out_w() >>> 0) !== 0
        try {
          wcDecoder.decode(new self.EncodedVideoChunk({
            type: isKey ? 'key' : 'delta',
            timestamp: Math.round(pts * 1e6),
            duration: Math.round(dur * 1e6),
            data: new Uint8Array(wasm.memory.buffer, ptr, len)
          }))
        } catch {}
      }
    } else if (code === 3 || code === 7) {
      const pts = wasm.pt_out_pts()
      const w = wasm.pt_out_w() >>> 0
      const h = wasm.pt_out_h() >>> 0
      const step = lastVideoPts !== null ? Math.max(0.01, Math.min(0.2, pts - lastVideoPts)) : (1 / 30)
      lastVideoPts = pts
      queuedVideoSec += step
      const { ab, len } = copyPooledBuf(freeVideoPool)
      if (offRenderer) {
        renderQueue.push({ pts, step, w, h, yuv: code === 7, ab, len })
        ensureRenderLoop()
      } else {
        self.postMessage({ type: 'videoFrame', seq, pts, w, h, yuv: code === 7, buf: ab, byteLen: len }, [ab])
      }
    } else if (code === 4) {
      const { ab, len } = copyPooledBuf(freeAudioPool)
      const pts = wasm.pt_out_pts()
      const rate = wasm.pt_out_rate() >>> 0
      const samples = wasm.pt_out_samples() >>> 0
      if (rate > 0) queuedAudioSec += samples / rate
      self.postMessage({ type: 'audioChunk', seq, pts, rate, samples, buf: ab, byteLen: len }, [ab])
    } else if (code === 5) {
      const ptr = wasm.pt_out_ptr() >>> 0
      const len = wasm.pt_out_len() >>> 0
      const text = dec.decode(new Uint8Array(wasm.memory.buffer, ptr, len))
      self.postMessage({ type: 'subText', seq, start: wasm.pt_out_pts(), end: wasm.pt_out_dur(), text })
    } else if (code === 6) {
      const { ab, len } = copyPooledBuf([])
      const exact = len === ab.byteLength ? ab : ab.slice(0, len)
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
        buf: exact
      }, [exact])
    }
    if (bufferedAhead() || (performance.now() - tStart) >= maxSliceMs) break
  }
  if (!bufferedAhead()) schedulePump(0)
}

async function handleCmd (msg) {
  if (msg.cmd === 'initCanvas') {
    if (msg.canvas && !offRenderer) {
      offRenderer = initOffscreenRenderer(msg.canvas)
    }
    self.postMessage({ type: 'canvasReady', offscreen: Boolean(offRenderer) })
  } else if (msg.cmd === 'warmup') {
    await ensureWasm(msg.wasmUrl)
    self.postMessage({ type: 'warm' })
  } else if (msg.cmd === 'open') {
    closed = true
    closeWebCodecs()
    clearRenderQueue()
    if (wasm) wasm.pt_close()
    closed = false
    configured = false
    eof = false
    streamingMode = false
    clockPlaying = false
    clockMedia = 0
    wcConfig = null
    useWebCodecs = false
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
    const wcSupported = await setupWebCodecsIfPossible(payload.webCodecs)
    self.postMessage({
      type: 'manifest',
      seq: msg.seq,
      manifest: payload,
      byteLength: streamLen,
      offscreen: Boolean(offRenderer),
      webCodecsSupported: wcSupported
    })
  } else if (msg.cmd === 'start') {
    activeSeq = msg.seq || activeSeq
    currentVideoStream = msg.videoStream
    currentAudioStream = msg.audioStream
    currentSubStream = msg.subStream
    hasVideo = msg.videoStream >= 0
    hasAudio = msg.audioStream >= 0
    useMse = Boolean(msg.useMse)
    clearRenderQueue()
    closeWebCodecs()
    useWebCodecs = !useMse && hasVideo && Boolean(msg.allowWebCodecs) && openWebCodecsInstance(activeSeq, 0)
    streamingMode = true
    prefetchFrom(0)
    clockMedia = 0
    clockWallMs = nowWall()
    clockPlaying = false
    queuedVideoSec = 0
    queuedAudioSec = 0
    lastVideoPts = null
    eof = false
    const modeInt = useMse ? 1 : (useWebCodecs ? 2 : 0)
    const rc = wasm.pt_configure(msg.videoStream, msg.audioStream, msg.subStream, modeInt)
    if (rc < 0) {
      self.postMessage({ type: 'error', seq: activeSeq, error: readJson().error || 'Configure failed' })
      return
    }
    configured = true
    wasm.pt_set_clock?.(0)
    if (offRenderer && !useMse) ensureRenderLoop()
    schedulePump(0)
  } else if (msg.cmd === 'seek') {
    activeSeq = msg.seq
    currentVideoStream = msg.videoStream
    currentAudioStream = msg.audioStream
    currentSubStream = msg.subStream
    hasVideo = msg.videoStream >= 0
    hasAudio = msg.audioStream >= 0
    useMse = Boolean(msg.useMse)
    abortPrefetches()
    clearRenderQueue()
    closeWebCodecs()
    const target = Math.max(0, Number(msg.time) || 0)
    useWebCodecs = !useMse && hasVideo && Boolean(msg.allowWebCodecs) && openWebCodecsInstance(activeSeq, target)
    streamingMode = true
    clockMedia = target
    clockWallMs = nowWall()
    clockPlaying = false
    queuedVideoSec = 0
    queuedAudioSec = 0
    lastVideoPts = null
    eof = false
    const modeInt = useMse ? 1 : (useWebCodecs ? 2 : 0)
    wasm.pt_configure(msg.videoStream, msg.audioStream, msg.subStream, modeInt)
    wasm.pt_seek(target)
    configured = true
    wasm.pt_set_clock?.(target)
    self.postMessage({ type: 'flushed', seq: activeSeq, time: target })
    if (offRenderer && !useMse) ensureRenderLoop()
    schedulePump(0)
  } else if (msg.cmd === 'clock') {
    if (typeof msg.time === 'number') clockMedia = Math.max(0, msg.time)
    clockWallMs = typeof msg.wallMs === 'number' ? msg.wallMs : nowWall()
    clockPlaying = Boolean(msg.playing)
    if (wasm) wasm.pt_set_clock?.(workerMediaTime())
    if (offRenderer && !useMse && clockPlaying) ensureRenderLoop()
    if (!eof && !bufferedAhead()) schedulePump(0)
  } else if (msg.cmd === 'consumed') {
    if (!offRenderer || useMse) {
      queuedVideoSec = Math.max(0, queuedVideoSec - (Number(msg.videoSec) || 0))
    }
    queuedAudioSec = Math.max(0, queuedAudioSec - (Number(msg.audioSec) || 0))
    if (typeof msg.time === 'number') clockMedia = Math.max(0, msg.time)
    clockWallMs = typeof msg.wallMs === 'number' ? msg.wallMs : nowWall()
    if (typeof msg.playing === 'boolean') clockPlaying = msg.playing
    if (wasm) wasm.pt_set_clock?.(workerMediaTime())
    if (!eof && !bufferedAhead()) schedulePump(0)
  } else if (msg.cmd === 'close') {
    closed = true
    configured = false
    eof = true
    clockPlaying = false
    streamingMode = false
    abortPrefetches()
    closeWebCodecs()
    clearRenderQueue()
    blockCache.clear()
    if (wasm) wasm.pt_close()
  }
}

let cmdChain = Promise.resolve()
self.onmessage = ev => {
  const msg = ev.data || {}
  // Fast lock-free buffer recycling bypasses the async command queue
  if (msg.cmd === 'recycleVideo') {
    recyclePool(freeVideoPool, msg.buf, 24)
    return
  }
  if (msg.cmd === 'recycleAudio') {
    recyclePool(freeAudioPool, msg.buf, 32)
    return
  }
  if (msg.cmd === 'clock' && configured && !closed) {
    if (typeof msg.time === 'number') clockMedia = Math.max(0, msg.time)
    clockWallMs = typeof msg.wallMs === 'number' ? msg.wallMs : nowWall()
    clockPlaying = Boolean(msg.playing)
    if (wasm) wasm.pt_set_clock?.(workerMediaTime())
    if (offRenderer && !useMse && clockPlaying) ensureRenderLoop()
    if (!eof && !bufferedAhead()) schedulePump(0)
    return
  }
  cmdChain = cmdChain.then(() => handleCmd(msg)).catch(err => {
    self.postMessage({ type: 'error', seq: activeSeq, error: err?.message || String(err) })
  })
}
