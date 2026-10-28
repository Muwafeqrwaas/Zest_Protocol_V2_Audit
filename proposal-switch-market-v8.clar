;; Proposal (TEST): switch the protocol to the ported MAINNET market (market-v8)
;; Points market-vault's impl at market-v8 and authorizes it in all vaults.
(impl-trait .dao-traits.proposal-script)

(define-public (execute)
  (begin
    (try! (contract-call? .market-vault set-impl .market-v8))
    (try! (contract-call? .vault-stx      set-authorized-contract .market-v8 true))
    (try! (contract-call? .vault-sbtc     set-authorized-contract .market-v8 true))
    (try! (contract-call? .vault-ststx    set-authorized-contract .market-v8 true))
    (try! (contract-call? .vault-usdc     set-authorized-contract .market-v8 true))
    (try! (contract-call? .vault-usdh     set-authorized-contract .market-v8 true))
    (try! (contract-call? .vault-ststxbtc set-authorized-contract .market-v8 true))
    (try! (contract-call? .vault-stbtc    set-authorized-contract .market-v8 true))
    (ok true)))
