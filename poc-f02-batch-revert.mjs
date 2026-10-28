// ============================================================================
// DEDICATED PoC: F-02 — liquidate-multi-with-feeds() all-or-revert regression
// Target: mainnet v0-8-market.clar (deployed interface; ported as market-v8)
//
// liquidate-multi-with-feeds folds call-liquidate-with-context over up to 8
// positions. Any per-position failure (e.g. ERR-HEALTHY 400018) propagates via
// try! through the fold and makes the WHOLE public function return (err),
// reverting every previously-successful liquidation in the same transaction.
// The legacy liquidate-multi (still in the repo's local-testing market.clar)
// used (ok (map call-liquidate positions)) and isolated per-position errors.
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
const [alice, bob, charlie, frank] = ["wallet_1", "wallet_2", "wallet_3", "wallet_6"].map(A);

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
function pf(btc) {
  const ts = btMicros();
  return Cl.some(Cl.list([Cl.buffer(buildUpdate([
    encodeFeed(1, BigInt(Math.round(btc * 1e8)), -8, ts),
    encodeFeed(5, 100000000n, -8, ts),
  ], ts))]));
}
function pfBuff(btc) {
  const ts = btMicros();
  return Cl.buffer(buildUpdate([
    encodeFeed(1, BigInt(Math.round(btc * 1e8)), -8, ts),
    encodeFeed(5, 100000000n, -8, ts),
  ], ts));
}
const P = (name, fn, args, who) => simnet.callPublicFn(name, fn, args, who || deployer);
const R = (name, fn, args) => simnet.callReadOnlyFn(name, fn, args, deployer);
const u = (v) => Cl.uint(v);
const cp = (n) => Cl.contractPrincipal(deployer, n);
function daoExecute(name) {
  const p = P("dao-multisig", "propose", [cp(name), Cl.bool(true)]);
  return P("dao-multisig", "execute", [u(p.result.value.value), cp(name)]);
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
const pub = Buffer.from(secp.getPublicKey(PRIVKEY, true));
P("pyth-lazer-oracle", "set-trusted-signers", [Cl.list([Cl.tuple({ pubkey: Cl.buffer(pub), "expires-at": Cl.uint(100_000_000_000n) })])]);
daoExecute("proposal-lazer-repoint");
daoExecute("proposal-switch-market-v8");
console.log("=== PoC F-02: liquidate-multi-with-feeds all-or-revert ===\n");

const sbtc = cp("sbtc"), usdc = cp("usdc");

// LP + liquidator funds
P("usdc", "mint", [u(1_000_000_000_000n), Cl.principal(bob)]);
P("vault-usdc", "deposit", [u(1_000_000_000_000n), u(0), Cl.principal(bob)], bob);
P("usdc", "mint", [u(500_000_000_000n), Cl.principal(charlie)]);
P("sbtc", "mint", [u(100_000_000n), Cl.principal(charlie)]);

// alice: will become liquidatable after the crash (42k debt vs 1 sBTC)
P("sbtc", "mint", [u(100_000_000n), Cl.principal(alice)]);
P("market-v8", "collateral-add", [sbtc, u(100_000_000n), pf(60000)], alice);
P("market-v8", "borrow", [usdc, u(42_000_000_000n), Cl.none(), pf(60000)], alice);
// frank: stays HEALTHY after the crash (only 500 USDC debt vs 1 sBTC -> LTV 16%)
P("sbtc", "mint", [u(100_000_000n), Cl.principal(frank)]);
P("market-v8", "collateral-add", [sbtc, u(100_000_000n), pf(60000)], frank);
P("market-v8", "borrow", [usdc, u(500_000_000n), Cl.none(), pf(60000)], frank);

const debtBefore = () => R("market-vault", "get-account-scaled-debt", [Cl.principal(alice), u(6)]).result.value;
const collBefore = () => R("market-vault", "resolve", [Cl.principal(alice)]).result;

console.log("alice USDC scaled-debt before:", debtBefore());
console.log("\n[1] crash BTC to $3k; batch = [alice (liquidatable), frank (healthy)]:");
const batch = P("market-v8", "liquidate-multi-with-feeds", [
  Cl.list([
    Cl.tuple({ borrower: Cl.principal(alice), "collateral-ft": sbtc, "debt-ft": usdc, "debt-amount": u(50_000_000_000n), "min-collateral-expected": u(0) }),
    Cl.tuple({ borrower: Cl.principal(frank), "collateral-ft": sbtc, "debt-ft": usdc, "debt-amount": u(50_000_000_000n), "min-collateral-expected": u(0) }),
  ]),
  pfBuff(3000),
], charlie);
console.log("    batch result:", JSON.stringify(batch.result));
console.log("    batch events:", batch.events.length, "(0 => NOTHING executed; whole tx reverted)");
console.log("    alice USDC scaled-debt after:", debtBefore(), "(unchanged => alice's liquidation was rolled back)");

console.log("\n[2] same liquidation of alice submitted INDIVIDUALLY (control):");
const liq = P("market-v8", "liquidate",
  [Cl.principal(alice), sbtc, usdc, u(50_000_000_000n), u(0), Cl.none(), pf(3000)], charlie);
console.log("    single liquidate result:", JSON.stringify(liq.result));
console.log("    alice USDC scaled-debt after:", debtBefore(), "(0 => socialized/cleared)");
const charlieSbtc = R("sbtc", "get-balance", [Cl.principal(charlie)]).result.value;
console.log("    charlie sBTC balance:", charlieSbtc, "(2 BTC = 1 minted + 1 seized)");
