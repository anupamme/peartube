// The worklet's `crypto`: createHash('sha256'), the only part of it that the core
// (src/index.js) and LAN discovery (@p2plabs/hyperdht-mdns) use. It runs on
// sodium-native, which the worklet loads anyway, so the app does not ship
// bare-crypto's 0.8 MB native library. package.json's `imports` and
// worklet/imports.json map `node:crypto` and `crypto` here for Bare.
const b4a = require('b4a')
const sodium = require('sodium-native')

exports.createHash = function createHash (algorithm) {
  if (algorithm !== 'sha256') throw new Error(`The worklet has no ${algorithm} hash, only sha256`)
  const state = b4a.alloc(sodium.crypto_hash_sha256_STATEBYTES)
  sodium.crypto_hash_sha256_init(state)
  return {
    update (data, encoding) {
      sodium.crypto_hash_sha256_update(state, typeof data === 'string' ? b4a.from(data, encoding) : data)
      return this
    },
    digest (encoding) {
      const hash = b4a.alloc(sodium.crypto_hash_sha256_BYTES)
      sodium.crypto_hash_sha256_final(state, hash)
      return encoding ? b4a.toString(hash, encoding) : hash
    }
  }
}
