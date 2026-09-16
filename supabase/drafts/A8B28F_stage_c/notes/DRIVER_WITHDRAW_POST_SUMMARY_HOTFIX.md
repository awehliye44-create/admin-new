# driver-withdraw POST ReferenceError hotfix (Stage A)

## Defect
Live v32 POST referenced `summary.service_area_id` but `summary` exists only inside
`buildDriverWithdrawQuoteReadOnly` → ReferenceError before reservation/provider.

## Correction
- Quote builder returns authoritative `service_area_id` (from wallet summary SSOT),
  verified against `drivers.service_area_id` + `driver_service_areas` membership.
- POST consumes `built.service_area_id` only.
- Client `service_area_id` rejected.
- Typed `INTERNAL_EXECUTION_ERROR` catch — never mapped as NO_AVAILABLE_BALANCE.
- Handler-level orchestration tests with mocked reserve/provider.
- Group 2 unchanged. No migration. No Driver app changes.

## Rollback
Redeploy prior artifact: driver-withdraw v32 / f755d2e7c3fa30d33ff1f81fd39b16601f4430baffd367c5ddcc9d33e5abd4ae
