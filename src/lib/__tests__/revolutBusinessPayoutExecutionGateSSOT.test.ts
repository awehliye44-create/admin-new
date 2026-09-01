import { describe, expect, it } from "vitest";
import {
  REVOLUT_BUSINESS_ACCOUNTS_BALANCE_BLOCKED_COPY,
  REVOLUT_BUSINESS_PAYOUT_OAUTH_BLOCKED_COPY,
  REVOLUT_BUSINESS_SELECTED_SOURCE_STALE_COPY,
  evaluateRevolutBusinessPayoutExecutionGate,
  hasRevolutBusinessPayoutScopesGranted,
} from "../../../shared/revolutBusinessOAuthSSOT.ts";

describe("evaluateRevolutBusinessPayoutExecutionGate", () => {
  it("locks payouts when OAuth is awaiting consent even if LIVE env is true", () => {
    const gate = evaluateRevolutBusinessPayoutExecutionGate({
      oauth_connected: false,
      token_valid: false,
      oauth_scopes_granted: [],
      live_payout_execution_enabled: true,
      accounts_list_succeeded: false,
      selected_source_account_ok: false,
      live_balance_pence: 1351,
    });
    expect(gate.payout_execution_locked).toBe(true);
    expect(gate.live_payouts_blocked).toBe(true);
    expect(gate.live_payouts_executable).toBe(false);
    expect(gate.admin_blocked_copy).toBe(REVOLUT_BUSINESS_PAYOUT_OAUTH_BLOCKED_COPY);
  });

  it("locks payouts when token valid but /accounts failed", () => {
    const gate = evaluateRevolutBusinessPayoutExecutionGate({
      oauth_connected: true,
      token_valid: true,
      oauth_scopes_granted: ["READ", "WRITE", "PAY"],
      live_payout_execution_enabled: true,
      accounts_list_succeeded: false,
      selected_source_account_ok: false,
      live_balance_pence: null,
    });
    expect(gate.payout_execution_locked).toBe(true);
    expect(gate.live_payouts_executable).toBe(false);
    expect(gate.admin_blocked_copy).toBe(REVOLUT_BUSINESS_ACCOUNTS_BALANCE_BLOCKED_COPY);
  });

  it("locks payouts when /accounts succeeded but selected source is missing", () => {
    const gate = evaluateRevolutBusinessPayoutExecutionGate({
      oauth_connected: true,
      token_valid: true,
      oauth_scopes_granted: ["READ", "WRITE", "PAY"],
      live_payout_execution_enabled: true,
      accounts_list_succeeded: true,
      selected_source_account_ok: false,
      live_balance_pence: null,
    });
    expect(gate.payout_execution_locked).toBe(true);
    expect(gate.admin_blocked_copy).toBe(REVOLUT_BUSINESS_SELECTED_SOURCE_STALE_COPY);
  });

  it("locks payouts when scopes incomplete", () => {
    const partial = evaluateRevolutBusinessPayoutExecutionGate({
      oauth_connected: true,
      token_valid: true,
      oauth_scopes_granted: ["READ"],
      live_payout_execution_enabled: true,
      accounts_list_succeeded: true,
      selected_source_account_ok: true,
      live_balance_pence: 5000,
    });
    expect(partial.payout_execution_locked).toBe(true);
    expect(partial.live_payouts_executable).toBe(false);
    expect(partial.admin_blocked_copy).toBe(REVOLUT_BUSINESS_PAYOUT_OAUTH_BLOCKED_COPY);
  });

  it("requires live balance verification before executable", () => {
    const gate = evaluateRevolutBusinessPayoutExecutionGate({
      oauth_connected: true,
      token_valid: true,
      oauth_scopes_granted: ["READ", "WRITE", "PAY"],
      live_payout_execution_enabled: true,
      accounts_list_succeeded: true,
      selected_source_account_ok: true,
      live_balance_pence: null,
    });
    expect(gate.payout_execution_locked).toBe(true);
    expect(gate.live_payouts_executable).toBe(false);
  });

  it("allows executable only when OAuth, scopes, /accounts, source, env, and live balance are ready", () => {
    const gate = evaluateRevolutBusinessPayoutExecutionGate({
      oauth_connected: true,
      token_valid: true,
      oauth_scopes_granted: ["READ", "WRITE", "PAY"],
      live_payout_execution_enabled: true,
      accounts_list_succeeded: true,
      selected_source_account_ok: true,
      live_balance_pence: 5000,
    });
    expect(gate.live_payouts_executable).toBe(true);
    expect(gate.payout_execution_locked).toBe(false);
    expect(gate.live_payouts_blocked).toBe(false);
    expect(gate.admin_blocked_copy).toBeNull();
  });
});

describe("hasRevolutBusinessPayoutScopesGranted", () => {
  it("requires READ, WRITE, and PAY", () => {
    expect(hasRevolutBusinessPayoutScopesGranted(["READ", "WRITE", "PAY"])).toBe(true);
    expect(hasRevolutBusinessPayoutScopesGranted(["READ", "WRITE"])).toBe(false);
    expect(hasRevolutBusinessPayoutScopesGranted([])).toBe(false);
  });
});
