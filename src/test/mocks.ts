import { vi } from "vitest";

// Mock Supabase client
export const mockSupabaseClient = {
  auth: {
    getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
    getUser: vi.fn().mockResolvedValue({ data: { user: null }, error: null }),
    signInWithPassword: vi.fn(),
    signUp: vi.fn(),
    signOut: vi.fn(),
    onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
  },
  from: vi.fn().mockReturnValue({
    select: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    not: vi.fn().mockReturnThis(),
    gt: vi.fn().mockReturnThis(),
    gte: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    lte: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
    maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
  }),
  functions: {
    invoke: vi.fn().mockResolvedValue({ data: null, error: null }),
  },
  rpc: vi.fn().mockResolvedValue({ data: null, error: null }),
  channel: vi.fn().mockReturnValue({
    on: vi.fn().mockReturnThis(),
    subscribe: vi.fn().mockReturnValue({ unsubscribe: vi.fn() }),
  }),
};

// Mock for @/integrations/supabase/client
vi.mock("@/integrations/supabase/client", () => ({
  supabase: mockSupabaseClient,
}));

// Mock user for auth tests
export const mockUser = {
  id: "test-user-id",
  email: "test@example.com",
  user_metadata: {
    first_name: "Test",
    last_name: "User",
  },
  app_metadata: {},
  aud: "authenticated",
  created_at: new Date().toISOString(),
};

// Mock session
export const mockSession = {
  access_token: "mock-access-token",
  refresh_token: "mock-refresh-token",
  expires_in: 3600,
  expires_at: Date.now() / 1000 + 3600,
  user: mockUser,
};

// Mock driver data
export const mockDriver = {
  id: "driver-123",
  user_id: "test-user-id",
  first_name: "John",
  last_name: "Driver",
  email: "driver@example.com",
  phone: "+1234567890",
  driver_code: "DR001",
  is_online: true,
  current_lat: 51.5074,
  current_lng: -0.1278,
  approval_status: "approved",
  documents_approved: true,
  rating: 4.8,
  total_trips: 150,
  region_id: "region-123",
};

// Mock trip data
export const mockTrip = {
  id: "trip-123",
  trip_code: "MK001",
  status: "pending",
  pickup_address: "123 Main St",
  pickup_latitude: 51.5074,
  pickup_longitude: -0.1278,
  dropoff_address: "456 Oak Ave",
  dropoff_latitude: 51.5174,
  dropoff_longitude: -0.1378,
  passenger_name: "Jane Rider",
  passenger_phone: "+1987654321",
  estimated_fare: 15.50,
  estimated_distance_km: 5.2,
  estimated_duration_minutes: 15,
  payment_method: "CARD",
  currency: "GBP",
};

// Mock trip offer
export const mockTripOffer = {
  id: "offer-123",
  trip_id: "trip-123",
  driver_id: "driver-123",
  status: "offered",
  distance_km: 1.5,
  priority_score: 85,
  expires_at: new Date(Date.now() + 30000).toISOString(),
  offered_at: new Date().toISOString(),
};

// Helper to create mock query responses
export function createMockQueryResponse<T>(data: T | null, error: Error | null = null) {
  return { data, error };
}

// Helper to reset all mocks
export function resetAllMocks() {
  vi.clearAllMocks();
}
