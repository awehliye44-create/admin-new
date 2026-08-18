-- Index to support WhatsApp track-lookup: ilike "%<10-digit suffix>" on passenger_phone.
-- Without this the query is a full seq-scan on trips.
create index if not exists trips_passenger_phone_idx
  on public.trips (passenger_phone)
  where passenger_phone is not null;
