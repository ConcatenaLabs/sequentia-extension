/* tslint:disable */
/* eslint-disable */
/**
 * The `ReadableStreamType` enum.
 *
 * *This API requires the following crate features to be activated: `ReadableStreamType`*
 */

export type ReadableStreamType = "bytes";

/**
 * One Arca wallet, open in this worker.
 */
export class ArcaWallet {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Creates the wallet of `mnemonic` against the server and node `config`
     * names (`{"server", "node_url", "node_user"?, "node_password"?,
     * "exit_delay_units"?, "min_exit_delay_units"?, "max_exit_delay_units"?}`),
     * pinning the node's chain and the server's operator key, as `arca
     * create` does. Its answer is `info`, with `operator_key_check`.
     */
    static create(mnemonic: string, config: string): ArcaWallet;
    /**
     * Opens the wallet of `mnemonic` this browser holds; the node's password
     * is handed over again on each open and never stored.
     */
    static open(mnemonic: string, node_password?: string | null): ArcaWallet;
    /**
     * Runs one command, as `arca <command>` does, `args` a JSON object of its
     * arguments: the library's [`command::run_answer`], whose answer is
     * `{"result", "start", "cost"}`, whose refusal carries what the command
     * cost before it was refused, and whose commands are
     * [`command::COMMANDS`].
     */
    run(command: string, args: string): string;
}

declare class IntoUnderlyingByteSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableByteStreamController): Promise<any>;
    start(controller: ReadableByteStreamController): void;
    readonly autoAllocateChunkSize: number;
    readonly type: ReadableStreamType;
}
export type { IntoUnderlyingByteSource };

declare class IntoUnderlyingSink {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    abort(reason: any): Promise<any>;
    close(): Promise<any>;
    write(chunk: any): Promise<any>;
}
export type { IntoUnderlyingSink };

declare class IntoUnderlyingSource {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    cancel(): void;
    pull(controller: ReadableStreamDefaultController): Promise<any>;
}
export type { IntoUnderlyingSource };

/**
 * Whether this browser's storage holds the wallet of `mnemonic`.
 */
export function arcaWalletExists(mnemonic: string): boolean;

/**
 * Installs SQLite's OPFS storage in `directory` as the default, and
 * registers the worker's HTTP and pause. Call once, in a dedicated worker,
 * before anything else. A second tab's worker fails here while the first
 * holds the storage, so one wallet runs at a time.
 */
export function installStore(directory: string): Promise<void>;

/**
 * Waits `ms` milliseconds as the library does between two tries: through
 * the host's wait ([`set_pause`]), never less than `ms`. For a host to check
 * its wait.
 */
export function pause(ms: number): void;

/**
 * Gives the library the host's wait, `wait(ms)`: a function that blocks the
 * calling thread for up to `ms` milliseconds without using the processor,
 * and returns. It may return early or throw; the library then waits out the
 * rest on the clock, which keeps a core busy, so a host that can wait
 * without one should give it. `null` takes it back. How the host waits is
 * its own: a synchronous request its server holds, `Atomics.wait` on a
 * shared buffer where the page is cross-origin isolated or under Node.
 */
export function setPause(wait?: Function | null): void;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_arcawallet_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingbytesource_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsink_free: (a: number, b: number) => void;
    readonly __wbg_intounderlyingsource_free: (a: number, b: number) => void;
    readonly arcaWalletExists: (a: number, b: number) => [number, number, number];
    readonly arcawallet_create: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly arcawallet_open: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly arcawallet_run: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly installStore: (a: number, b: number) => any;
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
    readonly pause: (a: number) => void;
    readonly setPause: (a: number) => void;
    readonly rust_zstd_wasm_shim_calloc: (a: number, b: number) => number;
    readonly rust_zstd_wasm_shim_free: (a: number) => void;
    readonly rust_zstd_wasm_shim_malloc: (a: number) => number;
    readonly rust_zstd_wasm_shim_memcmp: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_memcpy: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_memmove: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_memset: (a: number, b: number, c: number) => number;
    readonly rust_zstd_wasm_shim_qsort: (a: number, b: number, c: number, d: number) => void;
    readonly rust_sqlite_wasm_abort: () => void;
    readonly rust_sqlite_wasm_assert_fail: (a: number, b: number, c: number, d: number) => void;
    readonly rust_sqlite_wasm_calloc: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_malloc: (a: number) => number;
    readonly rust_sqlite_wasm_free: (a: number) => void;
    readonly rust_sqlite_wasm_getentropy: (a: number, b: number) => number;
    readonly rust_sqlite_wasm_localtime: (a: number) => number;
    readonly rust_sqlite_wasm_realloc: (a: number, b: number) => number;
    readonly sqlite3_os_end: () => number;
    readonly sqlite3_os_init: () => number;
    readonly rustsecp256k1zkp_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1zkp_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_14_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_14_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_14_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_14_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_context_create: (a: number) => number;
    readonly rustsecp256k1_v0_10_0_context_destroy: (a: number) => void;
    readonly rustsecp256k1_v0_10_0_default_error_callback_fn: (a: number, b: number) => void;
    readonly rustsecp256k1_v0_10_0_default_illegal_callback_fn: (a: number, b: number) => void;
    readonly wasm_bindgen_6c31107e48cb2cdf___convert__closures_____invoke___js_sys_88ba868c340644c5___Function_fn_wasm_bindgen_6c31107e48cb2cdf___JsValue_____wasm_bindgen_6c31107e48cb2cdf___sys__Undefined___js_sys_88ba868c340644c5___Function_fn_wasm_bindgen_6c31107e48cb2cdf___JsValue_____wasm_bindgen_6c31107e48cb2cdf___sys__Undefined_______true_: (a: number, b: number, c: any, d: any) => void;
    readonly wasm_bindgen_6c31107e48cb2cdf___convert__closures_____invoke___wasm_bindgen_6c31107e48cb2cdf___JsValue__core_d941ad8722425d2e___result__Result_____wasm_bindgen_6c31107e48cb2cdf___JsError___true_: (a: number, b: number, c: any) => [number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __wbindgen_destroy_closure: (a: number, b: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
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
