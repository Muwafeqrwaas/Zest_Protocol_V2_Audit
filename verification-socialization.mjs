// ============================================================================
// ADVERSARIAL PROBE SUITE against the PORTED MAINNET market (market-v8)
// Covers post-audit NEW code: liquidation rewrite, bad-debt socialization,
// liquidate-multi-with-feeds batch semantics.
// ============================================================================
import { initSimnet } from "@stacks/clarinet-sdk";
import { Cl } from "@stacks/transactions";
import * as secp from "@noble/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha256";
import process from "process";

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
process.chdir("/home/z/my-project/audit/zest-v2/zest-v2-contracts-main/local-testing");
const simnet = await initSimnet("Clarinet.toml");

const deployer = simnet.deployer;
const A = (n) => simnet.getAccounts().get(n);
const [alice, bob, charlie, dave, erin] = ["wallet_1", "wallet_2", "wallet_3", "wallet_4", "wallet_5"].map(A);

// ---------------- Lazer builder (mainnet-compatible: mandatory conf + feed-ts) ----------
const PRIVKEY = new Uint8Array(Buffer.from("a1a2a3a4a5a6a7a8b1b2b3b4b5b6b7b8c1c2c3c4c5c6c7c8d1d2d3d4d5d6d7d8", "hex"));
const uToBE = (v, n) => Buffer.from(v.toString(16).padStart(n * 2, "0"), "hex");
const iToBE = (v, n) => (v >= 0n ? uToBE(v, n) : uToBE((1n << BigInt(n * 8)) + v, n));
const u8b = (n) => Buffer.from([n & 0xff]);

function encodeFeed(feedId, price, expo, tsMicros, pubCount = 5, conf = 1n) {
  const props = [
    Buffer.concat([u8b(0), iToBE(price, 8)]),           // price
    Buffer.concat([u8b(4), iToBE(BigInt(expo), 2)]),    // exponent
    Buffer.concat([u8b(3), uToBE(BigInt(pubCount), 2)]),// publisher-count
    Buffer.concat([u8b(5), uToBE(conf, 8)]),            // confidence (mandatory on mainnet)
    Buffer.concat([u8b(12), u8b(1), uToBE(tsMicros, 8)]), // feed-update-timestamp (mandatory)
  ];
  return Buffer.concat([uToBE(BigInt(feedId), 4), u8b(props.length), Buffer.concat(props)]);
}

const blockTime = () => {
  const res = simnet.runSnippet("stacks-block-time");
  return BigInt("0x" + (typeof res === "string" ? res : res.result).replace(/^0x/, "").slice(-32));
};
let lastM = 0n;
const btMicros = () => {
  let m = blockTime() * 1_000_000n;
  if (m <= lastM) m = lastM + 1n;
  lastM = m;
  return m;
};

function buildUpdate(feeds, tsMicros, channel = 3) {
  const payload = Buffer.concat([
    uToBE(0x93c7d375n, 4), uToBE(tsMicros, 8), u8b(channel), u8b(feeds.length), ...feeds,
  ]);
  const sig = secp.sign(keccak_256(payload), PRIVKEY);
  return Buffer.concat([
    uToBE(0x2a22999an, 4), uToBE(sig.r, 32), uToBE(sig.s, 32), u8b(sig.recovery),
    uToBE(BigInt(payload.length), 2), payload,
  ]);
}

// price spec: BTC, USDC, STX in human USD
function pf(btc, usdc = 1, stx = 1) {
  const ts = btMicros();
  const feeds = [
    encodeFeed(1, BigInt(Math.round(btc * 1e8)), -8, ts),
    encodeFeed(5, BigInt(Math.round(usdc * 1e8)), -8, ts),
    encodeFeed(3, BigInt(Math.round(stx * 1e8)), -8, ts),
  ];
  return Cl.some(Cl.list([Cl.buffer(buildUpdate(feeds, ts))]));
}

// raw feed buffer for liquidate-multi-with-feeds (takes ONE buff, not a list)
function pfBuff(btc, usdc = 1, stx = 1) {
  const ts = btMicros();
  const feeds = [
    encodeFeed(1, BigInt(Math.round(btc * 1e8)), -8, ts),
    encodeFeed(5, BigInt(Math.round(usdc * 1e8)), -8, ts),
    encodeFeed(3, BigInt(Math.round(stx * 1e8)), -8, ts),
  ];
  return Cl.buffer(buildUpdate(feeds, ts));
}

// ---------------- infra ----------------
const P = (name, fn, args, who) => {
  try { return simnet.callPublicFn(name, fn, args, who || deployer); }
  catch (e) { return { result: { type: "err", value: "RUNTIME: " + String(e.message).slice(0, 160) }, events: [] }; }
};
const R = (name, fn, args) => simnet.callReadOnlyFn(name, fn, args, deployer);
const u = (v) => Cl.uint(v);
const cp = (n) => Cl.contractPrincipal(deployer, n);
const show = (r, label) => {
  const okv = r.result.type === "ok";
  console.log(`  ${label}: ${okv ? "ok " + JSON.stringify(r.result.value).slice(0, 90) : "ERR " + JSON.stringify(r.result.value)}`);
  return r;
};
const sbtc = cp("sbtc"), usdc = cp("usdc"), wstx = cp("wstx");

function daoExecute(name) {
  const p = P("dao-multisig", "propose", [cp(name), Cl.bool(true)]);
  const id = p.result.value.value;
  return P("dao-multisig", "execute", [u(id), cp(name)]);
}

// ---------------- init ----------------
P("dao-multisig", "init", [Cl.list([Cl.principal(deployer)]), u(1)]);
P("dao-executor", "init", [cp("dao-multisig")]);
daoExecute("proposal-init-assets");
for (const [tok, amt] of [["sbtc", 1000n], ["usdh", 1000n], ["usdc", 1000n], ["ststx", 1000n]]) {
  P(tok, "mint", [u(amt), cp("proposal-init-vaults")]);
}
P("wstx", "transfer", [u(1000n), Cl.principal(deployer), cp("proposal-init-vaults"), Cl.none()]);
daoExecute("proposal-init-vaults");
daoExecute("proposal-init-market-vault");
daoExecute("proposal-create-multiple-egroups");
const advEg = daoExecute("proposal-egroup-adversarial");
console.log("adversarial egroup proposal:", advEg.result.type === "ok" ? "OK" : JSON.stringify(advEg.result).slice(0,200));
const pub = Buffer.from(secp.getPublicKey(PRIVKEY, true));
P("pyth-lazer-oracle", "set-trusted-signers",
  [Cl.list([Cl.tuple({ pubkey: Cl.buffer(pub), "expires-at": Cl.uint(100_000_000_000n) })])]);
daoExecute("proposal-lazer-repoint");
daoExecute("proposal-switch-market-v8");
console.log("=== INIT DONE (market-v8 = ported mainnet v0-8-market) ===\n");

// liquidity providers
P("usdc", "mint", [u(1_000_000_000_000n), Cl.principal(bob)]); // $1M USDC
P("vault-usdc", "deposit", [u(1_000_000_000_000n), u(0), Cl.principal(bob)], bob);
const bd = P("vault-stx", "deposit", [u(9_000_000_000_000n), u(0), Cl.principal(bob)], bob); // 9M STX
console.log("bob vault-stx deposit:", bd.result.type === "ok" ? "ok" : JSON.stringify(bd.result).slice(0, 150));
P("sbtc", "mint", [u(10_000_000_000n), Cl.principal(erin)]); // erin LPs sBTC too
P("usdc", "mint", [u(500_000_000_000n), Cl.principal(charlie)]); // charlie liquidator funds

// state getters
const pos = (who) => R("market-vault", "resolve", [Cl.principal(who)]).result;
const debtOf = (who, aid) => R("market-vault", "get-account-scaled-debt", [Cl.principal(who), u(aid)]).result.value;
const rv = (v, f) => { const r = R(v, f, []).result; const inner = (r.type === "ok" || r.type === "response") ? r.value : r; return inner.type === "uint" ? BigInt(inner.value) : inner; };
const vaultState = (v) => ({
  assets: rv(v, "get-assets"),
  debt: rv(v, "get-debt"),
  principalScaled: rv(v, "get-principal-scaled"),
  index: rv(v, "get-index"),
  lindex: rv(v, "get-liquidity-index"),
});
const fmt = (v) => (typeof v === "bigint" ? v.toString() : JSON.stringify(v));
const showVault = (v, label) => {
  const s = vaultState(v);
  console.log(`  ${label}: assets=${fmt(s.assets)} debt=${fmt(s.debt)} principal-scaled=${fmt(s.principalScaled)} index=${fmt(s.index)} lindex=${fmt(s.lindex)}`);
};

// ============================================================================
// SCENARIO 2: MULTI-DEBT SOCIALIZATION on mainnet code
// dave: 1 sBTC collateral; debts: 39000 USDC + 1000 STX; crash BTC to $10k;
// liquidate via USDC -> all collateral seized, remaining debts socialized.
// ============================================================================
console.log("=== SCENARIO 2: multi-debt bad-debt socialization ===");
P("sbtc", "mint", [u(100_000_000n), Cl.principal(dave)]);
show(P("market-v8", "collateral-add", [sbtc, u(100_000_000n), pf(60000)], dave), "dave collateral-add 1 sBTC");
show(P("market-v8", "borrow", [usdc, u(15_000_000_000n), Cl.none(), pf(60000)], dave), "dave borrow 15000 USDC");
show(P("market-v8", "borrow", [wstx, u(6_000_000_000n), Cl.none(), pf(60000)], dave), "dave borrow 6000 STX");

showVault("vault-usdc", "vault-usdc BEFORE");
showVault("vault-stx", "vault-stx BEFORE");
console.log("  dave USDC scaled-debt:", fmt(debtOf(dave, 6)));
console.log("  dave STX scaled-debt:", fmt(debtOf(dave, 0)));

// crash BTC price to $10k -> LTV 400%
P("sbtc", "mint", [u(100_000_000n), Cl.principal(charlie)]);
console.log("\n-- crash BTC to $3k, liquidate via USDC (charlie) --");
const liq = P("market-v8", "liquidate",
  [Cl.principal(dave), sbtc, usdc, u(50_000_000_000n), u(0), Cl.none(), pf(3000)], charlie);
console.log("  liquidate dave full result:", JSON.stringify(liq.result).slice(0, 220));
const lge = liq.events.filter(ev => JSON.stringify(ev).includes("liquidate") || JSON.stringify(ev).includes("socialized"));
for (const ev of lge) console.log("  EV:", JSON.stringify(ev.data || ev).slice(0, 400));

const charlieSbtc = R("sbtc", "get-balance", [Cl.principal(charlie)]).result.value;
console.log("  charlie sBTC balance after:", fmt(charlieSbtc), "(expected ~1 BTC seized)");
console.log("  dave USDC scaled-debt after:", fmt(debtOf(dave, 6)));
console.log("  dave STX scaled-debt after:", fmt(debtOf(dave, 0)));

showVault("vault-usdc", "vault-usdc AFTER");
showVault("vault-stx", "vault-stx AFTER");

// C-2 invariant check: debt >= total-borrowed? (read total-borrowed via prints - use assets/debt math)
// total-borrowed = assets - available... use get-available-assets + get-assets + get-debt:
for (const v of ["vault-usdc", "vault-stx", "vault-sbtc"]) {
  const assets = rv(v, "get-assets");
  const debt = rv(v, "get-debt");
  const avail = rv(v, "get-available-assets");
  const borrowed = assets - avail; // assets - available = total-borrowed
  console.log(`  ${v}: assets=${fmt(assets)} debt=${fmt(debt)} total-borrowed=${fmt(borrowed)} debt>=borrowed: ${debt >= borrowed}`);
}

// post-socialization functionality: erin borrows STX and repays (accrue + repay path)
console.log("\n-- post-socialization vault-stx functionality --");
show(P("market-v8", "collateral-add", [sbtc, u(100_000_000n), pf(10000)], erin), "erin collateral-add");
show(P("market-v8", "borrow", [wstx, u(100_000_000n), Cl.none(), pf(10000)], erin), "erin borrow 100 STX");
P("wstx", "transfer", [u(100_000_000n), Cl.principal(erin), Cl.principal(erin), Cl.none()], erin);
show(P("market-v8", "repay", [wstx, u(100_000_000n), Cl.none()], erin), "erin repay 100 STX");

// ============================================================================
// SCENARIO 3: liquidate-multi-with-feeds ALL-OR-REVERT regression
// alice: liquidatable; frank: healthy. Batch [alice, frank] should revert whole tx.
// ============================================================================
console.log("\n=== SCENARIO 3: liquidate-multi-with-feeds batch semantics ===");
const frank = A("wallet_6");
P("sbtc", "mint", [u(100_000_000n), Cl.principal(alice)]);
P("market-v8", "collateral-add", [sbtc, u(100_000_000n), pf(60000)], alice);
P("market-v8", "borrow", [usdc, u(42_000_000_000n), Cl.none(), pf(60000)], alice);
P("sbtc", "mint", [u(100_000_000n), Cl.principal(frank)]);
P("market-v8", "collateral-add", [sbtc, u(100_000_000n), pf(60000)], frank);
const fr = P("market-v8", "borrow", [usdc, u(500_000_000n), Cl.none(), pf(60000)], frank);
console.log("  frank borrow 500 USDC:", fr.result.type === "ok" ? "ok" : JSON.stringify(fr.result).slice(0,120)); // frank stays healthy

console.log("  alice USDC debt before:", fmt(debtOf(alice, 6)));

// batch: [alice (liquidatable after crash), frank (healthy)]
const batch = P("market-v8", "liquidate-multi-with-feeds", [
  Cl.list([
    Cl.tuple({ borrower: Cl.principal(alice), "collateral-ft": sbtc, "debt-ft": usdc, "debt-amount": u(50_000_000_000n), "min-collateral-expected": u(0) }),
    Cl.tuple({ borrower: Cl.principal(frank), "collateral-ft": sbtc, "debt-ft": usdc, "debt-amount": u(50_000_000_000n), "min-collateral-expected": u(0) }),
  ]),
  pfBuff(3000),
], charlie);
console.log("  batch FULL result:", JSON.stringify(batch.result, null, 1).slice(0, 1500));
console.log("  batch events count:", batch.events.length);
const badDebt = batch.events.filter(ev => JSON.stringify(ev).includes("bad-debt"));
console.log("  batch bad-debt-socialized events:", badDebt.length);

const aliceDebtAfterBatch = debtOf(alice, 6);
console.log("  alice USDC debt after batch:", fmt(aliceDebtAfterBatch));

// now individual liquidation of alice works
const liq2 = P("market-v8", "liquidate",
  [Cl.principal(alice), sbtc, usdc, u(50_000_000_000n), u(0), Cl.none(), pf(3000)], charlie);
show(liq2, "individual liquidate alice");

// reverse order: [frank(healthy), alice] - fails at FIRST element
const batch2 = P("market-v8", "liquidate-multi-with-feeds", [
  Cl.list([
    Cl.tuple({ borrower: Cl.principal(frank), "collateral-ft": sbtc, "debt-ft": usdc, "debt-amount": u(50_000_000_000n), "min-collateral-expected": u(0) }),
  ]),
  pfBuff(3000),
], charlie);
show(batch2, "batch [frank(healthy)] alone");
