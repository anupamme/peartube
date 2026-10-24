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
      const avg = this.id.blockLength > 0 ? Math.max(1024, this.id.byteLength / this.id.blockLength) : 65536
      const span = Math.min(this.id.blockLength, Math.max(2, Math.ceil(this._length / avg) + 4))
      const win = Math.max(8, Math.ceil((4 * 1024 * 1024) / avg))
      this._win = Math.min(span, win)
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

    const result = await this.core.seek(bytes, { minBlock, maxBlock, approxBlock })
    if (!result) throw BLOCK_NOT_AVAILABLE()

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

    if (this._range && this._length > 0 && this._rangeEnd < this._blockEnd && this._rangeEnd - this._index <= (this._win >> 1)) {
      const rem = Math.max(2, Math.ceil(this._length / Math.max(1024, block.byteLength)) + 2)
      this._rangeEnd = Math.min(this._blockEnd, Math.max(this._rangeEnd, this._index + Math.min(this._win, rem)))
      const r = this._range.request && this._range.request.context
      if (r && r.end !== -1 && this._rangeEnd > r.end) {
        r.userEnd = r.end = this._rangeEnd
        r.replicator.queueUpdateAll()
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
    if (this._range !== null) {
      this._range.destroy()
      this._range = null
    }

    if (this.core !== null) return this.core.close()
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
