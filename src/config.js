// Central endpoint + constant configuration. The web wallet resolves every
// backend relative to location.origin behind a reverse proxy; an extension has
// no meaningful origin, so every base is explicit here. All of these are served
// by the public testnet box.
export const BASE = 'https://sequentiatestnet.com';

export const ESPLORA = BASE + '/api';                 // Sequentia esplora (sequentia-electrs)
export const T4_API = BASE + '/testnet4/api';         // Bitcoin testnet4 esplora
export const PRICES_URL = BASE + '/prices';           // {TICKER: usdPrice}
export const FEERATES_URL = BASE + '/feerates';       // node getfeeexchangerates; tSEQ keyed "bitcoin"
export const REGISTRY_URL = BASE + '/registry/index.minimal.json';
export const OPENAMP = BASE + '/openamp';             // OpenAMP restricted-asset service
export const EXPLORER_TX = BASE + '/explorer/tx/';    // display links
export const EXPLORER_T4_TX = BASE + '/testnet4/tx/';

// Hosted-SeqLN LSP (Tier-2: keyless hosted nodes, this device co-signs). The
// bearer token is the interim shared testnet-demo token; the host pubkeys are
// the hosted proxies' pinned Noise responder identities. No key material here:
// device identities are derived from the user's mnemonic (vendor/seqln-keys.js).
export const LSP = {
  url: BASE + '/lsp',
  wsBase: BASE.replace(/^https/, 'wss'),   // per-user provisioned-node wss base (a SW has no usable location.origin)
  token: 'b5b1-d848ec96d29c01d2ff1db6cf',
  wsAsset: 'wss://sequentiatestnet.com/lsp-ws-asset',
  hostPubkeyAsset: '0295374d947dc7e27382a83b2034a10b3d51b6f2fdf7e7da490893e3995141523b',
  wsBtc: 'wss://sequentiatestnet.com/lsp-ws-btc',
  hostPubkeyBtc: '020a749af93e2a5a4d67ad28585cec31b55a146969eb77ca3d076eb59ff111ed51',
};

// The height from which the network signs stake records the second-generation
// way (committing to the amount). null means the network's own, which the kit
// carries per network and binds to its genesis; a number overrides it, for a
// private chain started with -posrecordsv2height.
export const RECORDS_V2_HEIGHT = null;

export const DEFAULT_FEERATE = 2000;   // sat/kvB reference feerate (2 sat/vB), above min relay
export const BTC_FEERATE = 2;          // sat/vB for parent-chain testnet4 sends
export const EXCHANGE_RATE_SCALE = 100000000;

export const AUTOLOCK_MINUTES_DEFAULT = 30;

// Built-in tickers for the public testnet demo assets (offline fallback; the
// registry overrides these at runtime).
export const DEFAULT_ASSETS = {
  '048c7943385563c3f74982760f88654a4acb1ecc0bd49803c2f52b304ee7ce11': { ticker: 'USDX', name: 'USD Stablecoin', precision: 8 },
  '701aae7392509f7d0dc9c281ac821c9e5fb523e07673957c093b7a6f724ac92b': { ticker: 'EURX', name: 'Euro Stablecoin', precision: 8 },
  '3a0f9192219db59f8d7f87d93ac6311095dfe1255d149727b87baaa7d2cc71a1': { ticker: 'GOLD', name: 'Gold (troy ounce)', precision: 8 },
  'f30edec8211e1f395ddd44d380f70b5bea74989df952604fac636d9bb926bc30': { ticker: 'SILVR', name: 'Silver (troy ounce)', precision: 8 },
  'df66fc977b42c2c049184422a27e38aea2c3ce60e91a56d0b2c5d63256fc835d': { ticker: 'OILX', name: 'Crude Oil (barrel)', precision: 8 },
};
