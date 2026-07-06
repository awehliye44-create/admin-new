import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  checkRateLimit,
  getClientIP,
  isValidUUID,
  sanitizeString,
  isValidLatitude,
  isValidLongitude,
  isPositiveInteger,
  isValidPaymentMethod,
} from "../../supabase/functions/_shared/security";

describe("Security Utilities", () => {
  describe("Rate Limiting", () => {
    beforeEach(() => {
      // Clear rate limit store between tests by waiting
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("should allow requests within limit", () => {
      const result1 = checkRateLimit("test-ip-1", { limit: 5, windowMs: 60000 });
      expect(result1.allowed).toBe(true);
      expect(result1.remaining).toBe(4);

      const result2 = checkRateLimit("test-ip-1", { limit: 5, windowMs: 60000 });
      expect(result2.allowed).toBe(true);
      expect(result2.remaining).toBe(3);
    });

    it("should block requests exceeding limit", () => {
      const config = { limit: 3, windowMs: 60000 };
      
      checkRateLimit("test-ip-2", config);
      checkRateLimit("test-ip-2", config);
      checkRateLimit("test-ip-2", config);
      
      const result = checkRateLimit("test-ip-2", config);
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfter).toBeDefined();
    });

    it("should reset after window expires", () => {
      const config = { limit: 2, windowMs: 1000 };
      
      checkRateLimit("test-ip-3", config);
      checkRateLimit("test-ip-3", config);
      
      // Advance time past the window
      vi.advanceTimersByTime(1500);
      
      const result = checkRateLimit("test-ip-3", config);
      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(1);
    });

    it("should track different IPs separately", () => {
      const config = { limit: 1, windowMs: 60000 };
      
      checkRateLimit("ip-a", config);
      const resultA = checkRateLimit("ip-a", config);
      expect(resultA.allowed).toBe(false);
      
      const resultB = checkRateLimit("ip-b", config);
      expect(resultB.allowed).toBe(true);
    });
  });

  describe("getClientIP", () => {
    it("should extract IP from x-forwarded-for header", () => {
      const mockRequest = new Request("https://example.com", {
        headers: {
          "x-forwarded-for": "1.2.3.4, 5.6.7.8",
        },
      });
      expect(getClientIP(mockRequest)).toBe("1.2.3.4");
    });

    it("should fall back to x-real-ip", () => {
      const mockRequest = new Request("https://example.com", {
        headers: {
          "x-real-ip": "10.0.0.1",
        },
      });
      expect(getClientIP(mockRequest)).toBe("10.0.0.1");
    });

    it("should return unknown for no IP headers", () => {
      const mockRequest = new Request("https://example.com");
      expect(getClientIP(mockRequest)).toBe("unknown");
    });
  });

  describe("Input Validation", () => {
    describe("isValidUUID", () => {
      it("should accept valid UUIDs", () => {
        expect(isValidUUID("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
        expect(isValidUUID("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
      });

      it("should reject invalid UUIDs", () => {
        expect(isValidUUID("not-a-uuid")).toBe(false);
        expect(isValidUUID("550e8400-e29b-41d4-a716")).toBe(false);
        expect(isValidUUID("")).toBe(false);
      });
    });

    describe("sanitizeString", () => {
      it("should remove HTML tags", () => {
        const result = sanitizeString("<script>alert('xss')</script>hello");
        expect(result).not.toContain("<script>");
        expect(result).toContain("hello");
      });

      it("should encode special characters", () => {
        const result = sanitizeString("Hello <world> & 'friends'");
        expect(result).not.toContain("<world>");
        expect(result).toContain("Hello");
      });

      it("should respect max length", () => {
        const longString = "a".repeat(2000);
        const result = sanitizeString(longString, 100);
        expect(result.length).toBeLessThanOrEqual(100);
      });

      it("should trim whitespace", () => {
        expect(sanitizeString("  hello world  ")).toBe("hello world");
      });
    });

    describe("isValidLatitude", () => {
      it("should accept valid latitudes", () => {
        expect(isValidLatitude(0)).toBe(true);
        expect(isValidLatitude(90)).toBe(true);
        expect(isValidLatitude(-90)).toBe(true);
        expect(isValidLatitude(51.5074)).toBe(true);
      });

      it("should reject invalid latitudes", () => {
        expect(isValidLatitude(91)).toBe(false);
        expect(isValidLatitude(-91)).toBe(false);
        expect(isValidLatitude(NaN)).toBe(false);
      });
    });

    describe("isValidLongitude", () => {
      it("should accept valid longitudes", () => {
        expect(isValidLongitude(0)).toBe(true);
        expect(isValidLongitude(180)).toBe(true);
        expect(isValidLongitude(-180)).toBe(true);
        expect(isValidLongitude(-0.1278)).toBe(true);
      });

      it("should reject invalid longitudes", () => {
        expect(isValidLongitude(181)).toBe(false);
        expect(isValidLongitude(-181)).toBe(false);
        expect(isValidLongitude(NaN)).toBe(false);
      });
    });

    describe("isPositiveInteger", () => {
      it("should accept positive integers", () => {
        expect(isPositiveInteger(1)).toBe(true);
        expect(isPositiveInteger(100)).toBe(true);
        expect(isPositiveInteger(999999)).toBe(true);
      });

      it("should reject non-positive or non-integer values", () => {
        expect(isPositiveInteger(0)).toBe(false);
        expect(isPositiveInteger(-1)).toBe(false);
        expect(isPositiveInteger(3.14)).toBe(false);
        expect(isPositiveInteger(NaN)).toBe(false);
      });
    });

    describe("isValidPaymentMethod", () => {
      it("should accept valid payment methods", () => {
        expect(isValidPaymentMethod("CARD")).toBe(true);
        expect(isValidPaymentMethod("WALLET")).toBe(true);
        expect(isValidPaymentMethod("APPLE_PAY")).toBe(true);
        expect(isValidPaymentMethod("GOOGLE_PAY")).toBe(true);
      });

      it("should reject invalid payment methods", () => {
        expect(isValidPaymentMethod("BITCOIN")).toBe(false);
        expect(isValidPaymentMethod("PAYPAL")).toBe(false);
        expect(isValidPaymentMethod("")).toBe(false);
      });
    });
  });
});

// Import afterEach at the top level
import { afterEach } from "vitest";
