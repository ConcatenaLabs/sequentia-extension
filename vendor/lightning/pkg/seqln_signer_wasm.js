/* @ts-self-types="./seqln_signer_wasm.d.ts" */

/**
 * The BOLT-8 Noise_XK **initiator** session (the browser device role in the
 * hosted topology: it connects OUT to the proxy responder). Holds the handshake
 * state until Act Two, then the post-handshake transport cipher.
 */
export class NoiseSession {
    static __wrap(ptr) {
        const obj = Object.create(NoiseSession.prototype);
        obj.__wbg_ptr = ptr;
        NoiseSessionFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        NoiseSessionFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_noisesession_free(ptr, 0);
    }
    /**
     * Decrypt a body (`len + 16` bytes) into the plaintext message.
     * @param {Uint8Array} body
     * @returns {Uint8Array}
     */
    decryptBody(body) {
        const ptr0 = passArray8ToWasm0(body, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.noisesession_decryptBody(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * Decrypt an 18-byte length header, returning the body length that follows
     * (so the caller knows how many bytes to read next off the socket).
     * @param {Uint8Array} hdr
     * @returns {number}
     */
    decryptHeader(hdr) {
        const ptr0 = passArray8ToWasm0(hdr, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.noisesession_decryptHeader(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Encrypt one plaintext message into a full BOLT-8 transport record
     * (18-byte encrypted length header || encrypted body+MAC).
     * @param {Uint8Array} msg
     * @returns {Uint8Array}
     */
    encrypt(msg) {
        const ptr0 = passArray8ToWasm0(msg, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.noisesession_encrypt(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * True once the handshake has completed and the transport is live.
     * @returns {boolean}
     */
    isReady() {
        const ret = wasm.noisesession_isReady(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Begin an initiator handshake toward a hosted proxy whose static pubkey is
     * `host_static_pubkey` (33 bytes, pinned), using our device transport
     * static privkey `device_static_privkey` (32 bytes) and a fresh 32-byte
     * `ephemeral_entropy` the caller draws from `crypto.getRandomValues`.
     * @param {Uint8Array} host_static_pubkey
     * @param {Uint8Array} device_static_privkey
     * @param {Uint8Array} ephemeral_entropy
     * @returns {NoiseSession}
     */
    static newInitiator(host_static_pubkey, device_static_privkey, ephemeral_entropy) {
        const ptr0 = passArray8ToWasm0(host_static_pubkey, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(device_static_privkey, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(ephemeral_entropy, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.noisesession_newInitiator(ptr0, len0, ptr1, len1, ptr2, len2);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return NoiseSession.__wrap(ret[0]);
    }
    /**
     * Consume Act Two (50 bytes) from the responder, returning Act Three (66
     * bytes) and transitioning to the ready transport. After this call
     * [`encrypt`]/[`decrypt_header`]/[`decrypt_body`] are live.
     * @param {Uint8Array} act2
     * @returns {Uint8Array}
     */
    readActTwo(act2) {
        const ptr0 = passArray8ToWasm0(act2, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.noisesession_readActTwo(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * Produce Act One (50 bytes) to send to the responder.
     * @returns {Uint8Array}
     */
    writeActOne() {
        const ret = wasm.noisesession_writeActOne(this.__wbg_ptr);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) NoiseSession.prototype[Symbol.dispose] = NoiseSession.prototype.free;

/**
 * The device signer. Holds the mnemonic-derived crypto kernel and per-channel
 * policy state, exactly like the native `dispatch::Signer`.
 */
export class Signer {
    static __wrap(ptr) {
        const obj = Object.create(Signer.prototype);
        obj.__wbg_ptr = ptr;
        SignerFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        SignerFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_signer_free(ptr, 0);
    }
    /**
     * Name a scriptPubKey of the wallet that holds this device's seed: a
     * cooperative close may then pay this side's balance to it, held to the
     * same balance as a close to the node's wallet. Only the page can name
     * one, never the node; named again after every start.
     * @param {Uint8Array} script
     */
    approveCloseDestination(script) {
        const ptr0 = passArray8ToWasm0(script, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        wasm.signer_approveCloseDestination(this.__wbg_ptr, ptr0, len0);
    }
    /**
     * One-time recovery: track a channel from parameters read off the NODE
     * (`listpeerchannels`) after the persisted blob was lost — trust-
     * equivalent to `setup_channel`, which also comes via the node. Refuses
     * to overwrite a tracked channel (returns false). `funding_txid` is the
     * DISPLAY-order 32 bytes (as RPC JSON shows it); reversed internally.
     * @param {Uint8Array} node_id
     * @param {bigint} dbid
     * @param {bigint} funding_sats
     * @param {Uint8Array} funding_txid
     * @param {number} funding_txout
     * @param {number} local_to_self_delay
     * @param {number} remote_to_self_delay
     * @param {Uint8Array} remote_revocation
     * @param {Uint8Array} remote_payment
     * @param {Uint8Array} remote_htlc
     * @param {Uint8Array} remote_delayed
     * @param {Uint8Array} remote_funding
     * @param {boolean} option_static_remotekey
     * @param {boolean} option_anchors
     * @param {boolean} option_tcov
     * @returns {boolean}
     */
    armChannel(node_id, dbid, funding_sats, funding_txid, funding_txout, local_to_self_delay, remote_to_self_delay, remote_revocation, remote_payment, remote_htlc, remote_delayed, remote_funding, option_static_remotekey, option_anchors, option_tcov) {
        const ptr0 = passArray8ToWasm0(node_id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(funding_txid, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(remote_revocation, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ptr3 = passArray8ToWasm0(remote_payment, wasm.__wbindgen_malloc);
        const len3 = WASM_VECTOR_LEN;
        const ptr4 = passArray8ToWasm0(remote_htlc, wasm.__wbindgen_malloc);
        const len4 = WASM_VECTOR_LEN;
        const ptr5 = passArray8ToWasm0(remote_delayed, wasm.__wbindgen_malloc);
        const len5 = WASM_VECTOR_LEN;
        const ptr6 = passArray8ToWasm0(remote_funding, wasm.__wbindgen_malloc);
        const len6 = WASM_VECTOR_LEN;
        const ret = wasm.signer_armChannel(this.__wbg_ptr, ptr0, len0, dbid, funding_sats, ptr1, len1, funding_txout, local_to_self_delay, remote_to_self_delay, ptr2, len2, ptr3, len3, ptr4, len4, ptr5, len5, ptr6, len6, option_static_remotekey, option_anchors, option_tcov);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * The persistable channel store (canonical payload + seed-keyed MAC).
     * @returns {Uint8Array}
     */
    exportChannels() {
        const ret = wasm.signer_exportChannels(this.__wbg_ptr);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
    /**
     * Convenience: construct from just the mnemonic string (no passphrase),
     * synthesizing the `32 zero bytes || mnemonic` on-disk form.
     * @param {string} mnemonic
     * @returns {Signer}
     */
    static fromMnemonic(mnemonic) {
        const ptr0 = passStringToWasm0(mnemonic, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.signer_fromMnemonic(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Signer.__wrap(ret[0]);
    }
    /**
     * Is this (peer, dbid) tracked?
     * @param {Uint8Array} node_id
     * @param {bigint} dbid
     * @returns {boolean}
     */
    hasChannel(node_id, dbid) {
        const ptr0 = passArray8ToWasm0(node_id, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.signer_hasChannel(this.__wbg_ptr, ptr0, len0, dbid);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] !== 0;
    }
    /**
     * Restore a persisted channel store. Live entries are never overwritten;
     * returns how many were added. Throws on a bad MAC / malformed blob.
     * @param {Uint8Array} blob
     * @returns {number}
     */
    importChannels(blob) {
        const ptr0 = passArray8ToWasm0(blob, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.signer_importChannels(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Drive ONE hsmd request -> reply. `frame_bytes` is a single signer-split
     * frame (`signer_frame.h`: little-endian `u32 len | is_main | node_id? |
     * dbid | capabilities | hsmd_msg`); the return is the single framed reply
     * (`u32 len | hsmd_reply`, a zero-length body being the error sentinel) —
     * byte-for-byte what the native serve loop writes back. Throws only on a
     * libhsmd-fatal condition (which closes the transport natively).
     * The reason the last request was refused, or answered without the
     * signature it asked for (cleared by the next request).
     * @returns {string | undefined}
     */
    get lastReject() {
        const ret = wasm.signer_lastReject(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Construct from the raw `hsm_secret` bytes (mnemonic format:
     * `32 zero bytes || mnemonic`, i.e. the exact on-disk file). Throws on a
     * malformed / unsupported secret.
     * @param {Uint8Array} hsm_secret_bytes
     */
    constructor(hsm_secret_bytes) {
        const ptr0 = passArray8ToWasm0(hsm_secret_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.signer_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        SignerFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * The payment limit for one asset (`asset` a display-order asset id or
     * `"btc"`), in its atoms per period; undefined when it has none.
     * @param {string} asset
     * @returns {number | undefined}
     */
    paymentLimit(asset) {
        const ptr0 = passStringToWasm0(asset, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.signer_paymentLimit(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        return ret[0] === 0 ? undefined : ret[1];
    }
    /**
     * The channels that predate validation (they came from the store of a
     * device that validated nothing, and this device signs no commitment
     * step for them; their peer closes them), as JSON: an array of
     * `{peerId, dbid, fundingTxid, fundingOutnum, fundingSats}`, the txid in
     * display order, hex strings throughout. `[]` when there are none.
     * @returns {string}
     */
    predatingChannels() {
        let deferred1_0;
        let deferred1_1;
        try {
            const ret = wasm.signer_predatingChannels(this.__wbg_ptr);
            deferred1_0 = ret[0];
            deferred1_1 = ret[1];
            return getStringFromWasm0(ret[0], ret[1]);
        } finally {
            wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
        }
    }
    /**
     * @param {Uint8Array} frame_bytes
     * @returns {Uint8Array}
     */
    processFrame(frame_bytes) {
        const ptr0 = passArray8ToWasm0(frame_bytes, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.signer_processFrame(this.__wbg_ptr, ptr0, len0);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v2;
    }
    /**
     * Give the rate the reference limit is converted at for one asset
     * (`asset` a display-order asset id or `"btc"`), as the node's fee
     * exchange rates give it: reference atoms per 10^8 atoms of the asset.
     * `rate` undefined, null or 0 forgets it, and the asset is then held to
     * 10,000,000 of its own atoms.
     * @param {string} asset
     * @param {number | null} [rate]
     */
    setAssetRate(asset, rate) {
        const ptr0 = passStringToWasm0(asset, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.signer_setAssetRate(this.__wbg_ptr, ptr0, len0, !isLikeNone(rate), isLikeNone(rate) ? 0 : rate);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Turn the M4 validating policy on (`enforce`) or off (`permissive`). The
     * browser build has no env, so this is how a caller selects enforce mode.
     * @param {boolean} enforce
     */
    setEnforce(enforce) {
        wasm.signer_setEnforce(this.__wbg_ptr, enforce);
    }
    /**
     * Set the payment limit, in atoms per period, for one asset (`asset` a
     * display-order asset id or `"btc"`) or, with `asset` undefined, the
     * same number of atoms for every asset in place of the default in the
     * reference unit. `atoms` undefined or null: no limit.
     * @param {string | null} [asset]
     * @param {number | null} [atoms]
     */
    setPaymentLimit(asset, atoms) {
        var ptr0 = isLikeNone(asset) ? 0 : passStringToWasm0(asset, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        var len0 = WASM_VECTOR_LEN;
        const ret = wasm.signer_setPaymentLimit(this.__wbg_ptr, ptr0, len0, !isLikeNone(atoms), isLikeNone(atoms) ? 0 : atoms);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Set the period the payment limits apply over, in seconds (default a
     * day).
     * @param {number} seconds
     */
    setPaymentPeriod(seconds) {
        const ret = wasm.signer_setPaymentPeriod(this.__wbg_ptr, seconds);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Set the default payment limit, in reference atoms per period, that
     * every asset without a limit of its own is held to at its rate
     * (`setAssetRate`). `reference` undefined or null: no limit. The default
     * is 1,000 reference units (10^11 reference atoms) a day.
     * @param {number | null} [reference]
     */
    setReferencePaymentLimit(reference) {
        const ret = wasm.signer_setReferencePaymentLimit(this.__wbg_ptr, !isLikeNone(reference), isLikeNone(reference) ? 0 : reference);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * The store changed since last asked (take-and-clear) — the cue to
     * persist `exportChannels`.
     * @returns {boolean}
     */
    takeChannelsDirty() {
        const ret = wasm.signer_takeChannelsDirty(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * The (peer node_id 33 bytes || dbid 8 bytes LE) of the most recent
     * "no tracked channel" refusal, take-and-clear; null when none. The
     * host's cue to fetch that channel off the node and `armChannel` it.
     * @returns {Uint8Array | undefined}
     */
    takeLastUntracked() {
        const ret = wasm.signer_takeLastUntracked(this.__wbg_ptr);
        let v1;
        if (ret[0] !== 0) {
            v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * The node's OWN wallet sweep scriptPubKey for key `index`: p2wpkh of the
     * bip86 key when `taproot` is false (the Elements sweep destination), or the
     * bip86 taproot output when true (the Bitcoin sweep destination). Lets a JS
     * harness synthesize a legit sweep output (and tamper it) for the enforce
     * custody proof, without hard-coding key derivation in JS.
     * @param {number} index
     * @param {boolean} taproot
     * @returns {Uint8Array}
     */
    walletSweepScript(index, taproot) {
        const ret = wasm.signer_walletSweepScript(this.__wbg_ptr, index, taproot);
        var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v1;
    }
}
if (Symbol.dispose) Signer.prototype[Symbol.dispose] = Signer.prototype.free;

/**
 * Derive the compressed static pubkey (33 bytes) for a transport static privkey
 * (32 bytes) — used to compute the device pubkey a hosted proxy must pin.
 * @param {Uint8Array} static_privkey
 * @returns {Uint8Array}
 */
export function devicePubkey(static_privkey) {
    const ptr0 = passArray8ToWasm0(static_privkey, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.devicePubkey(ptr0, len0);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_92b29b0548f8b746: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_344f42d3211c4765: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_now_c2901efeb3ef4d50: function() {
            const ret = Date.now();
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./seqln_signer_wasm_bg.js": import0,
    };
}

const NoiseSessionFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_noisesession_free(ptr, 1));
const SignerFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_signer_free(ptr, 1));

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('seqln_signer_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
