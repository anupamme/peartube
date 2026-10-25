const { Readable } = require('streamx')
const { BLOCK_NOT_AVAILABLE } = require('hypercore-errors')

const DESTROYED = new Error('Destroyed')

module.exports = class BlobReadStream extends Readable {
  constructor (core, id, opts = {}) {
    super(opts)

    const {
      prefetch,
      start = 0,
      end = -1,
      length = end === -1 ? -1 : end - start + 1
    } = opts

    this.core = core
    this.id = id

    this._prefetch = prefetch !== false && core && core.core
    this._range = null
    this._openCallback = null

    this._index = 0
    this._blockEnd = 0
    this._relativeOffset = 0
    this._start = start // bytes position relative to file
    this._length = length // bytes
  }

  static one (core, options) {
    const stream = new this(core, null, options)
    readyAndStart(core, stream)
    return stream
  }

  start (core, id) {
    if (this.destroying) return

    if (this.core === null) this.core = core
    this.id = id

    this._continueOpen(null)
  }

  async _openp () {
    if (!this.core.opened) await this.core.ready()
    if (this.destroying) return

    if (this._length === -1) this._length = this.id.byteLength - this._start
    this._blockEnd = this.id.blockOffset + this.id.blockLength

    if (this._length <= 0) {
      this._length = 0
      this.push(null)
      return
    }

    const start = await this._setStart()
    if (this.destroying) return
    if (start < this.id.blockOffset || start >= this._blockEnd) {
      this._length = 0
      this.push(null)
      return
    }

    if (this._prefetch) {
      const shared = this.core.core
      if (shared && shared._warmRanges && shared._warmRanges.length > 0) {
        for (let i = shared._warmRanges.length - 1; i >= 0; i--) {
          const w = shared._warmRanges[i]
          if (start < w.start || start >= w.end) {
            shared._warmRanges.splice(i, 1)
            clearTimeout(w.timer)
            w.range.destroy()
            w.core.close().catch(noop)
          }
        }
      }
      const avg = this.id.blockLength > 0 ? Math.max(1024, this.id.byteLength / this.id.blockLength) : 65536
      const span = Math.min(this.id.blockLength, Math.max(2, Math.ceil(this._length / avg) + 4))
      this._avgBlock = avg
      this._maxWin = Math.min(span, Math.max(32, Math.ceil((64 * 1024 * 1024) / avg)))
      const initWin = Math.min(this._maxWin, Math.max(4, Math.ceil((1536 * 1024) / avg)))
      this._win = initWin
      this._bytesRead = 0
      this._rangeStart = start
      this._rangeEnd = Math.min(this._blockEnd, start + this._win)
      this._range = this.core.download({ start, end: this._rangeEnd, linear: true })
    }
  }

  _open (cb) {
    if (this.core === null || this.id === null) {
      this._openCallback = cb
      return
    }

    this._openp().then(cb, cb)
  }

  async _setStart () {
    if (this._start === 0) {
      this._index = this.id.blockOffset
      this._relativeOffset = 0
      return this._index
    }

    const bytes = this.id.byteOffset + this._start
    const minBlock = this.id.blockOffset
    const maxBlock = this.id.blockOffset + this.id.blockLength
    const approxBlock = this.id.byteLength > 0
      ? Math.min(maxBlock - 1, minBlock + Math.floor((this._start / this.id.byteLength) * this.id.blockLength))
      : minBlock
    const shared = this.core.core
    const cacheKey = `${minBlock}:${bytes}`
    let result = shared._seekCache?.get(cacheKey)
    if (!result) {
      result = await this.core.seek(bytes, { minBlock, maxBlock, approxBlock })
      if (!result) throw BLOCK_NOT_AVAILABLE()
      if (!shared._seekCache) shared._seekCache = new Map()
      if (shared._seekCache.size >= 64) shared._seekCache.clear()
      shared._seekCache.set(cacheKey, result)
    }
    this._index = result[0]
    this._relativeOffset = result[1]

    return this._index
  }

  async _setEnd () {
    return this.id.blockOffset + this.id.blockLength
  }

  async _read (cb) {
    let block = null

    try {
      block = await this.core.get(this._index)
    } catch (err) {
      cb(err)
      return
    }

    if (!block) {
      cb(BLOCK_NOT_AVAILABLE())
      return
    }

    if (this._relativeOffset > 0) {
      block = block.subarray(this._relativeOffset)
      this._relativeOffset = 0
    }

    if (this._length < block.byteLength) {
      block = block.subarray(0, this._length)
    }

    this._index++
    this._length -= block.byteLength
    this._bytesRead = (this._bytesRead || 0) + block.byteLength
    if (this._maxWin && this._win < this._maxWin) {
      const targetBytes = this._bytesRead >= 16 * 1048576 ? 64 * 1048576 : this._bytesRead >= 6 * 1048576 ? 32 * 1048576 : this._bytesRead >= 2 * 1048576 ? 12 * 1048576 : this._bytesRead >= 524288 ? 4 * 1048576 : 0
      if (targetBytes > 0) {
        this._win = Math.min(this._maxWin, Math.max(this._win, Math.ceil(targetBytes / (this._avgBlock || 65536))))
      }
    }

    if (this._range && this._length > 0 && this._rangeEnd < this._blockEnd && this._rangeEnd - this._index <= ((this._win * 3) >> 2)) {
      const rem = Math.max(2, Math.ceil(this._length / Math.max(1024, block.byteLength)) + 2)
      const nextEnd = Math.min(this._blockEnd, Math.max(this._rangeEnd, this._index + Math.min(this._win, rem)))
      if (nextEnd > this._rangeEnd) {
        this._rangeEnd = nextEnd
        const r = this._range.request && this._range.request.context
        if (r && r.end !== -1 && nextEnd > r.end) {
          r.userEnd = r.end = nextEnd
          r.replicator.queueUpdateAll()
        } else {
          this._range.destroy()
          this._range = this.core.download({ start: this._index, end: this._rangeEnd, linear: true })
        }
      }
    }
    this.push(block)
    if (this._length === 0 || this._index >= this._blockEnd) this.push(null)
    cb(null)
  }

  _continueOpen (err) {
    if (this._openCallback === null) return

    const cb = this._openCallback
    this._openCallback = null

    if (err) {
      cb(err)
      return
    }

    this._open(cb)
  }

  _teardown () {
    const range = this._range
    const core = this.core
    this._range = null
    this.core = null
    if (range !== null && core !== null && this._length > 0 && !core.closing && core.core && !core.core.closing) {
      const shared = core.core
      if (!shared._warmRanges) shared._warmRanges = []
      while (shared._warmRanges.length >= 2) {
        const old = shared._warmRanges.shift()
        clearTimeout(old.timer)
        old.range.destroy()
        old.core.close().catch(noop)
      }
      const entry = {
        start: this._rangeStart || 0,
        end: this._rangeEnd || 0,
        range,
        core,
        timer: setTimeout(() => {
          const idx = shared._warmRanges ? shared._warmRanges.indexOf(entry) : -1
          if (idx !== -1) shared._warmRanges.splice(idx, 1)
          range.destroy()
          core.close().catch(noop)
        }, 4000)
      }
      entry.timer.unref?.()
      shared._warmRanges.push(entry)
      return Promise.resolve()
    }
    if (range !== null) range.destroy()
    if (core !== null) return core.close()
    return Promise.resolve()
  }

  _predestroy () {
    this._teardown().catch(noop)
    this._continueOpen(DESTROYED)
  }

  async _destroy (cb) {
    try {
      await this._teardown()
    } catch (err) {
      cb(err)
      return
    }

    cb(null)
  }
}

function noop () {}

async function readyAndStart (core, stream) {
  try {
    if (core.opened === false) await core.ready()
  } catch (err) {
    stream.destroy(err)
    return
  }

  const id = {
    blockOffset: 0,
    blockLength: core.length,
    byteOffset: 0,
    byteLength: core.byteLength
  }

  stream.start(core, id)
}
