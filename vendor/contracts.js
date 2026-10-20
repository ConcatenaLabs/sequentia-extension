// CONTRACTS: developer mode's contract spends.
//
// A contract is a template written with sequentia-contracts (a descriptor and the
// source of each of its programs) and an instance (the template's values on this
// chain). With developer mode on, the Contracts tab reads a template (one the kit
// carries, or one pasted here and added to this wallet's list by hand), recomputes an
// instance's address, finds the coins it holds, and builds the spend of a chosen path.
//
// Nothing about a contract is decided here. The kit's contract engine (lwk_contracts,
// in pkg/) reads the descriptor with sequentia-contracts' own reader and pinned
// compiler, recomputes the output, builds the transaction, checks the chain's locks,
// runs the program against the final transaction, and signs only under the five-point
// rule: the template is on this wallet's list, the output was recomputed, the program
// ran, the approval showed the template, the path, the parameters by role, every
// input by what it is and this wallet's balance change in every asset, and the key is
// a contract key (m/8383h/1h/0h/0/0) or, on a path that takes no signature, none. A
// spend may add this wallet's own coins (a top-up, a repayment, a fee in another
// asset): the wallet picks them itself when asked to fund the spend, and the engine
// checks every wallet input against the wallet's own record of its coins. A spend may
// add a foreign coin spent through a script leaf with a given witness (an oracle's
// beacon coin, spent and recreated): this module reads the chain's record of it, and
// of the contract coin, from Esplora, and the engine refuses a coin the record does
// not back. This module asks the engine, renders the approval it returns, and signs
// the digest of exactly what it rendered. Refusals are shown in the engine's own
// words.
//
// The rendering (approvalSections) is shared with the browser extension, which copies
// this file into vendor/.
//
// Everything outside the engine is injected, so the module runs under Node
// (contracts.test.mjs, tooling/contracts-regtest.mjs).
//
// ctx:
//   lwk                 the kit's wasm module (ContractTemplate, ContractInstance,
//                       ContractSpend, ContractApproval)
//   network()           the wasm Network the wallet is on
//   signer()            the wasm Signer of the open wallet
//   esploraFetch(path, opts) -> fetch Response, against the chain's Esplora API
//   registryFetch(path) -> fetch Response, against the registry ('/contracts/...');
//                       optional
//   walletScripts()     -> hex scripts of the wallet's own addresses
//   walletCoins()       -> the wallet's own record of its coins, as the engine takes
//                       them (lwk.ContractSpend.walletCoins(wollet)); optional, and a
//                       spend with wallet inputs needs it
//   receiveAddress()    -> the wallet's current receive address
//   assetMeta(hex)      -> { ticker, precision }
//   store               localStorage-alike
//   el(tag, cls, text)  builds a node; text is set as text, never markup

export const TRUSTED_KEY = 'swk.contracts.trusted'
export const CONTRACT_KEY_PATH = "m/8383h/1h/0h/0/0"
export const FAUCET_DRIP = '12986f202fbfb850f7699c5d5188f261f276de6c7038142f0a28bbb672b5af34'

const errText = (e) => (e && (e.message || (typeof e.toString === 'function' && e.toString()))) || String(e)

// ---------------------------------------------------------------------------
// The wallet's list of templates
// ---------------------------------------------------------------------------

// Templates the developer added by hand: { hash: { descriptor, sources } }.
export function trustedTemplates (store) {
  try { return JSON.parse(store.getItem(TRUSTED_KEY) || '{}') || {} } catch { return {} }
}

export function addTrusted (store, hash, descriptor, sources) {
  const t = trustedTemplates(store)
  t[hash] = { descriptor, sources }
  try { store.setItem(TRUSTED_KEY, JSON.stringify(t)) } catch {}
}

export function removeTrusted (store, hash) {
  const t = trustedTemplates(store)
  delete t[hash]
  try { store.setItem(TRUSTED_KEY, JSON.stringify(t)) } catch {}
}

// The hashes on this wallet's list: the kit's templates and those added by hand.
export function knownHashes (lwk, store) {
  const kit = JSON.parse(lwk.ContractTemplate.knownList()).map(k => k.hash)
  return [...new Set([...kit, ...Object.keys(trustedTemplates(store))])]
}

// A template by hash, from the kit or the wallet's own list.
export function templateByHash (lwk, store, hash) {
  const t = trustedTemplates(store)[hash]
  if (t) return new lwk.ContractTemplate(t.descriptor, JSON.stringify(t.sources))
  return lwk.ContractTemplate.known(hash)
}

// ---------------------------------------------------------------------------
// The chain and the registry
// ---------------------------------------------------------------------------

async function getJson (fetchFn, path) {
  const r = await fetchFn(path)
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return r.json()
}

async function getText (fetchFn, path) {
  const r = await fetchFn(path)
  if (!r.ok) throw new Error(`${path}: ${r.status}`)
  return (await r.text()).trim()
}

// What the engine needs to check a spend's locks: the tip, and when the coin's
// relative lock started (BIP68 counts from the median time past of the block before
// the coin's). `records` are the outpoints ([txid, vout]) whose chain record the
// engine checks a request against: the contract coin's and every foreign input's.
export async function chainFacts (esploraFetch, txid, records = []) {
  const tipHash = await getText(esploraFetch, '/blocks/tip/hash')
  const tip = await getJson(esploraFetch, `/block/${tipHash}`)
  const status = await getJson(esploraFetch, `/tx/${txid}/status`)
  const facts = { tip_height: tip.height, tip_median_time: tip.mediantime, coin_height: null, coin_start_median_time: null }
  if (status && status.confirmed) {
    facts.coin_height = status.block_height
    const before = await getText(esploraFetch, `/block-height/${status.block_height - 1}`)
    facts.coin_start_median_time = (await getJson(esploraFetch, `/block/${before}`)).mediantime
  }
  if (records.length) {
    facts.prevouts = {}
    for (const [t, v] of records) facts.prevouts[t + ':' + v] = await prevoutOf(esploraFetch, t, v)
  }
  return facts
}

// The chain's record of an output: its script, asset and amount, explicit.
export async function prevoutOf (esploraFetch, txid, vout) {
  const t = await getJson(esploraFetch, `/tx/${txid}`)
  const o = (t.vout || [])[vout]
  if (!o || o.value == null || !o.asset) throw new Error(`${txid}:${vout} is not an explicit output on the chain`)
  return { script_pubkey: o.scriptpubkey, asset: o.asset, amount: Number(o.value) }
}

// A request with this wallet's own coins added where the outputs pay more of an asset
// than the request's inputs hold, and the change of each back to `changeAddress`.
// Explicit coins only, largest first; a coin the request already names is not picked
// twice. The engine checks each one against the wallet's record again.
export function fundFromWallet (request, coins, changeAddress) {
  const r = JSON.parse(JSON.stringify(request))
  const inputs = r.inputs || [{ is: 'contract' }]
  const key = (c) => c.txid + ':' + c.vout
  const used = new Set(inputs.filter(i => i.is !== 'contract').map(key))
  const have = {}
  const add = (a, n) => { have[a] = (have[a] || 0n) + BigInt(n) }
  add(r.coin.asset, r.coin.amount)
  for (const i of inputs) if (i.is !== 'contract') add(i.asset, i.amount)
  const need = {}
  for (const o of r.outputs) need[o.asset] = (need[o.asset] || 0n) + BigInt(o.amount)
  for (const [asset, n] of Object.entries(need)) {
    const short = n - (have[asset] || 0n)
    if (short <= 0n) continue
    const pick = coins.filter(c => c.asset === asset && !c.confidential && !used.has(key(c))).sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0))
    let got = 0n
    for (const c of pick) {
      if (got >= short) break
      inputs.push({ is: 'wallet', txid: c.txid, vout: c.vout, asset, amount: c.amount })
      used.add(key(c)); got += BigInt(c.amount)
    }
    if (got < short) throw new Error(`this wallet holds too little of ${asset} in explicit coins: the spend needs ${short} more atoms and finds ${got}`)
    if (got > short) r.outputs.push({ to: 'wallet', address: changeAddress, asset, amount: Number(got - short) })
  }
  r.inputs = inputs
  return r
}

// The explicit coins an address holds: each as the engine takes it, and whether it
// is confirmed.
export async function contractCoins (esploraFetch, address, scriptPubkey) {
  const utxos = await getJson(esploraFetch, `/address/${address}/utxo`)
  return utxos
    .filter(u => u.value != null && u.asset)
    .map(u => ({ coin: { txid: u.txid, vout: u.vout, script_pubkey: scriptPubkey, asset: u.asset, amount: Number(u.value) }, confirmed: !!(u.status && u.status.confirmed) }))
}

// The registry's name for a template, looked up by the wallet itself: never taken
// from the site or the descriptor, which only claim one.
export async function registryName (registryFetch, hash) {
  if (!registryFetch) return null
  try {
    const idx = await getJson(registryFetch, '/contracts/index.minimal.json')
    for (const entries of Object.values(idx.leaves || {})) {
      for (const [h, name, version] of entries) if (h === hash) return { name, version }
    }
    for (const [h, name, version] of Object.values(idx.scripts || {})) if (h === hash) return { name, version }
  } catch {}
  return null
}

// ---------------------------------------------------------------------------
// Preparing a spend
// ---------------------------------------------------------------------------

// The engine's approval of a spend: build it, check the five points and the locks,
// run every program. With `fund`, this wallet adds its own coins for what the request's
// inputs do not cover. Throws the engine's refusal.
export async function prepare (ctx, { template, instanceJson, request, fund = false }) {
  const { lwk } = ctx
  const instance = new lwk.ContractInstance(template, instanceJson)
  const coins = ctx.walletCoins ? ctx.walletCoins() : []
  if (fund) request = fundFromWallet(request, coins, ctx.receiveAddress())
  const foreign = (request.inputs || []).filter(i => i.is === 'foreign')
  const records = request.inputs ? [[request.coin.txid, request.coin.vout], ...foreign.map(f => [f.txid, f.vout])] : []
  const facts = await chainFacts(ctx.esploraFetch, request.coin.txid, records)
  const spend = lwk.ContractSpend.build(instance, ctx.network(), JSON.stringify(request), JSON.stringify(ctx.walletScripts()), JSON.stringify(facts), JSON.stringify(coins))
  const assets = {}
  for (const o of [request.coin, ...(request.inputs || []).filter(i => i.asset), ...request.outputs]) {
    const m = ctx.assetMeta(o.asset)
    if (m && m.ticker) assets[o.asset] = { ticker: m.ticker, precision: m.precision || 0 }
  }
  const view = {
    known: knownHashes(lwk, ctx.store),
    registry: await registryName(ctx.registryFetch, template.hash()),
    assets,
    key_path: CONTRACT_KEY_PATH
  }
  const approval = lwk.ContractApproval.prepare(spend, ctx.signer(), JSON.stringify(view))
  return { approval, summary: JSON.parse(approval.summary()), request }
}

// A faucet drip, planned at its real size: the fee is `ratePerKvb` atoms of the
// dripped asset per 1,000 vB, measured on the final transaction.
export async function prepareDrip (ctx, { template, instanceJson, coin, to, amount, ratePerKvb }) {
  const instance = new ctx.lwk.ContractInstance(template, instanceJson)
  const feeFor = (vsize) => (BigInt(vsize) * BigInt(ratePerKvb) + 999n) / 1000n
  let fee = feeFor(600)
  for (let i = 0; i < 3; i++) {
    const request = JSON.parse(instance.planDrip(JSON.stringify(coin), to, BigInt(amount), fee))
    const p = await prepare(ctx, { template, instanceJson, request })
    const need = feeFor(p.summary.vsize)
    if (need === fee) return { ...p, request }
    fee = need
  }
  throw new Error('the drip\'s size did not settle')
}

// Signs exactly what was shown: `shown` is the summary that was rendered.
export function sign (ctx, approval, shown) {
  return ctx.signer().signContractSpend(approval, shown.digest)
}

export async function broadcast (ctx, hex) {
  const r = await ctx.esploraFetch('/tx', { method: 'POST', body: hex })
  const text = (await r.text()).trim()
  if (!r.ok) throw new Error('the node refused the transaction: ' + text)
  return text
}

// ---------------------------------------------------------------------------
// The approval, as a wallet shows it
// ---------------------------------------------------------------------------

// The approval in sections of [label, value] rows. The engine wrote every value;
// nothing here computes one.
export function approvalSections (s) {
  const sections = []
  sections.push({
    title: 'Template',
    rows: [
      ['Template', s.template.shown],
      ['What it is', s.template.summary],
      ...(s.template.registered ? [] : [['It names itself', s.template.names_itself + ' v' + s.template.version + ' (not checked by any registry)']]),
      ['Template hash', s.template.hash]
    ]
  })
  sections.push({
    title: 'Path',
    rows: [
      ['Path', s.path.name + ' (' + s.path.kind + ' leaf ' + s.path.leaf + ')'],
      ['Who can take it', s.path.who],
      ['What it does', s.path.effect]
    ]
  })
  sections.push({ title: 'Parameters', rows: s.params.map(p => [p.label + ' [' + p.role + ']', p.shown]) })
  if (s.slots && s.slots.length) sections.push({ title: 'State', rows: s.slots.map(p => [p.label + ' [' + p.role + ']', p.shown]) })
  if (s.spender && s.spender.length) sections.push({ title: 'Values the spender chose', rows: s.spender.map(v => [v.name, v.value]) })
  if (s.inputs && s.inputs.length) {
    sections.push({
      title: 'What it spends',
      rows: s.inputs.flatMap(i => [
        ['Input ' + i.index, i.shown],
        ...(i.request_says ? [['Input ' + i.index + ', as the request calls it', i.request_says + ' (the request\'s word, not checked)']] : []),
        ...(i.is === 'foreign' ? [['Input ' + i.index + ', checked against the chain', i.checked_against_chain ? 'yes: the chain\'s record of the coin is what the request says' : 'no']] : [])
      ])
    })
  }
  sections.push({ title: 'Your balance change', rows: s.wallet_change.map(c => ['This wallet', c.shown]) })
  for (const o of (s.opens || [])) {
    sections.push({
      title: 'Output ' + o.index + ' opens a contract',
      rows: [['Opens', o.shown], ['What it is', o.summary], ['Template hash', o.template_hash],
        ...o.params.map(p => [p.label + ' [' + p.role + ']', p.shown]),
        ...(o.slots || []).map(p => [p.label + ' [' + p.role + ']', p.shown])]
    })
  }
  sections.push({
    title: 'Where the coins go',
    rows: [
      ...s.contract.change.map(c => ['The contract', c.shown]),
      ...s.payments.map(p => ['Pays output ' + p.index, p.shown + ' to script ' + p.script_pubkey]),
      ...s.fee.map(f => ['Network fee', f.shown + ' (' + s.vsize + ' vB)'])
    ]
  })
  sections.push({
    title: 'Checked before signing',
    rows: [
      ['1. Known template', s.checks['1_known_template']],
      ['2. Output recomputed', s.checks['2_output_recomputed']],
      ['3. Program run', s.checks['3_program_run']],
      ['4. Shown', 'this screen; it signs digest ' + s.digest],
      ['5. Contract key', s.checks['5_contract_key']],
      ...(s.path.selected_by ? [['Path chosen by', s.path.selected_by]] : []),
      ...(s.locks ? [['Locks', s.locks]] : []),
      ['Input sequence', s.sequence],
      ['Coin', s.contract.coin]
    ]
  })
  return sections
}

// ---------------------------------------------------------------------------
// The tab
// ---------------------------------------------------------------------------

export function mountContracts (ctx, root) {
  const { lwk, el } = ctx
  const state = { template: null, instanceJson: null, instance: null, coins: [], pending: null }
  root.textContent = ''
  const box = (title) => { const s = el('div', 'card'); s.appendChild(el('h3', '', title)); root.appendChild(s); return s }
  const field = (parent, label, node) => { const w = el('label', 'field', label); w.appendChild(node); parent.appendChild(w); return node }
  const input = (id, value = '') => { const i = el('input'); i.id = id; i.value = value; return i }
  const area = (id, rows = 4) => { const t = el('textarea'); t.id = id; t.rows = rows; t.spellcheck = false; return t }
  const button = (id, text, fn) => { const b = el('button', '', text); b.id = id; b.onclick = () => run(b, fn); return b }
  const out = (id) => { const d = el('div', 'contract-out'); d.id = id; return d }
  const fail = el('div', 'status err'); fail.id = 'contractError'
  async function run (b, fn) {
    fail.textContent = ''
    b.disabled = true
    try { await fn() } catch (e) { fail.textContent = errText(e) } finally { b.disabled = false }
  }

  // Template
  const t = box('Template')
  const pick = el('select'); pick.id = 'contractTemplate'
  const fillPick = () => {
    pick.textContent = ''
    const kit = JSON.parse(lwk.ContractTemplate.knownList())
    for (const k of kit) { const o = el('option', '', `${k.name} v${k.version} (carried by the kit)`); o.value = k.hash; pick.appendChild(o) }
    for (const [h, v] of Object.entries(trustedTemplates(ctx.store))) {
      let name = h.slice(0, 12) + '…'
      try { name = JSON.parse(v.descriptor).template.name } catch {}
      const o = el('option', '', `${name} (added by hand)`); o.value = h; pick.appendChild(o)
    }
  }
  fillPick()
  field(t, 'A template on this wallet\'s list', pick)
  const tplOut = out('contractTemplateOut')
  t.appendChild(button('contractUseTemplate', 'Use this template', async () => {
    state.template = templateByHash(lwk, ctx.store, pick.value)
    showTemplate()
  }))
  const pasteD = area('contractDescriptor', 6); const pasteS = area('contractSources', 4)
  field(t, 'Or paste a descriptor (descriptor.json)', pasteD)
  field(t, 'and its sources, includes resolved: {"<name>.simf": "<text>"}', pasteS)
  t.appendChild(button('contractAddTemplate', 'Check it and add it to this wallet\'s list', async () => {
    const tpl = new lwk.ContractTemplate(pasteD.value, pasteS.value || '{}')
    addTrusted(ctx.store, tpl.hash(), pasteD.value, JSON.parse(pasteS.value || '{}'))
    fillPick(); pick.value = tpl.hash()
    state.template = tpl
    showTemplate()
  }))
  t.appendChild(tplOut)
  function showTemplate () {
    const d = JSON.parse(state.template.describe())
    tplOut.textContent = ''
    tplOut.appendChild(el('div', '', `${d.name} v${d.version}: ${d.summary}`))
    tplOut.appendChild(el('div', 'mono', 'template hash ' + d.hash))
    for (const p of d.paths) tplOut.appendChild(el('div', '', `path ${p.name} (${p.kind}): ${p.who}. ${p.effect}`))
    tplOut.appendChild(el('div', '', 'Parameters: ' + d.params.map(p => `${p.name} (${p.type}, ${p.role})`).join(', ')))
    tplOut.appendChild(el('div', 'mono', 'This wallet\'s contract key (' + CONTRACT_KEY_PATH + '): ' + ctx.signer().xonlyPublicKeyAt(CONTRACT_KEY_PATH)))
  }

  // Instance
  const i = box('Instance')
  const inst = area('contractInstance', 6)
  field(i, 'The instance: {"instance": 2, "template_hash", "params", "slots", "genesis"}', inst)
  const instOut = out('contractInstanceOut')
  i.appendChild(button('contractRecompute', 'Recompute its address', async () => {
    if (!state.template) throw new Error('choose a template first')
    state.instanceJson = inst.value
    state.instance = new lwk.ContractInstance(state.template, inst.value)
    instOut.textContent = ''
    instOut.appendChild(el('div', 'mono', 'address ' + state.instance.address(ctx.network())))
    instOut.appendChild(el('div', 'mono', 'script ' + state.instance.scriptPubkey()))
    pathPick.textContent = ''
    for (const p of JSON.parse(state.instance.paths())) { const o = el('option', '', `${p.name} (${p.kind})`); o.value = p.name; pathPick.appendChild(o) }
    showSpendForm()
  }))
  i.appendChild(instOut)

  // Coin and path
  const c = box('Coin and path')
  const coinPick = el('select'); coinPick.id = 'contractCoin'
  c.appendChild(button('contractFindCoins', 'Find the coins it holds', async () => {
    if (!state.instance) throw new Error('recompute an instance first')
    state.coins = await contractCoins(ctx.esploraFetch, state.instance.address(ctx.network()), state.instance.scriptPubkey())
    coinPick.textContent = ''
    for (const [n, { coin: k, confirmed }] of state.coins.entries()) {
      const m = ctx.assetMeta(k.asset)
      const o = el('option', '', `${k.txid.slice(0, 16)}…:${k.vout} ${k.amount} atoms of ${(m && m.ticker) || k.asset.slice(0, 8)}${confirmed ? '' : ' (unconfirmed)'}`)
      o.value = String(n); coinPick.appendChild(o)
    }
    if (!state.coins.length) throw new Error('no explicit coin at this address')
  }))
  field(c, 'Coin', coinPick)
  const pathPick = el('select'); pathPick.id = 'contractPath'
  pathPick.onchange = () => showSpendForm()
  field(c, 'Path', pathPick)

  // The spend
  const s = box('Spend')
  const dripTo = input('contractDripTo'); const dripAmount = input('contractDripAmount'); const dripRate = input('contractDripRate', '1000')
  const dripForm = el('div'); dripForm.id = 'contractDripForm'
  field(dripForm, 'Pay to (an address; this wallet\'s by default)', dripTo)
  field(dripForm, 'Amount (atoms of the dripped asset)', dripAmount)
  field(dripForm, 'Fee rate (atoms of the dripped asset per 1,000 vB)', dripRate)
  const reqForm = el('div'); reqForm.id = 'contractRequestForm'
  const reqText = area('contractRequest', 8)
  field(reqForm, 'The request: {"path", "coin", "inputs"?: [{"is": "contract"}, {"is": "wallet", ...}, {"is": "foreign", ..., "witness"}], "outputs": [{"to": "contract|wallet|pay|fee|open|foreign", "address"|"script", "asset", "amount"}], "spender", "next_slots", ...}', reqText)
  const fundBox = el('input'); fundBox.type = 'checkbox'; fundBox.id = 'contractFund'
  const fundLabel = el('label', 'field', ' Fund it from this wallet: add this wallet\'s coins for what the inputs do not cover, and the change'); fundLabel.prepend(fundBox)
  reqForm.appendChild(fundLabel)
  const byHand = el('input'); byHand.type = 'checkbox'; byHand.id = 'contractByHand'
  byHand.onchange = () => showSpendForm()
  const byHandLabel = el('label', 'field', ' Write the request by hand'); byHandLabel.prepend(byHand)
  s.appendChild(byHandLabel)
  s.appendChild(dripForm); s.appendChild(reqForm)
  function showSpendForm () {
    const drip = state.template && state.template.hash() === FAUCET_DRIP && pathPick.value === 'drip' && !byHand.checked
    dripForm.classList.toggle('hide', !drip)
    reqForm.classList.toggle('hide', !!drip)
    if (drip && !dripTo.value) { try { dripTo.value = ctx.receiveAddress() } catch {} }
  }
  s.appendChild(button('contractReview', 'Review', async () => {
    if (!state.instance) throw new Error('recompute an instance first')
    const coin = (state.coins[Number(coinPick.value)] || {}).coin
    let p
    if (!dripForm.classList.contains('hide')) {
      if (!coin) throw new Error('find the coins and choose one')
      p = await prepareDrip(ctx, { template: state.template, instanceJson: state.instanceJson, coin, to: dripTo.value.trim(), amount: dripAmount.value.trim(), ratePerKvb: dripRate.value.trim() })
    } else {
      const request = JSON.parse(reqText.value)
      if (coin && !request.coin) request.coin = coin
      if (!request.path) request.path = pathPick.value
      p = await prepare(ctx, { template: state.template, instanceJson: state.instanceJson, request, fund: fundBox.checked })
    }
    renderApproval(p)
  }))
  root.appendChild(fail)

  // The approval screen
  const a = el('div', 'card hide'); a.id = 'contractApproval'
  root.appendChild(a)
  const done = out('contractDone'); root.appendChild(done)
  function renderApproval (p) {
    state.pending = p
    a.textContent = ''
    a.classList.remove('hide')
    a.appendChild(el('h3', '', 'Sign this contract spend?'))
    for (const sec of approvalSections(p.summary)) {
      a.appendChild(el('h4', '', sec.title))
      for (const [k, v] of sec.rows) {
        const row = el('div', 'kv'); row.appendChild(el('span', 'k', k)); row.appendChild(el('span', 'v', String(v))); a.appendChild(row)
      }
    }
    const go = button('contractSign', 'Sign and broadcast', async () => {
      const shown = state.pending.summary
      const hex = sign(ctx, state.pending.approval, shown)
      const txid = await broadcast(ctx, hex)
      done.textContent = 'Broadcast ' + txid
      a.classList.add('hide')
      state.pending = null
    })
    const no = button('contractCancel', 'Cancel', async () => { a.classList.add('hide'); state.pending = null })
    a.appendChild(go); a.appendChild(no)
  }
  showSpendForm()
  return { state, renderApproval }
}
