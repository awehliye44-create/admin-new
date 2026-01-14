export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      admin_settings: {
        Row: {
          created_at: string
          description: string | null
          id: string
          setting_key: string
          setting_value: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          setting_key: string
          setting_value?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          setting_key?: string
          setting_value?: Json
          updated_at?: string
        }
        Relationships: []
      }
      corporate_fare_rules: {
        Row: {
          applies_to_regions: string[] | null
          applies_to_vehicle_types: string[] | null
          booking_restrictions: Json | null
          corporate_account_id: string | null
          created_at: string
          description: string | null
          discount_percentage: number | null
          fare_cap: number | null
          fixed_rate: number | null
          id: string
          is_active: boolean
          name: string
          priority: number | null
          rule_type: string
          time_restrictions: Json | null
          updated_at: string
          valid_from: string | null
          valid_until: string | null
        }
        Insert: {
          applies_to_regions?: string[] | null
          applies_to_vehicle_types?: string[] | null
          booking_restrictions?: Json | null
          corporate_account_id?: string | null
          created_at?: string
          description?: string | null
          discount_percentage?: number | null
          fare_cap?: number | null
          fixed_rate?: number | null
          id?: string
          is_active?: boolean
          name: string
          priority?: number | null
          rule_type?: string
          time_restrictions?: Json | null
          updated_at?: string
          valid_from?: string | null
          valid_until?: string | null
        }
        Update: {
          applies_to_regions?: string[] | null
          applies_to_vehicle_types?: string[] | null
          booking_restrictions?: Json | null
          corporate_account_id?: string | null
          created_at?: string
          description?: string | null
          discount_percentage?: number | null
          fare_cap?: number | null
          fixed_rate?: number | null
          id?: string
          is_active?: boolean
          name?: string
          priority?: number | null
          rule_type?: string
          time_restrictions?: Json | null
          updated_at?: string
          valid_from?: string | null
          valid_until?: string | null
        }
        Relationships: []
      }
      custom_zones: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          geo_boundary: Json | null
          id: string
          is_active: boolean
          name: string
          priority: number | null
          region_id: string | null
          updated_at: string
          zone_type: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          geo_boundary?: Json | null
          id?: string
          is_active?: boolean
          name: string
          priority?: number | null
          region_id?: string | null
          updated_at?: string
          zone_type?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          geo_boundary?: Json | null
          id?: string
          is_active?: boolean
          name?: string
          priority?: number | null
          region_id?: string | null
          updated_at?: string
          zone_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "custom_zones_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          active_trip_id: string | null
          created_at: string
          first_name: string | null
          id: string
          last_name: string | null
          phone: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          active_trip_id?: string | null
          created_at?: string
          first_name?: string | null
          id?: string
          last_name?: string | null
          phone?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          active_trip_id?: string | null
          created_at?: string
          first_name?: string | null
          id?: string
          last_name?: string | null
          phone?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_active_trip_id_fkey"
            columns: ["active_trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      dispatch_settings: {
        Row: {
          accept_timeout_seconds: number
          auto_reassign_enabled: boolean
          auto_retry_attempts: number
          batch_mode: string
          block_multiple_active_rides: boolean
          cancel_protection: boolean
          cascade_batch_size: number
          cascade_step_delay_seconds: number
          cooldown_after_reject_seconds: number
          created_at: string
          driver_fare_display: string
          enable_logging: boolean
          global_timeout_minutes: number
          id: string
          instant_retry_enabled: boolean
          max_advance_days: number
          max_cancel_rate: number
          max_concurrent_offers_per_driver: number
          max_driver_find_time_minutes: number
          max_offer_hops: number
          max_offers_per_request: number
          max_stacked_rides: number
          min_advance_time_minutes: number
          minimum_rating: number
          offer_expiry_seconds: number
          priority_order: string
          scheduled_ride_incentives_enabled: boolean
          scheduled_rides_enabled: boolean
          search_radius_meters: number
          service_area_id: string | null
          simulate_mode: boolean
          stacked_allow_rider_opt_out: boolean
          stacked_driver_incentive: number
          stacked_max_detour_minutes: number
          stacked_min_trip_distance_km: number
          stacked_offer_window_minutes: number
          stacked_priority_mode: string
          stacked_rider_discount: number
          stacked_rides_enabled: boolean
          stacked_search_radius_meters: number
          stacked_show_eta_to_driver: boolean
          suppress_recent_offers_seconds: number
          updated_at: string
          waiting_time_grace_period_minutes: number
        }
        Insert: {
          accept_timeout_seconds?: number
          auto_reassign_enabled?: boolean
          auto_retry_attempts?: number
          batch_mode?: string
          block_multiple_active_rides?: boolean
          cancel_protection?: boolean
          cascade_batch_size?: number
          cascade_step_delay_seconds?: number
          cooldown_after_reject_seconds?: number
          created_at?: string
          driver_fare_display?: string
          enable_logging?: boolean
          global_timeout_minutes?: number
          id?: string
          instant_retry_enabled?: boolean
          max_advance_days?: number
          max_cancel_rate?: number
          max_concurrent_offers_per_driver?: number
          max_driver_find_time_minutes?: number
          max_offer_hops?: number
          max_offers_per_request?: number
          max_stacked_rides?: number
          min_advance_time_minutes?: number
          minimum_rating?: number
          offer_expiry_seconds?: number
          priority_order?: string
          scheduled_ride_incentives_enabled?: boolean
          scheduled_rides_enabled?: boolean
          search_radius_meters?: number
          service_area_id?: string | null
          simulate_mode?: boolean
          stacked_allow_rider_opt_out?: boolean
          stacked_driver_incentive?: number
          stacked_max_detour_minutes?: number
          stacked_min_trip_distance_km?: number
          stacked_offer_window_minutes?: number
          stacked_priority_mode?: string
          stacked_rider_discount?: number
          stacked_rides_enabled?: boolean
          stacked_search_radius_meters?: number
          stacked_show_eta_to_driver?: boolean
          suppress_recent_offers_seconds?: number
          updated_at?: string
          waiting_time_grace_period_minutes?: number
        }
        Update: {
          accept_timeout_seconds?: number
          auto_reassign_enabled?: boolean
          auto_retry_attempts?: number
          batch_mode?: string
          block_multiple_active_rides?: boolean
          cancel_protection?: boolean
          cascade_batch_size?: number
          cascade_step_delay_seconds?: number
          cooldown_after_reject_seconds?: number
          created_at?: string
          driver_fare_display?: string
          enable_logging?: boolean
          global_timeout_minutes?: number
          id?: string
          instant_retry_enabled?: boolean
          max_advance_days?: number
          max_cancel_rate?: number
          max_concurrent_offers_per_driver?: number
          max_driver_find_time_minutes?: number
          max_offer_hops?: number
          max_offers_per_request?: number
          max_stacked_rides?: number
          min_advance_time_minutes?: number
          minimum_rating?: number
          offer_expiry_seconds?: number
          priority_order?: string
          scheduled_ride_incentives_enabled?: boolean
          scheduled_rides_enabled?: boolean
          search_radius_meters?: number
          service_area_id?: string | null
          simulate_mode?: boolean
          stacked_allow_rider_opt_out?: boolean
          stacked_driver_incentive?: number
          stacked_max_detour_minutes?: number
          stacked_min_trip_distance_km?: number
          stacked_offer_window_minutes?: number
          stacked_priority_mode?: string
          stacked_rider_discount?: number
          stacked_rides_enabled?: boolean
          stacked_search_radius_meters?: number
          stacked_show_eta_to_driver?: boolean
          suppress_recent_offers_seconds?: number
          updated_at?: string
          waiting_time_grace_period_minutes?: number
        }
        Relationships: [
          {
            foreignKeyName: "dispatch_settings_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          created_at: string
          document_name: string
          document_type: string
          driver_id: string
          expiry_date: string | null
          file_url: string | null
          id: string
          notes: string | null
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          document_name: string
          document_type: string
          driver_id: string
          expiry_date?: string | null
          file_url?: string | null
          id?: string
          notes?: string | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          document_name?: string
          document_type?: string
          driver_id?: string
          expiry_date?: string | null
          file_url?: string | null
          id?: string
          notes?: string | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "documents_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_categories: {
        Row: {
          color: string | null
          created_at: string
          description: string | null
          display_order: number | null
          icon: string | null
          id: string
          is_active: boolean
          min_rating: number | null
          min_trips: number | null
          name: string
          requirements: string[] | null
          updated_at: string
        }
        Insert: {
          color?: string | null
          created_at?: string
          description?: string | null
          display_order?: number | null
          icon?: string | null
          id?: string
          is_active?: boolean
          min_rating?: number | null
          min_trips?: number | null
          name: string
          requirements?: string[] | null
          updated_at?: string
        }
        Update: {
          color?: string | null
          created_at?: string
          description?: string | null
          display_order?: number | null
          icon?: string | null
          id?: string
          is_active?: boolean
          min_rating?: number | null
          min_trips?: number | null
          name?: string
          requirements?: string[] | null
          updated_at?: string
        }
        Relationships: []
      }
      driver_service_areas: {
        Row: {
          created_at: string
          driver_id: string
          id: string
          service_area_id: string
        }
        Insert: {
          created_at?: string
          driver_id: string
          id?: string
          service_area_id: string
        }
        Update: {
          created_at?: string
          driver_id?: string
          id?: string
          service_area_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_service_areas_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_service_areas_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_service_areas_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_settings: {
        Row: {
          accept_cash: boolean
          auto_accept: boolean
          created_at: string
          driver_id: string
          id: string
          max_pickup_distance_miles: number
          preferred_map_service: string
          sound_alerts: boolean
          theme: string
          towards_destination_active: boolean
          towards_destination_last_reset: string | null
          towards_destination_uses_today: number
          updated_at: string
        }
        Insert: {
          accept_cash?: boolean
          auto_accept?: boolean
          created_at?: string
          driver_id: string
          id?: string
          max_pickup_distance_miles?: number
          preferred_map_service?: string
          sound_alerts?: boolean
          theme?: string
          towards_destination_active?: boolean
          towards_destination_last_reset?: string | null
          towards_destination_uses_today?: number
          updated_at?: string
        }
        Update: {
          accept_cash?: boolean
          auto_accept?: boolean
          created_at?: string
          driver_id?: string
          id?: string
          max_pickup_distance_miles?: number
          preferred_map_service?: string
          sound_alerts?: boolean
          theme?: string
          towards_destination_active?: boolean
          towards_destination_last_reset?: string | null
          towards_destination_uses_today?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_settings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_settings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_vehicle_categories: {
        Row: {
          created_at: string
          driver_id: string
          id: string
          is_enabled: boolean
          updated_at: string
          vehicle_type_id: string
        }
        Insert: {
          created_at?: string
          driver_id: string
          id?: string
          is_enabled?: boolean
          updated_at?: string
          vehicle_type_id: string
        }
        Update: {
          created_at?: string
          driver_id?: string
          id?: string
          is_enabled?: boolean
          updated_at?: string
          vehicle_type_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_vehicle_categories_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_vehicle_categories_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_vehicle_categories_vehicle_type_id_fkey"
            columns: ["vehicle_type_id"]
            isOneToOne: false
            referencedRelation: "vehicle_types"
            referencedColumns: ["id"]
          },
        ]
      }
      drivers: {
        Row: {
          approval_status: string
          created_at: string
          current_lat: number | null
          current_lng: number | null
          current_trip_id: string | null
          documents_approved: boolean
          driver_code: string | null
          email: string
          first_name: string
          heading: number | null
          id: string
          is_online: boolean
          is_pet_friendly: boolean
          last_location_updated_at: string | null
          last_name: string
          phone: string
          profile_photo_url: string | null
          rating: number | null
          region_id: string
          speed: number | null
          total_trips: number | null
          updated_at: string
          user_id: string
        }
        Insert: {
          approval_status?: string
          created_at?: string
          current_lat?: number | null
          current_lng?: number | null
          current_trip_id?: string | null
          documents_approved?: boolean
          driver_code?: string | null
          email: string
          first_name: string
          heading?: number | null
          id?: string
          is_online?: boolean
          is_pet_friendly?: boolean
          last_location_updated_at?: string | null
          last_name: string
          phone: string
          profile_photo_url?: string | null
          rating?: number | null
          region_id: string
          speed?: number | null
          total_trips?: number | null
          updated_at?: string
          user_id: string
        }
        Update: {
          approval_status?: string
          created_at?: string
          current_lat?: number | null
          current_lng?: number | null
          current_trip_id?: string | null
          documents_approved?: boolean
          driver_code?: string | null
          email?: string
          first_name?: string
          heading?: number | null
          id?: string
          is_online?: boolean
          is_pet_friendly?: boolean
          last_location_updated_at?: string | null
          last_name?: string
          phone?: string
          profile_photo_url?: string | null
          rating?: number | null
          region_id?: string
          speed?: number | null
          total_trips?: number | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "drivers_current_trip_id_fkey"
            columns: ["current_trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drivers_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
        ]
      }
      id_sequences: {
        Row: {
          created_at: string
          current_value: number
          id: string
          region_id: string
          sequence_type: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_value?: number
          id?: string
          region_id: string
          sequence_type: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_value?: number
          id?: string
          region_id?: string
          sequence_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      promo_codes: {
        Row: {
          applicable_vehicle_types: string[] | null
          code: string
          created_at: string
          description: string | null
          discount_type: string
          discount_value: number
          id: string
          is_active: boolean
          max_discount: number | null
          min_fare: number | null
          per_user_limit: number | null
          updated_at: string
          usage_count: number
          usage_limit: number | null
          valid_from: string
          valid_until: string | null
        }
        Insert: {
          applicable_vehicle_types?: string[] | null
          code: string
          created_at?: string
          description?: string | null
          discount_type?: string
          discount_value?: number
          id?: string
          is_active?: boolean
          max_discount?: number | null
          min_fare?: number | null
          per_user_limit?: number | null
          updated_at?: string
          usage_count?: number
          usage_limit?: number | null
          valid_from?: string
          valid_until?: string | null
        }
        Update: {
          applicable_vehicle_types?: string[] | null
          code?: string
          created_at?: string
          description?: string | null
          discount_type?: string
          discount_value?: number
          id?: string
          is_active?: boolean
          max_discount?: number | null
          min_fare?: number | null
          per_user_limit?: number | null
          updated_at?: string
          usage_count?: number
          usage_limit?: number | null
          valid_from?: string
          valid_until?: string | null
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          created_at: string
          endpoint: string
          id: string
          keys: Json
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          endpoint: string
          id?: string
          keys: Json
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          endpoint?: string
          id?: string
          keys?: Json
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      region_payment_methods: {
        Row: {
          apple_pay_enabled: boolean
          card_enabled: boolean
          cash_enabled: boolean
          created_at: string
          google_pay_enabled: boolean
          id: string
          region_id: string
          updated_at: string
          wallet_enabled: boolean
        }
        Insert: {
          apple_pay_enabled?: boolean
          card_enabled?: boolean
          cash_enabled?: boolean
          created_at?: string
          google_pay_enabled?: boolean
          id?: string
          region_id: string
          updated_at?: string
          wallet_enabled?: boolean
        }
        Update: {
          apple_pay_enabled?: boolean
          card_enabled?: boolean
          cash_enabled?: boolean
          created_at?: string
          google_pay_enabled?: boolean
          id?: string
          region_id?: string
          updated_at?: string
          wallet_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "region_payment_methods_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: true
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
        ]
      }
      regions: {
        Row: {
          created_at: string
          currency_code: string
          distance_unit: string
          geo_boundary: Json | null
          id: string
          name: string
          status: string
          timezone: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          currency_code?: string
          distance_unit?: string
          geo_boundary?: Json | null
          id?: string
          name: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          currency_code?: string
          distance_unit?: string
          geo_boundary?: Json | null
          id?: string
          name?: string
          status?: string
          timezone?: string
          updated_at?: string
        }
        Relationships: []
      }
      rider_feedback: {
        Row: {
          admin_notes: string | null
          comment: string | null
          created_at: string
          customer_id: string
          driver_id: string | null
          feedback_type: string | null
          id: string
          rating: number
          status: string | null
          trip_id: string | null
          updated_at: string
        }
        Insert: {
          admin_notes?: string | null
          comment?: string | null
          created_at?: string
          customer_id: string
          driver_id?: string | null
          feedback_type?: string | null
          id?: string
          rating: number
          status?: string | null
          trip_id?: string | null
          updated_at?: string
        }
        Update: {
          admin_notes?: string | null
          comment?: string | null
          created_at?: string
          customer_id?: string
          driver_id?: string | null
          feedback_type?: string | null
          id?: string
          rating?: number
          status?: string | null
          trip_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rider_feedback_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "rider_feedback_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rider_feedback_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      service_area_cancellation_fees: {
        Row: {
          cancellation_fee: number
          created_at: string
          currency_code: string
          free_cancellation_window_minutes: number
          id: string
          no_show_fee: number
          service_area_id: string
          updated_at: string
        }
        Insert: {
          cancellation_fee?: number
          created_at?: string
          currency_code?: string
          free_cancellation_window_minutes?: number
          id?: string
          no_show_fee?: number
          service_area_id: string
          updated_at?: string
        }
        Update: {
          cancellation_fee?: number
          created_at?: string
          currency_code?: string
          free_cancellation_window_minutes?: number
          id?: string
          no_show_fee?: number
          service_area_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_area_cancellation_fees_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: true
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      service_area_payment_methods: {
        Row: {
          apple_pay_enabled: boolean
          card_enabled: boolean
          cash_enabled: boolean
          created_at: string
          google_pay_enabled: boolean
          id: string
          service_area_id: string
          updated_at: string
          wallet_enabled: boolean
        }
        Insert: {
          apple_pay_enabled?: boolean
          card_enabled?: boolean
          cash_enabled?: boolean
          created_at?: string
          google_pay_enabled?: boolean
          id?: string
          service_area_id: string
          updated_at?: string
          wallet_enabled?: boolean
        }
        Update: {
          apple_pay_enabled?: boolean
          card_enabled?: boolean
          cash_enabled?: boolean
          created_at?: string
          google_pay_enabled?: boolean
          id?: string
          service_area_id?: string
          updated_at?: string
          wallet_enabled?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "service_area_payment_methods_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: true
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      service_area_vehicle_pricing: {
        Row: {
          base_fare: number
          commission_percentage: number
          created_at: string
          currency_code: string
          distance_pricing: Json
          id: string
          is_enabled: boolean
          minimum_fare: number
          pickup_waiting_charges: Json
          service_area_id: string
          stops_waiting_charges: Json
          time_pricing: Json
          updated_at: string
          vehicle_type_id: string
        }
        Insert: {
          base_fare?: number
          commission_percentage?: number
          created_at?: string
          currency_code?: string
          distance_pricing?: Json
          id?: string
          is_enabled?: boolean
          minimum_fare?: number
          pickup_waiting_charges?: Json
          service_area_id: string
          stops_waiting_charges?: Json
          time_pricing?: Json
          updated_at?: string
          vehicle_type_id: string
        }
        Update: {
          base_fare?: number
          commission_percentage?: number
          created_at?: string
          currency_code?: string
          distance_pricing?: Json
          id?: string
          is_enabled?: boolean
          minimum_fare?: number
          pickup_waiting_charges?: Json
          service_area_id?: string
          stops_waiting_charges?: Json
          time_pricing?: Json
          updated_at?: string
          vehicle_type_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_area_vehicle_pricing_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_area_vehicle_pricing_vehicle_type_id_fkey"
            columns: ["vehicle_type_id"]
            isOneToOne: false
            referencedRelation: "vehicle_types"
            referencedColumns: ["id"]
          },
        ]
      }
      service_areas: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          region_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          region_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          region_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_areas_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_stops: {
        Row: {
          address: string
          arrived_at: string | null
          completed_at: string | null
          created_at: string
          id: string
          lat: number | null
          lng: number | null
          status: string
          stop_index: number
          trip_id: string
          type: string
          updated_at: string
        }
        Insert: {
          address: string
          arrived_at?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          lat?: number | null
          lng?: number | null
          status?: string
          stop_index: number
          trip_id: string
          type: string
          updated_at?: string
        }
        Update: {
          address?: string
          arrived_at?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          lat?: number | null
          lng?: number | null
          status?: string
          stop_index?: number
          trip_id?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_stops_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trips: {
        Row: {
          client_action_id: string | null
          completed_at: string | null
          confirm_deadline_at: string | null
          confirmed_driver_id: string | null
          created_at: string
          currency: string | null
          currency_code: string | null
          current_stop_index: number | null
          dispatch_mode: string | null
          driver_confirm_deadline_at: string | null
          driver_id: string | null
          driver_location_lat: number | null
          driver_location_lng: number | null
          dropoff_address: string
          dropoff_latitude: number | null
          dropoff_longitude: number | null
          escalation_status: string | null
          estimated_distance_km: number | null
          estimated_duration_minutes: number | null
          estimated_fare: number | null
          fare: number | null
          id: string
          is_scheduled: boolean | null
          job_type: string | null
          passenger_id: string
          passenger_name: string | null
          passenger_phone: string | null
          payment_method: string | null
          payment_status: string | null
          payment_type: string | null
          pickup_address: string
          pickup_latitude: number | null
          pickup_longitude: number | null
          pre_assigned_driver_id: string | null
          qr_session_id: string | null
          scheduled_at: string | null
          scheduled_broadcast_at: string | null
          scheduled_convert_at: string | null
          scheduled_status: string | null
          special_instructions: string | null
          started_at: string | null
          status: string | null
          stops: Json | null
          surge_multiplier: number | null
          total_stops: number | null
          trip_code: string | null
          trip_type: string | null
          updated_at: string
        }
        Insert: {
          client_action_id?: string | null
          completed_at?: string | null
          confirm_deadline_at?: string | null
          confirmed_driver_id?: string | null
          created_at?: string
          currency?: string | null
          currency_code?: string | null
          current_stop_index?: number | null
          dispatch_mode?: string | null
          driver_confirm_deadline_at?: string | null
          driver_id?: string | null
          driver_location_lat?: number | null
          driver_location_lng?: number | null
          dropoff_address: string
          dropoff_latitude?: number | null
          dropoff_longitude?: number | null
          escalation_status?: string | null
          estimated_distance_km?: number | null
          estimated_duration_minutes?: number | null
          estimated_fare?: number | null
          fare?: number | null
          id?: string
          is_scheduled?: boolean | null
          job_type?: string | null
          passenger_id: string
          passenger_name?: string | null
          passenger_phone?: string | null
          payment_method?: string | null
          payment_status?: string | null
          payment_type?: string | null
          pickup_address: string
          pickup_latitude?: number | null
          pickup_longitude?: number | null
          pre_assigned_driver_id?: string | null
          qr_session_id?: string | null
          scheduled_at?: string | null
          scheduled_broadcast_at?: string | null
          scheduled_convert_at?: string | null
          scheduled_status?: string | null
          special_instructions?: string | null
          started_at?: string | null
          status?: string | null
          stops?: Json | null
          surge_multiplier?: number | null
          total_stops?: number | null
          trip_code?: string | null
          trip_type?: string | null
          updated_at?: string
        }
        Update: {
          client_action_id?: string | null
          completed_at?: string | null
          confirm_deadline_at?: string | null
          confirmed_driver_id?: string | null
          created_at?: string
          currency?: string | null
          currency_code?: string | null
          current_stop_index?: number | null
          dispatch_mode?: string | null
          driver_confirm_deadline_at?: string | null
          driver_id?: string | null
          driver_location_lat?: number | null
          driver_location_lng?: number | null
          dropoff_address?: string
          dropoff_latitude?: number | null
          dropoff_longitude?: number | null
          escalation_status?: string | null
          estimated_distance_km?: number | null
          estimated_duration_minutes?: number | null
          estimated_fare?: number | null
          fare?: number | null
          id?: string
          is_scheduled?: boolean | null
          job_type?: string | null
          passenger_id?: string
          passenger_name?: string | null
          passenger_phone?: string | null
          payment_method?: string | null
          payment_status?: string | null
          payment_type?: string | null
          pickup_address?: string
          pickup_latitude?: number | null
          pickup_longitude?: number | null
          pre_assigned_driver_id?: string | null
          qr_session_id?: string | null
          scheduled_at?: string | null
          scheduled_broadcast_at?: string | null
          scheduled_convert_at?: string | null
          scheduled_status?: string | null
          special_instructions?: string | null
          started_at?: string | null
          status?: string | null
          stops?: Json | null
          surge_multiplier?: number | null
          total_stops?: number | null
          trip_code?: string | null
          trip_type?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trips_confirmed_driver_id_fkey"
            columns: ["confirmed_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_confirmed_driver_id_fkey"
            columns: ["confirmed_driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_pre_assigned_driver_id_fkey"
            columns: ["pre_assigned_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_pre_assigned_driver_id_fkey"
            columns: ["pre_assigned_driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      vehicle_types: {
        Row: {
          capacity: number
          categories: string[] | null
          created_at: string
          description: string | null
          display_order: number | null
          features: string[] | null
          icon: string | null
          id: string
          is_active: boolean
          name: string
          slug: string
          updated_at: string
        }
        Insert: {
          capacity?: number
          categories?: string[] | null
          created_at?: string
          description?: string | null
          display_order?: number | null
          features?: string[] | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name: string
          slug: string
          updated_at?: string
        }
        Update: {
          capacity?: number
          categories?: string[] | null
          created_at?: string
          description?: string | null
          display_order?: number | null
          features?: string[] | null
          icon?: string | null
          id?: string
          is_active?: boolean
          name?: string
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      vehicles: {
        Row: {
          approval_status: string
          capacity: number
          color: string
          created_at: string
          driver_id: string
          id: string
          is_primary: boolean
          license_plate: string
          make: string
          model: string
          rejection_reason: string | null
          updated_at: string
          vehicle_type_id: string | null
          year: number
        }
        Insert: {
          approval_status?: string
          capacity?: number
          color: string
          created_at?: string
          driver_id: string
          id?: string
          is_primary?: boolean
          license_plate: string
          make: string
          model: string
          rejection_reason?: string | null
          updated_at?: string
          vehicle_type_id?: string | null
          year: number
        }
        Update: {
          approval_status?: string
          capacity?: number
          color?: string
          created_at?: string
          driver_id?: string
          id?: string
          is_primary?: boolean
          license_plate?: string
          make?: string
          model?: string
          rejection_reason?: string | null
          updated_at?: string
          vehicle_type_id?: string | null
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "vehicles_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "vehicles_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicles_vehicle_type_id_fkey"
            columns: ["vehicle_type_id"]
            isOneToOne: false
            referencedRelation: "vehicle_types"
            referencedColumns: ["id"]
          },
        ]
      }
      zone_pricing_rules: {
        Row: {
          applies_to: string
          created_at: string
          id: string
          is_active: boolean
          max_fare: number | null
          min_fare: number | null
          rule_type: string
          time_restrictions: Json | null
          updated_at: string
          value: number
          vehicle_type_id: string | null
          zone_id: string
        }
        Insert: {
          applies_to?: string
          created_at?: string
          id?: string
          is_active?: boolean
          max_fare?: number | null
          min_fare?: number | null
          rule_type?: string
          time_restrictions?: Json | null
          updated_at?: string
          value?: number
          vehicle_type_id?: string | null
          zone_id: string
        }
        Update: {
          applies_to?: string
          created_at?: string
          id?: string
          is_active?: boolean
          max_fare?: number | null
          min_fare?: number | null
          rule_type?: string
          time_restrictions?: Json | null
          updated_at?: string
          value?: number
          vehicle_type_id?: string | null
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "zone_pricing_rules_vehicle_type_id_fkey"
            columns: ["vehicle_type_id"]
            isOneToOne: false
            referencedRelation: "vehicle_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_pricing_rules_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "custom_zones"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      driver_document_status: {
        Row: {
          approval_status: string | null
          approved_docs: number | null
          document_status: string | null
          documents_approved: boolean | null
          driver_id: string | null
          first_name: string | null
          last_name: string | null
          pending_docs: number | null
          rejected_docs: number | null
          required_docs_count: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      can_passenger_view_driver: {
        Args: { p_driver_id: string }
        Returns: boolean
      }
      can_passenger_view_driver_document: {
        Args: { p_document_type: string; p_driver_id: string }
        Returns: boolean
      }
      can_passenger_view_vehicle: {
        Args: { p_driver_id: string }
        Returns: boolean
      }
      check_driver_documents_approved: {
        Args: { p_driver_id: string }
        Returns: boolean
      }
      create_driver_vehicle: {
        Args: {
          p_color: string
          p_driver_id: string
          p_license_plate: string
          p_make: string
          p_model: string
          p_year: number
        }
        Returns: string
      }
      get_region_code: { Args: { p_region_id: string }; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      update_driver_location: {
        Args: {
          p_driver_id: string
          p_heading?: number
          p_lat: number
          p_lng: number
          p_speed?: number
        }
        Returns: Json
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
    },
  },
} as const
