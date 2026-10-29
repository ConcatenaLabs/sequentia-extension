/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

/**
 * One phrase's Bitcoin ark wallet.
 */
export class BtcArk {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Stops the wallet's daemon.
     */
    close(): void;
    /**
     * Opens (or creates) the wallet of `mnemonic` on `network`, against the ark
     * server at `server` (gRPC-web) and the Esplora server at `esplora`.
     */
    static open(network: string, mnemonic: string, server: string, esplora: string): Promise<BtcArk>;
    /**
     * Runs one command: `args` and the answer are JSON text.
     */
    run(cmd: string, args: string): Promise<any>;
}

export class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}

export class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}

export class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}

/**
 * The commands [BtcArk::run] answers to.
 */
export function commands(): string[];

/**
 * Logs to the console at `level` (error, warn, info, debug, trace).
 */
export function setLogLevel(level: string): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_btcark_free: (a: number, b: number) => void;
    readonly btcark_close: (a: number) => void;
    readonly btcark_open: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => any;
    readonly btcark_run: (a: number, b: number, c: number, d: number, e: number) => any;
    readonly commands: () => [number, number];
    readonly setLogLevel: (a: number, b: number) => void;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly intounderlyingbytesource_autoAllocateChunkSize: (a: number) => number;
    readonly intounderlyingbytesource_cancel: (a: number) => void;
    readonly intounderlyingbytesource_pull: (a: number, b: any) => any;
    readonly intounderlyingbytesource_start: (a: number, b: any) => void;
    readonly intounderlyingbytesource_type: (a: number) => number;
    readonly intounderlyingsink_abort: (a: number, b: any) => any;
    readonly intounderlyingsink_close: (a: number) => any;
    readonly intounderlyingsink_write: (a: number, b: any) => any;
    readonly intounderlyingsource_cancel: (a: number) => void;
    readonly intounderlyingsource_pull: (a: number, b: any) => any;
    readonly rust_zstd_wasm_shim_calloc: (a: number, b: number) => number;
    readonly rust_zstd_wasm_shim_free: (a: number) => void;
    readonly rust_zstd_wasm_shim_malloc: (a: number) => number;
    readonly rust_zstd_wasm_shim_memcmp: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_memcpy: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_memmove: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_memset: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_qsort: (a: number, b: number, c: number, d: number) => void;
    readonly rustsecp256k1_v0_14_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_14_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_14_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_14_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__hd8f2a7b8acf89793: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h74687f99ab91d5b2: (a: number, b: number, c: any) => [number, number];
    readonly wasm_bindgen__convert__closures_____invoke__h10333b0ac7481f4e: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h719a53bce74960bb: (a: number, b: number, c: any) => any;
    readonly wasm_bindgen__convert__closures_____invoke__hab3485ff77d16161: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h1b0fb8c68ed6b8c5: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h2e60de373cf73846: (a: number, b: number, c: any) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h913b58eb6cc53c14: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h33af768c328ccdc2: (a: number, b: number) => void;
    readonly wasm_bindgen__convert__closures_____invoke__h252368a97150c88c: (a: number, b: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
