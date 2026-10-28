;; Proposal (TEST): custom egroups for adversarial probes on market-v8
;; Egroup A: sBTC coll + USDC debt + STX debt  (MASK = 2^2 + 2^70 + 2^64)
(impl-trait .dao-traits.proposal-script)

(define-public (execute)
  (begin
    ;; sBTC collateral (bit 2) + USDC debt (bit 70) + STX debt (bit 64)
    ;; MASK = 4 + 1180591620717411303424 + 18446744073709551616 = 1199039364791116855044
    (try! (contract-call? .egroup insert {
      MASK: u1199039364791116855044,
      BORROW-DISABLED-MASK: u0,
      LIQ-CURVE-EXP: u10000,
      LIQ-PENALTY-MIN: u500,
      LIQ-PENALTY-MAX: u1000,
      LTV-BORROW: u4000,
      LTV-LIQ-PARTIAL: u5500,
      LTV-LIQ-FULL: u6500
    }))

    ;; USDC collateral (bit 6) + sBTC debt (bit 66) - for utilization setup
    ;; MASK = 64 + 73786976294838206464 = 73786976294838206528
    (try! (contract-call? .egroup insert {
      MASK: u73786976294838206528,
      BORROW-DISABLED-MASK: u0,
      LIQ-CURVE-EXP: u10000,
      LIQ-PENALTY-MIN: u500,
      LIQ-PENALTY-MAX: u1000,
      LTV-BORROW: u4000,
      LTV-LIQ-PARTIAL: u5500,
      LTV-LIQ-FULL: u6500
    }))
    (ok true)))
