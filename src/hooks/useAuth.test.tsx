import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import React from "react";

// Must mock before imports that use these modules
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { mockUser, mockSession, resetAllMocks, mockSupabaseClient } from "@/test/mocks";

describe("useAuth Hook", () => {
  let authChangeCallback: (event: string, session: any) => void;

  beforeEach(() => {
    resetAllMocks();
    mockSupabaseClient.auth.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });
    mockSupabaseClient.auth.onAuthStateChange.mockImplementation((cb: any) => {
      authChangeCallback = cb;
      return {
        data: {
          subscription: { unsubscribe: vi.fn() },
        },
      };
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => {
    return React.createElement(AuthProvider, null, children);
  };

  describe("Initial State", () => {
    it("should start with no user when not authenticated", async () => {
      const { result } = renderHook(() => useAuth(), { wrapper });

      await act(async () => {
        await waitForEffect();
      });

      expect(result.current.isAuthReady).toBe(true);
      expect(result.current.user).toBeNull();
      expect(result.current.session).toBeNull();
      expect(result.current.isAdmin).toBe(false);
    });

    it("should load existing session on mount", async () => {
      mockSupabaseClient.auth.getSession.mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });

      mockSupabaseClient.from.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: [{ role: "admin" }],
          error: null,
        }),
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await act(async () => {
        await waitForEffect();
      });

      expect(result.current.isAuthReady).toBe(true);
      expect(result.current.user).toEqual(mockUser);
      expect(result.current.session).toEqual(mockSession);
    });
  });

  describe("Sign In", () => {
    it("should call signInWithPassword on signIn", async () => {
      mockSupabaseClient.auth.signInWithPassword.mockResolvedValue({
        data: { user: mockUser, session: mockSession },
        error: null,
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await act(async () => {
        await waitForEffect();
      });

      let signInResult: { error: Error | null };
      await act(async () => {
        signInResult = await result.current.signIn("test@example.com", "password123");
      });

      expect(mockSupabaseClient.auth.signInWithPassword).toHaveBeenCalledWith({
        email: "test@example.com",
        password: "password123",
      });
      expect(signInResult!.error).toBeNull();
    });

    it("should return error on sign in failure", async () => {
      const mockError = new Error("Invalid credentials");
      mockSupabaseClient.auth.signInWithPassword.mockResolvedValue({
        data: { user: null, session: null },
        error: mockError,
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await act(async () => {
        await waitForEffect();
      });

      let signInResult: { error: Error | null };
      await act(async () => {
        signInResult = await result.current.signIn("test@example.com", "wrongpassword");
      });

      expect(signInResult!.error).toEqual(mockError);
    });
  });

  describe("Sign Up", () => {
    it("should call signUp with correct parameters", async () => {
      mockSupabaseClient.auth.signUp.mockResolvedValue({
        data: { user: mockUser, session: null },
        error: null,
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await act(async () => {
        await waitForEffect();
      });

      let signUpResult: { error: Error | null };
      await act(async () => {
        signUpResult = await result.current.signUp("newuser@example.com", "newpassword123");
      });

      expect(mockSupabaseClient.auth.signUp).toHaveBeenCalledWith({
        email: "newuser@example.com",
        password: "newpassword123",
        options: expect.objectContaining({
          emailRedirectTo: expect.stringContaining(window.location.origin),
        }),
      });
      expect(signUpResult!.error).toBeNull();
    });
  });

  describe("Sign Out", () => {
    it("should call signOut and clear admin status", async () => {
      mockSupabaseClient.auth.getSession.mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });
      mockSupabaseClient.auth.signOut.mockResolvedValue({ error: null });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await act(async () => {
        await waitForEffect();
      });

      await act(async () => {
        await result.current.signOut();
      });

      expect(mockSupabaseClient.auth.signOut).toHaveBeenCalled();
      
      // Simulate the SIGNED_OUT event that Supabase fires after signOut
      await act(async () => {
        authChangeCallback('SIGNED_OUT', null);
        await waitForEffect();
      });

      expect(result.current.isAdmin).toBe(false);
      expect(result.current.user).toBeNull();
    });
  });

  describe("Resilience", () => {
    it("should NOT sign out on TOKEN_REFRESHED event", async () => {
      mockSupabaseClient.auth.getSession.mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });

      mockSupabaseClient.from.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: [{ role: "admin" }],
          error: null,
        }),
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await act(async () => {
        await waitForEffect();
      });

      expect(result.current.user).toEqual(mockUser);

      // Simulate TOKEN_REFRESHED
      await act(async () => {
        authChangeCallback('TOKEN_REFRESHED', mockSession);
        await waitForEffect();
      });

      expect(result.current.user).toEqual(mockUser);
      expect(result.current.session).toEqual(mockSession);
    });

    it("should NOT flip isAdmin on transient admin check failure", async () => {
      mockSupabaseClient.auth.getSession.mockResolvedValue({
        data: { session: mockSession },
        error: null,
      });

      // First call succeeds
      mockSupabaseClient.from.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: [{ role: "admin" }],
          error: null,
        }),
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await act(async () => {
        await waitForEffect();
      });

      expect(result.current.isAdmin).toBe(true);

      // Now simulate a transient failure on next admin check
      mockSupabaseClient.from.mockReturnValue({
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({
          data: null,
          error: new Error("Network error"),
        }),
      });

      // Trigger a TOKEN_REFRESHED event
      await act(async () => {
        authChangeCallback('TOKEN_REFRESHED', mockSession);
        await waitForEffect();
      });

      // Admin status should remain true (cached)
      expect(result.current.isAdmin).toBe(true);
    });
  });

  describe("Error Handling", () => {
    it("should throw error when useAuth is used outside AuthProvider", () => {
      expect(() => {
        renderHook(() => useAuth());
      }).toThrow("useAuth must be used within an AuthProvider");
    });
  });
});
