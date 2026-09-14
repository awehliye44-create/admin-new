A8B28F Stage B — package index (DRAFT ONLY — NOT APPLIED / NOT DEPLOYED / NOT COMMITTED)

B1/  Admin operational-pause RPC migration + rollback + BEGIN/ROLLBACK verify
B2/  Complete update-driver-payout-destination handler + entrypoint (drop-in)
B3/  Admin verify prohibition (drop-in)
B4/  Driver app notes (live Driver working tree already updated for banners/mapper)
B5/  Admin UI pause RPC helper + DriverPayoutPanel notes
shared/  payoutDestinationVerificationOutcomeSSOT.ts (copy to functions/_shared on deploy)
tests/   simulation + compat harness
runbook/ DEPLOY_ROLLBACK.txt

Source-lock tests (admin-new):
  src/lib/__tests__/phaseA8B28FAdminPayoutOperationalPauseRpc.test.ts
  src/lib/__tests__/phaseA8B28FAdminManualVerifyForbidden.test.ts
  src/lib/__tests__/phaseA8B28FProviderLinkageContract.test.ts
