import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import React from "react";

const { mockSupabase } = vi.hoisted(() => ({
  mockSupabase: {
    auth: {
      getSession: vi.fn(),
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signOut: vi.fn(),
      onAuthStateChange: vi.fn(),
    },
    from: vi.fn(),
  },
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: mockSupabase,
}));

vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { AuthProvider, useAuth } from "@/hooks/useAuth";

const mockUser = {
  id: "test-user-id",
  email: "test@example.com",
  user_metadata: { first_name: "Test", last_name: "User" },
  app_metadata: {},
  aud: "authenticated",
  created_at: new Date().toISOString(),
};

const mockSession = {
  access_token: "mock-access-token",
  refresh_token: "mock-refresh-token",
  expires_in: 3600,
  expires_at: Date.now() / 1000 + 3600,
  user: mockUser,
};

const wait = () => new Promise((r) => setTimeout(r, 10));

const wrapper = ({ children }: { children: React.ReactNode }) =>
  React.createElement(AuthProvider, null, children);

describe("useAuth Hook", () => {
  let authChangeCallback: (event: string, session: any) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    mockSupabase.auth.onAuthStateChange.mockImplementation((cb: any) => {
      authChangeCallback = cb;
      return { data: { subscription: { unsubscribe: vi.fn() } } };
    });
    mockSupabase.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      single: vi.fn().mockResolvedValue({ data: null, error: null }),
    });
  });

  it("starts with no user when not authenticated", async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => { await wait(); });
    expect(result.current.isAuthReady).toBe(true);
    expect(result.current.user).toBeNull();
    expect(result.current.isAdmin).toBe(false);
  });

  it("loads existing session on mount", async () => {
    mockSupabase.auth.getSession.mockResolvedValue({
      data: { session: mockSession },
      error: null,
    });
    mockSupabase.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{ role: "admin" }],
        error: null,
      }),
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => { await wait(); });

    expect(result.current.isAuthReady).toBe(true);
    expect(result.current.user).toEqual(mockUser);
    expect(result.current.isAdmin).toBe(true);
  });

  it("calls signInWithPassword on signIn", async () => {
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: mockUser, session: mockSession },
      error: null,
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => { await wait(); });

    let res: any;
    await act(async () => {
      res = await result.current.signIn("test@example.com", "password123");
    });

    expect(mockSupabase.auth.signInWithPassword).toHaveBeenCalledWith({
      email: "test@example.com",
      password: "password123",
    });
    expect(res.error).toBeNull();
  });

  it("calls signOut and clears state on SIGNED_OUT event", async () => {
    mockSupabase.auth.getSession.mockResolvedValue({
      data: { session: mockSession },
      error: null,
    });
    mockSupabase.auth.signOut.mockResolvedValue({ error: null });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => { await wait(); });

    await act(async () => {
      await result.current.signOut();
    });

    expect(mockSupabase.auth.signOut).toHaveBeenCalled();

    await act(async () => {
      authChangeCallback("SIGNED_OUT", null);
      await wait();
    });

    expect(result.current.user).toBeNull();
    expect(result.current.isAdmin).toBe(false);
  });

  it("does NOT sign out on TOKEN_REFRESHED event", async () => {
    mockSupabase.auth.getSession.mockResolvedValue({
      data: { session: mockSession },
      error: null,
    });
    mockSupabase.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{ role: "admin" }],
        error: null,
      }),
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => { await wait(); });

    expect(result.current.user).toEqual(mockUser);

    await act(async () => {
      authChangeCallback("TOKEN_REFRESHED", mockSession);
      await wait();
    });

    expect(result.current.user).toEqual(mockUser);
    expect(result.current.session).toEqual(mockSession);
  });

  it("keeps cached admin status on transient failure", async () => {
    mockSupabase.auth.getSession.mockResolvedValue({
      data: { session: mockSession },
      error: null,
    });
    mockSupabase.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: [{ role: "admin" }],
        error: null,
      }),
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await act(async () => { await wait(); });
    expect(result.current.isAdmin).toBe(true);

    // Now fail the admin check
    mockSupabase.from.mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: null,
        error: new Error("Network error"),
      }),
    });

    await act(async () => {
      authChangeCallback("TOKEN_REFRESHED", mockSession);
      await wait();
    });

    // Should keep cached admin status
    expect(result.current.isAdmin).toBe(true);
  });

  it("throws when used outside AuthProvider", () => {
    expect(() => {
      renderHook(() => useAuth());
    }).toThrow("useAuth must be used within an AuthProvider");
  });
});
