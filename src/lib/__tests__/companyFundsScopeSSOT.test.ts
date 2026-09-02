import { describe, expect, it } from "vitest";
import { resolveCompanyFundsScope } from "../../../shared/companyFundsScopeSSOT";

describe("companyFundsScopeSSOT", () => {
  it("uses GLOBAL scope when Revolut source is not SA-segregated", () => {
    const scope = resolveCompanyFundsScope({
      ui_service_area_id: "cb58f1bd-8b6f-45b9-ad31-b3140309892c",
      revolut_source_service_area_id: null,
    });
    expect(scope.scope_mode).toBe("GLOBAL");
    expect(scope.balance_service_area_id).toBeNull();
    expect(scope.is_global_source).toBe(true);
  });

  it("uses SERVICE_AREA scope when source account is SA-bound", () => {
    const sa = "cb58f1bd-8b6f-45b9-ad31-b3140309892c";
    const scope = resolveCompanyFundsScope({
      ui_service_area_id: sa,
      revolut_source_service_area_id: sa,
    });
    expect(scope.scope_mode).toBe("SERVICE_AREA");
    expect(scope.balance_service_area_id).toBe(sa);
  });
});
