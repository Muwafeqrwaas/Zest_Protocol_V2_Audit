// ============================================================================
// PROBE 3: zToken collateral loop on ported MAINNET market
// supply-collateral-add -> borrow -> interest accrual -> crash -> liquidate-redeem
// Verifies dual-mode consistency: lindex-based collateral valuation vs actual
// zsBTC redemption value (ta/ts) — hunting for value drift.
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
const [alice, bob, charlie, erin] = ["wallet_1", "wallet_2", "wallet_3", "wallet_5"].map(A);

const PRIVKEY = new Uint8Array(Buffer.from("a1a2a3a4a5a6a7a8b1b2b3b4b5b6b7b8c1c2c3c4c5c6c7c8d1d2d3d4d5d6d7d8", "hex"));
const uToBE = (v, n) => Buffer.from(v.toString(16).padStart(n * 2, "0"), "hex");
const iToBE = (v, n) => (v >= 0n ? uToBE(v, n) : uToBE((1n << BigInt(n * 8)) + v, n));
const u8b = (n) => Buffer.from([n & 0xff]);
function encodeFeed(feedId, price, expo, tsMicros, pubCount = 5, conf = 1n) {
  const props = [
    Buffer.concat([u8b(0), iToBE(price, 8)]),
    Buffer.concat([u8b(4), iToBE(BigInt(expo), 2)]),
    Buffer.concat([u8b(3), uToBE(BigInt(pubCount), 2)]),
    Buffer.concat([u8b(5), uToBE(conf, 8)]),
    Buffer.concat([u8b(12), u8b(1), uToBE(tsMicros, 8)]),
  ];
  return Buffer.concat([uToBE(BigInt(feedId), 4), u8b(props.length), Buffer.concat(props)]);
}
const blockTime = () => BigInt("0x" + simnet.runSnippet("stacks-block-time").replace(/^0x/, "").slice(-32));
let lastM = 0n;
const btMicros = () => { let m = blockTime() * 1_000_000n; if (m <= lastM) m = lastM + 1n; lastM = m; return m; };
function buildUpdate(feeds, tsMicros, channel = 3) {
  const payload = Buffer.concat([uToBE(0x93c7d375n, 4), uToBE(tsMicros, 8), u8b(channel), u8b(feeds.length), ...feeds]);
  const sig = secp.sign(keccak_256(payload), PRIVKEY);
  return Buffer.concat([uToBE(0x2a22999an, 4), uToBE(sig.r, 32), uToBE(sig.s, 32), u8b(sig.recovery), uToBE(BigInt(payload.length), 2), payload]);
}
function pf(btc, usdc = 1) {
  const ts = btMicros();
  return Cl.some(Cl.list([Cl.buffer(buildUpdate([
    encodeFeed(1, BigInt(Math.round(btc * 1e8)), -8, ts),
    encodeFeed(5, BigInt(Math.round(usdc * 1e8)), -8, ts),
  ], ts))]));
}

const P = (name, fn, args, who) => {
  try { return simnet.callPublicFn(name, fn, args, who || deployer); }
  catch (e) { return { result: { type: "err", value: "RUNTIME: " + String(e.message).slice(0, 140) }, events: [] }; }
};
const R = (name, fn, args) => simnet.callReadOnlyFn(name, fn, args, deployer);
const u = (v) => Cl.uint(v);
const cp = (n) => Cl.contractPrincipal(deployer, n);
const show = (r, label) => {
  console.log(`  ${label}: ${r.result.type === "ok" ? "ok " + JSON.stringify(r.result.value).slice(0, 80) : "ERR " + JSON.stringify(r.result.value).slice(0, 100)}`);
  return r;
};
const rv = (v, f) => { const r = R(v, f, []).result; const inner = (r.type === "ok" || r.type === "response") ? r.value : r; return inner.type === "uint" ? BigInt(inner.value) : inner; };
function daoExecute(name) {
  const p = P("dao-multisig", "propose", [cp(name), Cl.bool(true)]);
  const id = p.result.value.value;
  return P("dao-multisig", "execute", [u(id), cp(name)]);
}

// init
P("dao-multisig", "init", [Cl.list([Cl.principal(deployer)]), u(1)]);
P("dao-executor", "init", [cp("dao-multisig")]);
daoExecute("proposal-init-assets");
for (const [tok, amt] of [["sbtc", 1000n], ["usdh", 1000n], ["usdc", 1000n], ["ststx", 1000n]]) P(tok, "mint", [u(amt), cp("proposal-init-vaults")]);
P("wstx", "transfer", [u(1000n), Cl.principal(deployer), cp("proposal-init-vaults"), Cl.none()]);
daoExecute("proposal-init-vaults");
daoExecute("proposal-init-market-vault");
daoExecute("proposal-create-multiple-egroups");
daoExecute("proposal-egroup-adversarial");
const pub = Buffer.from(secp.getPublicKey(PRIVKEY, true));
P("pyth-lazer-oracle", "set-trusted-signers", [Cl.list([Cl.tuple({ pubkey: Cl.buffer(pub), "expires-at": Cl.uint(100_000_000_000n) })])]);
daoExecute("proposal-lazer-repoint");
daoExecute("proposal-switch-market-v8");
daoExecute("proposal-set-sbtc-interest-rates");
daoExecute("proposal-set-usdc-interest-rates");
// set interesting interest rates on vault-sbtc (utilization curve): via proposal? use default 0 first.
console.log("=== INIT DONE ===\n");

const sbtc = cp("sbtc"), usdc = cp("usdc"), vaultSbtc = cp("vault-sbtc");

// 1. erin LPs 100 sBTC into vault-sbtc (mints zsBTC), bob LPs USDC
P("sbtc", "mint", [u(100_000_000_000n), Cl.principal(erin)]); // 1000 sBTC... wait 1e11 = 1000 BTC. Use 100 BTC:
P("sbtc", "mint", [u(100_000_000n), Cl.principal(alice)]); // alice gets 1 sBTC
console.log("erin LP deposit 100 sBTC:");
show(P("vault-sbtc", "deposit", [u(10_000_000_000n), u(0), Cl.principal(erin)], erin), "erin deposit 100 sBTC");
P("usdc", "mint", [u(1_000_000_000_000n), Cl.principal(bob)]);
P("vault-usdc", "deposit", [u(1_000_000_000_000n), u(0), Cl.principal(bob)], bob);
P("usdc", "mint", [u(500_000_000_000n), Cl.principal(charlie)]);

// 2. create utilization in vault-sbtc: frank borrows 50 sBTC against USDC collateral
const frank = A("wallet_6");
P("usdc", "mint", [u(200_000_000_000n), Cl.principal(frank)]);
show(P("market-v8", "collateral-add", [usdc, u(100_000_000_000n), pf(60000)], frank), "frank collateral-add 100k USDC");
show(P("market-v8", "borrow", [sbtc, u(60_000_000n), Cl.none(), pf(60000)], frank), "frank borrow 0.6 sBTC (util ~6%)");

// 3. alice supply-collateral-add 1 sBTC -> zsBTC collateral, borrows USDC (egroup zsBTC+USDC ltv 60%)
console.log("\nalice zToken loop:");
show(P("market-v8", "supply-collateral-add", [sbtc, u(100_000_000n), u(0), pf(60000)], alice), "alice supply-collateral-add 1 sBTC");
const aliceZ = R("vault-sbtc", "get-balance", [Cl.principal(alice)]).result;
console.log("  alice zsBTC balance:", JSON.stringify(aliceZ.value ?? aliceZ));
show(P("market-v8", "borrow", [usdc, u(30_000_000_000n), Cl.none(), pf(60000)], alice), "alice borrow 30000 USDC");

// 4. accrue interest: mine ~200 blocks (block-time advances)
simnet.mineEmptyBlocks(200);
console.log("\nmined 200 blocks; vault-sbtc state:");
console.log("  vault-sbtc index:", rv("vault-sbtc", "get-index").toString(), "lindex:", rv("vault-sbtc", "get-liquidity-index").toString());
console.log("  vault-sbtc debt:", rv("vault-sbtc", "get-debt").toString(), "assets:", rv("vault-sbtc", "get-assets").toString());

// 5. crash BTC to $30k: alice coll = 1 zsBTC (~1 sBTC x lindex) ~ $30k+, debt 30000+interest -> liquidatable
console.log("\ncrash BTC to $30k and liquidate-redeem alice (zsBTC collateral):");
const liq = P("market-v8", "liquidate-redeem",
  [Cl.principal(alice), vaultSbtc, usdc, u(50_000_000_000n), u(0), u(0), Cl.none(), pf(30000)], charlie);
show(liq, "liquidate-redeem alice");

// 6. verify what charlie got
const charlieSbtc = R("sbtc", "get-balance", [Cl.principal(charlie)]).result;
console.log("  charlie sBTC after:", JSON.stringify(charlieSbtc.value ?? charlieSbtc));
try { const aliceDebt = R("market-vault", "get-account-scaled-debt", [Cl.principal(alice), u(6)]).result; console.log("  alice USDC scaled-debt after:", JSON.stringify(aliceDebt.value ?? aliceDebt)); } catch (e) { console.log("  alice USDC scaled-debt read: PANIC (untracked)"); }

// 7. CONSISTENCY CHECK: zsBTC redeem value vs lindex at liquidation time
// what the liquidation CREDITED per zsBTC: p(BTC) * lindex / 1e12
// what redemption actually gives: convert-to-assets(1 zsBTC) = ta/ts
const ta = R("vault-sbtc", "get-total-assets", []).result;
const ts = R("vault-sbtc", "get-total-supply", []).result;
const lidx = rv("vault-sbtc", "get-liquidity-index");
console.log("\n  === dual-mode consistency ===");
console.log("  vault-sbtc total-assets (preview):", JSON.stringify(ta.value ?? ta));
console.log("  vault-sbtc total-supply:", JSON.stringify(ts.value ?? ts));
console.log("  vault-sbtc lindex:", lidx.toString());
// per-zsBTC redeem value (in sBTC): ta/ts
const unwrapU = (r) => { const v = r.type === "ok" ? r.value : r; return BigInt(v.value?.value ?? v.value); };
const taV = unwrapU(ta);
const tsV = unwrapU(ts);
const redeemPer = taV * 100000000n / tsV; // per 1 zsBTC (8 decimals), x1e8
const lindexPer = lidx; // lindex/1e12 = per-share rate; scaled 1e8: lidx/1e4
console.log("  redeem value per zsBTC (x1e8):", redeemPer.toString());
console.log("  lindex value per zsBTC (x1e8):", (lidx / 10000n).toString());
console.log("  drift (bps):", ((redeemPer - lidx / 10000n) * 10000n / (redeemPer || 1n)).toString());
