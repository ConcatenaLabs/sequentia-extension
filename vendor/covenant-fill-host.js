// ---------------------------------------------------------------------------
// Host seam for the passive-CLOB covenant order flow. covenant-order.js builds
// and byte-verifies every field of a FILL (the covenant scriptPubKey, the
// introspection-only [leaf, control_block] witness, the credit/remainder/receipt
// amounts). The ONE thing it cannot do from JS is assemble + sign the raw
// Elements FILL transaction: a taproot script-path covenant input (no signature)
// at index 0, the taker's own key-path funding inputs signed from the seed, and
// the explicit outputs in the covenant's fixed order. That is the wasm helper
// `buildCovenantFillTx` (LWK / lwk_wasm). This module wires it, plus the two
// I/O hooks (`spkToAddress`, `fetchUtxoSpk`, `broadcast`), into the shapes
// covenant-order.js's place()/settleFill() consume.
//
// Nothing here re-derives covenant bytes — covenant-order.js already produced and
// verified the recipe. This module only:
//   * selects the taker's own asset-B (and fee-asset) funding UTXOs,
//   * hands the wallet derivation coordinates (chain/index) of each to the signer,
//   * calls the wasm assembler, and broadcasts.
// ---------------------------------------------------------------------------

// makeCovenantHooks builds the hooks object covenant-order.js expects.
//
// ctx = {
//   wasm,                       // the lwk_wasm module (scriptToAddress, buildCovenantFillTx)
//   wollet,                     // the LWK Wollet (utxos(), address())
//   network,                    // the lwk_wasm Network
//   mnemonic,                   // the recovery phrase (used only to sign, in-memory)
//   esploraFetch,               // async (path) -> Response, against the wallet's OWN /api
//   receiveAddress,             // () -> address string for the taker asset-A receipt
//   changeAddress,              // () -> address string for change (defaults to receiveAddress)
//   fee: { asset, atoms },      // the on-chain network fee (open fee market)
//   opts,                       // forwarded to planFillFromMatched (e.g. makerCancellableOK)
//   genesisHash,                // optional () -> Promise<hexString>; defaults to esplora /block-height/0
//   onStatus,                   // optional progress callback
// }
// Which derivation chain a wallet coin sits on: 1 for internal (change), 0 for external. The kit's
// extInt() answers the Chain enum's number (0 External, 1 Internal); this read it as text and looked
// for "internal", which a number never contains, so every change coin was signed with the external
// key at its index and the fill was refused ("p2wpkh(key) != its scriptPubKey — wrong derivation").
// A covenant fill could never spend change. Accepts the number or a name.
export function chainOf(u){
  if (!u || typeof u.extInt !== 'function') return 0;
  const c = u.extInt();
  return (c === 1 || String(c).toLowerCase().includes('internal')) ? 1 : 0;
}

export function makeCovenantHooks(ctx){
  const receive = () => (ctx.receiveAddress ? ctx.receiveAddress() : ctx.wollet.address(undefined).address().toString());
  const change  = () => (ctx.changeAddress ? ctx.changeAddress() : receive());

  // The Elements taproot sighash (used by the REFUND script-path spend) is
  // domain-separated by the network genesis block hash. Fetch it once from the
  // wallet's own node (esplora returns the height-0 block hash as text) unless the
  // caller supplied it.
  let _genesis = null;
  const genesisHash = ctx.genesisHash || (async () => {
    if (_genesis) return _genesis;
    const res = await ctx.esploraFetch('/block-height/0');
    const txt = (await res.text()).trim();
    if (!res.ok || !/^[0-9a-fA-F]{64}$/.test(txt)) throw new Error(`could not fetch genesis hash: ${txt}`);
    _genesis = txt.toLowerCase();
    return _genesis;
  });

  return {
    opts: ctx.opts,
    onStatus: ctx.onStatus,

    // Turn a covenant scriptPubKey into the address the maker funds (place()).
    spkToAddress: (spkHex) => ctx.wasm.scriptToAddress(spkHex, ctx.network),

    // The funded UTXO's real scriptPubKey, so planFillFromMatched can enforce the
    // covenant equality check against the on-chain output (anti-relay-lie).
    fetchUtxoSpk: async (txid, vout) => {
      try {
        const res = await ctx.esploraFetch(`/tx/${txid}`);
        if (!res.ok) return null;
        const tx = await res.json();
        const o = tx.vout && tx.vout[vout];
        return o && o.scriptpubkey ? o.scriptpubkey : null;
      } catch { return null; }
    },

    // THE assembly seam. `recipe` is the verified output of planFillFromMatched;
    // we add the taker's funding selection + addresses + fee + seed and call wasm.
    buildCovenantFillTx: async (recipe) => {
      const feeAsset = ctx.fee.asset;
      const feeAtoms = BigInt(ctx.fee.atoms);
      // BYTE ORDER: the recipe's asset ids come straight from the relay's CovenantTerms and are
      // INTERNAL byte order (as the leaf bakes them). Everything on THIS side of the seam —
      // wallet coin selection (unblinded().asset().toString()) and the wasm assembler
      // (AssetId::from_str) — speaks DISPLAY hex, so flip here, exactly like the Go settler's
      // displayHex(order.AssetA) (seqdex covfill.go). The leaf/control-block/witness hexes are
      // consensus bytes and are NOT touched.
      const creditAsset = revHexStr(recipe.creditAsset);
      const covenantAsset = revHexStr(recipe.covenantAsset);
      const remainderAsset = recipe.remainderAsset ? revHexStr(recipe.remainderAsset) : recipe.remainderAsset;
      const creditValue = BigInt(recipe.creditValue);

      // How much of each asset the taker must fund: the maker credit (asset B) plus
      // the network fee (fee asset). Asset A comes from the covenant, never funded.
      const need = new Map();
      const add = (asset, amt) => need.set(asset, (need.get(asset) || 0n) + amt);
      add(creditAsset, creditValue);
      add(feeAsset, feeAtoms);
      if (need.has(covenantAsset))
        throw new Error('fee/credit asset must not be the covenant sold asset A');

      // Greedy largest-first coin selection over the wallet's own UTXOs, per asset.
      // EXPLICIT COINS ONLY: a covenant fill is an all-explicit transaction (the leaf
      // introspects explicit amounts), so a CONFIDENTIAL input can never balance it —
      // consensus compares the input's value commitment against the explicit output
      // sum and rejects the tx with "value in != value out". The wallet unblinds its
      // own coins, so a blinded UTXO looks identical to an explicit one through
      // unblinded() unless we ask the secrets whether the on-chain form was explicit.
      const utxos = ctx.wollet.utxos();
      const byAsset = new Map();
      const blindedHeld = new Map();   // per-asset value held in confidential outputs (unusable here)
      for (const u of utxos){
        const sec = u.unblinded();
        const asset = sec.asset().toString();
        if (!need.has(asset)) continue;
        if (sec.isExplicit && !sec.isExplicit()){
          blindedHeld.set(asset, (blindedHeld.get(asset) || 0n) + BigInt(sec.value()));
          continue;
        }
        if (!byAsset.has(asset)) byAsset.set(asset, []);
        byAsset.get(asset).push(u);
      }

      const takerFundingUtxos = [];
      for (const [asset, target] of need){
        const cands = (byAsset.get(asset) || []).slice().sort((a,b) =>
          (b.unblinded().value() > a.unblinded().value() ? 1 : -1));
        let sum = 0n;
        for (const u of cands){
          if (sum >= target) break;
          const op = u.outpoint();
          const spk = u.scriptPubkey();
          takerFundingUtxos.push({
            txid: op.txid().toString(),
            vout: op.vout(),
            value: String(u.unblinded().value()),
            asset,
            spkHex: (spk.toString ? spk.toString() : bytesHex(spk.bytes())),
            chain: chainOf(u),
            index: u.wildcardIndex(),
          });
          sum += BigInt(u.unblinded().value());
        }
        if (sum < target){
          const blinded = blindedHeld.get(asset) || 0n;
          throw new Error(`insufficient transparent ${asset}: need ${target}, have ${sum}`
            + (blinded > 0n ? ` (a further ${blinded} is held in confidential outputs, which an on-chain covenant fill cannot spend; send it to yourself at a transparent address first)` : ''));
        }
      }

      const full = {
        covenantTxid: recipe.covenantTxid,
        covenantVout: recipe.covenantVout,
        covenantAsset,                      // DISPLAY hex (converted above) — wasm parses display ids
        covenantLocked: String(recipe.covenantLocked),
        fillLeafHex: recipe.fillLeafHex,
        controlBlockHex: recipe.controlBlockHex,
        creditAsset,                        // DISPLAY hex (converted above)
        creditProg: recipe.creditProg,
        creditProgVer: recipe.creditProgVer == null ? 1 : recipe.creditProgVer,
        creditValue: String(recipe.creditValue),
        partial: !!recipe.partial,
        remainderAsset,                     // DISPLAY hex (converted above; == covenantAsset when partial)
        remainderValue: recipe.partial ? String(recipe.remainderValue) : undefined,
        remainderSpkHex: recipe.remainderSpkHex,
        takerFundingUtxos,
        takerReceiptAddr: receive(),
        takerChangeAddr: change(),
        feeAtoms: String(feeAtoms),
        feeAsset,
        mnemonic: ctx.mnemonic,
      };
      // wasm returns { rawHex, txid }.
      return ctx.wasm.buildCovenantFillTx(full, ctx.network);
    },

    // THE refund seam. `recipe` is the verified output of planRefund; we add the
    // maker's fee funding, addresses, the network genesis hash, and the seed, then
    // call the wasm assembler to sign the CLTV script-path reclaim.
    buildCovenantRefundTx: async (recipe) => {
      // BYTE ORDER: unlike the fill recipe (relay terms, always internal), a refund recipe is
      // wallet-local and its covenantAsset byte order depends on the record generation — so the
      // caller (swap.js cancel path) is responsible for handing a DISPLAY-hex id here. No flip.
      const covAsset = recipe.covenantAsset;
      const feeAsset = ctx.fee.asset;
      const feeAtoms = BigInt(ctx.fee.atoms);

      // Fund the fee ONLY when it is a different asset than the covenant (asset A):
      // when the fee IS asset A it is taken from the reclaimed coins, no fee input.
      const extraFeeUtxos = [];
      if (feeAsset !== covAsset && feeAtoms > 0n){
        const utxos = ctx.wollet.utxos();
        // Explicit coins only, same reason as the fill seam: the refund is an
        // all-explicit spend, so a confidential fee input can never balance it.
        const cands = utxos
          .filter(u => u.unblinded().asset().toString() === feeAsset)
          .filter(u => !(u.unblinded().isExplicit && !u.unblinded().isExplicit()))
          .sort((a,b) => (b.unblinded().value() > a.unblinded().value() ? 1 : -1));
        let sum = 0n;
        for (const u of cands){
          if (sum >= feeAtoms) break;
          const op = u.outpoint(); const spk = u.scriptPubkey();
          extraFeeUtxos.push({
            txid: op.txid().toString(), vout: op.vout(),
            value: String(u.unblinded().value()), asset: feeAsset,
            spkHex: (spk.toString ? spk.toString() : bytesHex(spk.bytes())),
            chain: chainOf(u),
            index: u.wildcardIndex(),
          });
          sum += BigInt(u.unblinded().value());
        }
        if (sum < feeAtoms) throw new Error(`insufficient ${feeAsset} for the refund fee: need ${feeAtoms}, have ${sum}`);
      }

      const genesisHex = await genesisHash();
      const full = {
        covenantTxid: recipe.covenantTxid,
        covenantVout: recipe.covenantVout,
        covenantAsset: covAsset,
        covenantLocked: String(recipe.covenantLocked),
        covenantSpkHex: recipe.covenantSpkHex,
        refundLeafHex: recipe.refundLeafHex,
        controlBlockHex: recipe.controlBlockHex,
        expiryLocktime: recipe.expiryLocktime,
        genesisHex,
        makerReclaimAddr: receive(),
        makerKeyPath: recipe.makerKeyPath,        // m/86'/coin'/0'/0/index — the leaf's key
        feeAtoms: String(feeAtoms),
        feeAsset,
        extraFeeUtxos,
        changeAddr: change(),
        mnemonic: ctx.mnemonic,
      };
      return ctx.wasm.buildCovenantRefundTx(full, ctx.network);
    },

    // Broadcast a raw Elements tx hex against the wallet's OWN node; returns txid.
    broadcast: async (rawHex) => {
      const res = await ctx.esploraFetch('/tx', { method: 'POST', body: rawHex });
      const txt = (await res.text()).trim();
      if (!res.ok) throw new Error(`broadcast failed: ${txt}`);
      // Apply our own tx to the wollet immediately (the scan is minutes stale): without this
      // the next build re-selects the funding coins this fill just spent and the node rejects
      // it with bad-txns-inputs-missingorspent. (ctx.wasm.Transaction was missing from this
      // context until 2026-08-11, so this apply had silently never run.)
      try { if (ctx.wasm && ctx.wasm.Transaction){ const t = new ctx.wasm.Transaction(rawHex); ctx.wollet.applyTransaction(t); if (ctx.noteOwnTx) ctx.noteOwnTx(t); } } catch {}
      return txt;
    },
  };
}

// A maker's taproot payout: derive a BIP86 taproot receive the wallet controls and
// return { program, spkHex, address, descriptor } — program is the offer's
// maker_prog, descriptor is the companion `eltr` wollet that watches + spends the
// credit (the primary wpkh wollet does not track taproot receives).
export function makerPayout(signer, network, index = 0){
  const a = signer.covenantMakerAddress(network, index);
  return {
    program: a.program,
    spkHex: a.spkHex,
    address: a.address,
    internalKey: a.internalKey,
    path: a.path,
    descriptor: signer.covenantMakerDescriptor().toString(),
  };
}

function bytesHex(u8){ let s=''; for (const b of u8) s += b.toString(16).padStart(2,'0'); return s; }

// Reverse a hex string's byte order (INTERNAL <-> DISPLAY asset id). Exported for the
// byte-order seam test; swap.js keeps its own copy (revHex) for the place/refund side.
export function revHexStr(h){ return (String(h || '').match(/../g) || []).reverse().join(''); }
