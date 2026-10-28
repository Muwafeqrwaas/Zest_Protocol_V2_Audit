// ============================================================================
// DEDICATED PoC: F-01 — market.repay() runtime panic on cold index cache
// Target: mainnet v0-8-market.clar (ported as market-v8, logic identical)
//
// A user with NO debt in an asset calls repay(ft, amount, none).
// Expected: clean error ERR-INSUFFICIENT-SCALED-DEBT (400006).
// Actual:   Runtime UnwrapFailure PANIC at market.clar:1311
//           (borrow-index (get index (unwrap-panic (get-cached-indexes asset-id))))
//           -> whole transaction aborts with a runtime error.
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
const alice = simnet.getAccounts().get("wallet_1");
const bob = simnet.getAccounts().get("wallet_2");
const victor = simnet.getAccounts().get("wallet_7"); // fresh victim: no debt ever

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
function pf(btc = 60000) {
  const ts = btMicros();
  return Cl.some(Cl.list([Cl.buffer(buildUpdate([
    encodeFeed(1, BigInt(Math.round(btc * 1e8)), -8, ts),
    encodeFeed(5, 100000000n, -8, ts),
  ], ts))]));
}
const P = (name, fn, args, who) => simnet.callPublicFn(name, fn, args, who || deployer);
const u = (v) => Cl.uint(v);
const cp = (n) => Cl.contractPrincipal(deployer, n);
function daoExecute(name) {
  const p = P("dao-multisig", "propose", [cp(name), Cl.bool(true)]);
  return P("dao-multisig", "execute", [u(p.result.value.value), cp(name)]);
}

// ---- protocol init ----
P("dao-multisig", "init", [Cl.list([Cl.principal(deployer)]), u(1)]);
P("dao-executor", "init", [cp("dao-multisig")]);
daoExecute("proposal-init-assets");
for (const [tok, amt] of [["sbtc", 1000n], ["usdh", 1000n], ["usdc", 1000n], ["ststx", 1000n]]) P(tok, "mint", [u(amt), cp("proposal-init-vaults")]);
P("wstx", "transfer", [u(1000n), Cl.principal(deployer), cp("proposal-init-vaults"), Cl.none()]);
daoExecute("proposal-init-vaults");
daoExecute("proposal-init-market-vault");
daoExecute("proposal-create-multiple-egroups");
const pub = Buffer.from(secp.getPublicKey(PRIVKEY, true));
P("pyth-lazer-oracle", "set-trusted-signers", [Cl.list([Cl.tuple({ pubkey: Cl.buffer(pub), "expires-at": Cl.uint(100_000_000_000n) })])]);
daoExecute("proposal-lazer-repoint");
daoExecute("proposal-switch-market-v8");
console.log("=== PoC F-01: repay() runtime panic (mainnet market code) ===\n");

const usdc = cp("usdc"), sbtc = cp("sbtc");

// victor is a completely fresh account: no position, no debt.
// Give him USDC so the ONLY failure reason is the missing debt, not balance.
P("usdc", "mint", [u(1_000_000_000n), Cl.principal(victor)]);
// LP liquidity so the control borrow can succeed
P("usdc", "mint", [u(1_000_000_000_000n), Cl.principal(bob)]);
P("vault-usdc", "deposit", [u(1_000_000_000_000n), u(0), Cl.principal(bob)], bob);

console.log("[1] victor calls market.repay(usdc, 1 USDC, none) with NO debt at all:");
try {
  const r = P("market-v8", "repay", [usdc, u(1_000_000n), Cl.none()], victor);
  console.log("    result:", JSON.stringify(r.result));
} catch (e) {
  console.log("    RUNTIME PANIC ->", String(e.message).split("\n").filter(l => /market-v8|Error occurred|UnwrapFailure|Expression/i.test(l)).join(" | ").slice(0, 220));
}

console.log("\n[2] control: victor with a real debt (should repay cleanly):");
P("sbtc", "mint", [u(100_000_000n), Cl.principal(victor)]);
const ca = P("market-v8", "collateral-add", [sbtc, u(100_000_000n), pf()], victor);
console.log("    collateral-add:", ca.result.type === "ok" ? "ok" : JSON.stringify(ca.result.value).slice(0, 80));
const bo = P("market-v8", "borrow", [usdc, u(1_000_000_000n), Cl.none(), pf()], victor);
console.log("    borrow:", bo.result.type === "ok" ? "ok" : JSON.stringify(bo.result.value).slice(0, 80));
const r2 = P("market-v8", "repay", [usdc, u(1_000_000_000n), Cl.none()], victor);
console.log("    result:", r2.result.type, JSON.stringify(r2.result.value ?? ""));

console.log("\n[3] victor repays AGAIN (debt now zero, same-asset double-repay):");
try {
  const r3 = P("market-v8", "repay", [usdc, u(1_000_000n), Cl.none()], victor);
  console.log("    result:", JSON.stringify(r3.result));
} catch (e) {
  console.log("    RUNTIME PANIC ->", String(e.message).split("\n").filter(l => /market-v8|Error occurred|UnwrapFailure/i.test(l)).join(" | ").slice(0, 200));
}

// [4] repay a DIFFERENT asset than the one owed (has USDC-history but repays sBTC)
console.log("\n[4] fresh user with USDC debt tries to repay sBTC (wrong asset):");
const wendy = simnet.getAccounts().get("wallet_8");
P("sbtc", "mint", [u(100_000_000n), Cl.principal(wendy)]);
const ca2 = P("market-v8", "collateral-add", [sbtc, u(100_000_000n), pf()], wendy);
console.log("    collateral-add:", ca2.result.type === "ok" ? "ok" : JSON.stringify(ca2.result.value).slice(0, 80));
const bo2 = P("market-v8", "borrow", [usdc, u(1_000_000_000n), Cl.none(), pf()], wendy);
console.log("    borrow:", bo2.result.type === "ok" ? "ok" : JSON.stringify(bo2.result.value).slice(0, 80));
P("sbtc", "mint", [u(10_000_000n), Cl.principal(wendy)]);
try {
  const r4 = P("market-v8", "repay", [sbtc, u(1_000_000n), Cl.none()], wendy);
  console.log("    result:", JSON.stringify(r4.result));
} catch (e) {
  console.log("    RUNTIME PANIC ->", String(e.message).split("\n").filter(l => /market-v8|Error occurred|UnwrapFailure/i.test(l)).join(" | ").slice(0, 200));
}
