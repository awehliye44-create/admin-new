import { describe, expect, it } from "vitest";
import {
  buildCompanyPayeeUkBankCounterpartyBody,
  classifyProviderCreateFailure,
  companyPayeeCounterpartyKind,
  companyPayeeLinkErrorLabel,
  companyPayeeVerificationDisplayStatus,
  isCompanyPayeeProviderVerified,
  matchUkBankAgainstCounterparties,
} from "../../../shared/companyPayeeRevolutLinkSSOT";
import {
  isCompanyTransferCertificationOrTestProof,
  isCompanyTransferOperationallyVisible,
} from "../../../shared/companyTransferLifecycleSSOT";

describe("companyPayeeRevolutLinkSSOT", () => {
  it("maps DB statuses to provider display SSOT", () => {
    expect(companyPayeeVerificationDisplayStatus("UNVERIFIED")).toBe("UNVERIFIED");
    expect(companyPayeeVerificationDisplayStatus("PENDING")).toBe("LINKING");
    expect(companyPayeeVerificationDisplayStatus("VERIFIED")).toBe("PROVIDER_VERIFIED");
    expect(companyPayeeVerificationDisplayStatus("FAILED")).toBe("LINK_FAILED");
    expect(isCompanyPayeeProviderVerified("VERIFIED")).toBe(true);
    expect(isCompanyPayeeProviderVerified("UNVERIFIED")).toBe(false);
  });

  it("builds business UK counterparty body without flat name", () => {
    const body = buildCompanyPayeeUkBankCounterpartyBody({
      kind: "business",
      accountHolderName: "ONECAB Limited",
      sortCode: "04-00-04",
      accountNumber: "12345678",
    });
    expect(body.company_name).toBe("ONECAB Limited");
    expect(body.sort_code).toBe("040004");
    expect(body.account_no).toBe("12345678");
    expect(body).not.toHaveProperty("name");
  });

  it("uses business kind for director payees", () => {
    expect(companyPayeeCounterpartyKind("DIRECTOR")).toBe("business");
    expect(companyPayeeCounterpartyKind("STAFF")).toBe("personal");
  });

  it("matches unique UK bank counterparty and detects conflict", () => {
    const list = [
      {
        id: "cp-1",
        accounts: [{ id: "ra-1", sort_code: "040004", account_no: "12345678", currency: "GBP" }],
      },
    ];
    const unique = matchUkBankAgainstCounterparties({
      sortCode: "040004",
      accountNumber: "12345678",
      counterparties: list,
    });
    expect(unique.status).toBe("unique");
    expect(unique.hit?.counterparty_id).toBe("cp-1");

    const conflict = matchUkBankAgainstCounterparties({
      sortCode: "040004",
      accountNumber: "12345678",
      counterparties: [
        ...list,
        {
          id: "cp-2",
          accounts: [{ id: "ra-2", sort_code: "040004", account_no: "12345678", currency: "GBP" }],
        },
      ],
    });
    expect(conflict.status).toBe("conflict");
  });

  it("maps provider failures to precise UX copy", () => {
    expect(companyPayeeLinkErrorLabel("AUTHENTICATION_REQUIRED")).toBe(
      "Revolut connection expired.",
    );
    const rejected = classifyProviderCreateFailure({
      httpStatus: 400,
      safeMessage: "Invalid account details",
    });
    expect(rejected.user_message).toBe("Revolut rejected the account details.");
  });
});

describe("Slice11 proof operational visibility", () => {
  it("hides certification proof rows from operational list but keeps history access", () => {
    const row = {
      status: "CANCELLED",
      transfer_type: "CERTIFICATION",
      recipient_name: "Slice11 Proof Payee",
      metadata: {
        slice11: true,
        environment_record: "TEST_PROOF",
        operational_visibility: "HISTORY_ONLY",
      },
    };
      expect(isCompanyTransferCertificationOrTestProof(row)).toBe(true);
      expect(isCompanyTransferOperationallyVisible(row)).toBe(false);
    });

    it("keeps active certification drafts operationally visible", () => {
      const draft = {
        status: "DRAFT",
        transfer_type: "CERTIFICATION",
        recipient_name: "ONECAB Limited",
        metadata: { environment_record: "TEST_PROOF", certification: true },
      };
      expect(isCompanyTransferOperationallyVisible(draft)).toBe(true);
    });
});
