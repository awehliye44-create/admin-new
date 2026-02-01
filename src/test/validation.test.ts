import { describe, it, expect, vi, beforeEach } from "vitest";
import { 
  validateUUID, 
  validateString, 
  validateNumber, 
  validateLatitude, 
  validateLongitude, 
  validateEnum,
  validatePaymentMethod,
  validateSchema,
  acceptTripSchema,
  declineTripSchema,
  dispatchTripSchema,
  completeTripSchema,
} from "../../supabase/functions/_shared/validation";

describe("Validation Utilities", () => {
  describe("validateUUID", () => {
    it("should accept valid UUIDs", () => {
      const result = validateUUID("550e8400-e29b-41d4-a716-446655440000", "test_id");
      expect(result.success).toBe(true);
      expect(result.data).toBe("550e8400-e29b-41d4-a716-446655440000");
    });

    it("should reject invalid UUIDs", () => {
      const result = validateUUID("not-a-uuid", "test_id");
      expect(result.success).toBe(false);
      expect(result.errors).toContain("test_id must be a valid UUID");
    });

    it("should reject non-string values", () => {
      const result = validateUUID(12345, "test_id");
      expect(result.success).toBe(false);
      expect(result.errors).toContain("test_id must be a string");
    });
  });

  describe("validateString", () => {
    it("should accept valid strings within length limits", () => {
      const result = validateString("hello world", "message", { maxLength: 100 });
      expect(result.success).toBe(true);
      expect(result.data).toBe("hello world");
    });

    it("should trim whitespace", () => {
      const result = validateString("  hello  ", "message");
      expect(result.success).toBe(true);
      expect(result.data).toBe("hello");
    });

    it("should reject strings exceeding max length", () => {
      const result = validateString("a".repeat(101), "message", { maxLength: 100 });
      expect(result.success).toBe(false);
      expect(result.errors).toContain("message must be at most 100 characters");
    });

    it("should handle optional strings", () => {
      const result = validateString(undefined, "message", { optional: true });
      expect(result.success).toBe(true);
      expect(result.data).toBeUndefined();
    });

    it("should require non-optional strings", () => {
      const result = validateString(undefined, "message", { optional: false });
      expect(result.success).toBe(false);
      expect(result.errors).toContain("message is required");
    });
  });

  describe("validateNumber", () => {
    it("should accept valid numbers", () => {
      const result = validateNumber(42, "count");
      expect(result.success).toBe(true);
      expect(result.data).toBe(42);
    });

    it("should respect min/max bounds", () => {
      const result = validateNumber(150, "count", { min: 0, max: 100 });
      expect(result.success).toBe(false);
      expect(result.errors).toContain("count must be at most 100");
    });

    it("should validate integers when required", () => {
      const result = validateNumber(3.14, "count", { integer: true });
      expect(result.success).toBe(false);
      expect(result.errors).toContain("count must be an integer");
    });

    it("should parse string numbers", () => {
      const result = validateNumber("42", "count");
      expect(result.success).toBe(true);
      expect(result.data).toBe(42);
    });
  });

  describe("validateLatitude", () => {
    it("should accept valid latitudes", () => {
      expect(validateLatitude(51.5074).success).toBe(true);
      expect(validateLatitude(-33.8688).success).toBe(true);
      expect(validateLatitude(0).success).toBe(true);
    });

    it("should reject invalid latitudes", () => {
      expect(validateLatitude(91).success).toBe(false);
      expect(validateLatitude(-91).success).toBe(false);
    });
  });

  describe("validateLongitude", () => {
    it("should accept valid longitudes", () => {
      expect(validateLongitude(-0.1278).success).toBe(true);
      expect(validateLongitude(151.2093).success).toBe(true);
      expect(validateLongitude(-180).success).toBe(true);
      expect(validateLongitude(180).success).toBe(true);
    });

    it("should reject invalid longitudes", () => {
      expect(validateLongitude(181).success).toBe(false);
      expect(validateLongitude(-181).success).toBe(false);
    });
  });

  describe("validateEnum", () => {
    it("should accept valid enum values", () => {
      const result = validateEnum("pending", "status", ["pending", "active", "completed"] as const);
      expect(result.success).toBe(true);
      expect(result.data).toBe("pending");
    });

    it("should reject invalid enum values", () => {
      const result = validateEnum("invalid", "status", ["pending", "active", "completed"] as const);
      expect(result.success).toBe(false);
      expect(result.errors).toContain("status must be one of: pending, active, completed");
    });
  });

  describe("validatePaymentMethod", () => {
    it("should accept valid payment methods", () => {
      expect(validatePaymentMethod("CASH").success).toBe(true);
      expect(validatePaymentMethod("CARD").success).toBe(true);
      expect(validatePaymentMethod("WALLET").success).toBe(true);
      expect(validatePaymentMethod("APPLE_PAY").success).toBe(true);
      expect(validatePaymentMethod("GOOGLE_PAY").success).toBe(true);
    });

    it("should reject invalid payment methods", () => {
      expect(validatePaymentMethod("BITCOIN").success).toBe(false);
      expect(validatePaymentMethod("").success).toBe(false);
    });
  });

  describe("Schema Validation", () => {
    describe("acceptTripSchema", () => {
      it("should validate correct accept trip request", () => {
        const result = validateSchema({
          trip_id: "550e8400-e29b-41d4-a716-446655440000",
          driver_id: "660e8400-e29b-41d4-a716-446655440000",
        }, acceptTripSchema);
        
        expect(result.success).toBe(true);
      });

      it("should reject invalid accept trip request", () => {
        const result = validateSchema({
          trip_id: "invalid",
          driver_id: "also-invalid",
        }, acceptTripSchema);
        
        expect(result.success).toBe(false);
        expect(result.errors?.length).toBeGreaterThan(0);
      });
    });

    describe("completeTripSchema", () => {
      it("should validate correct complete trip request", () => {
        const result = validateSchema({
          trip_id: "550e8400-e29b-41d4-a716-446655440000",
          driver_id: "660e8400-e29b-41d4-a716-446655440000",
          final_fare_pence: 1500,
          payment_method: "CARD",
        }, completeTripSchema);
        
        expect(result.success).toBe(true);
      });

      it("should reject negative fare", () => {
        const result = validateSchema({
          trip_id: "550e8400-e29b-41d4-a716-446655440000",
          driver_id: "660e8400-e29b-41d4-a716-446655440000",
          final_fare_pence: -100,
          payment_method: "CARD",
        }, completeTripSchema);
        
        expect(result.success).toBe(false);
      });
    });

    describe("dispatchTripSchema", () => {
      it("should validate correct dispatch request", () => {
        const result = validateSchema({
          trip_id: "550e8400-e29b-41d4-a716-446655440000",
          pickup_lat: 51.5074,
          pickup_lng: -0.1278,
        }, dispatchTripSchema);
        
        expect(result.success).toBe(true);
      });

      it("should accept optional parameters", () => {
        const result = validateSchema({
          trip_id: "550e8400-e29b-41d4-a716-446655440000",
          pickup_lat: 51.5074,
          pickup_lng: -0.1278,
          max_distance_km: 15,
          max_drivers: 10,
          offer_timeout_seconds: 60,
        }, dispatchTripSchema);
        
        expect(result.success).toBe(true);
      });

      it("should reject invalid coordinates", () => {
        const result = validateSchema({
          trip_id: "550e8400-e29b-41d4-a716-446655440000",
          pickup_lat: 100, // Invalid latitude
          pickup_lng: -0.1278,
        }, dispatchTripSchema);
        
        expect(result.success).toBe(false);
      });
    });
  });
});
