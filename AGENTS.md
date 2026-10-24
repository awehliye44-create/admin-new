# Architecture rules

- Trip-specific preset configuration must require the trip's rider, a server-verified admin, or a JWT-linked driver with an unexpired pending `ride_offers` row; always use the trip's stored service area and existing negotiation gates to prevent unrelated access and generic-offer fallback.