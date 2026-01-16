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
      corporate_account_requests: {
        Row: {
          address: string | null
          city: string | null
          company_name: string
          contact_email: string
          contact_name: string
          contact_phone: string | null
          country: string | null
          created_at: string
          employee_count: number | null
          estimated_monthly_trips: number | null
          id: string
          notes: string | null
          region_id: string | null
          rejection_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          service_area_id: string | null
          status: string
          tax_id: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          city?: string | null
          company_name: string
          contact_email: string
          contact_name: string
          contact_phone?: string | null
          country?: string | null
          created_at?: string
          employee_count?: number | null
          estimated_monthly_trips?: number | null
          id?: string
          notes?: string | null
          region_id?: string | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          service_area_id?: string | null
          status?: string
          tax_id?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          city?: string | null
          company_name?: string
          contact_email?: string
          contact_name?: string
          contact_phone?: string | null
          country?: string | null
          created_at?: string
          employee_count?: number | null
          estimated_monthly_trips?: number | null
          id?: string
          notes?: string | null
          region_id?: string | null
          rejection_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          service_area_id?: string | null
          status?: string
          tax_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "corporate_account_requests_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "corporate_account_requests_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      corporate_accounts: {
        Row: {
          address: string | null
          billing_email: string | null
          city: string | null
          company_name: string
          contact_email: string
          contact_name: string
          contact_phone: string | null
          country: string | null
          created_at: string
          credit_limit: number | null
          current_balance: number | null
          discount_percentage: number | null
          employee_count: number | null
          id: string
          monthly_budget: number | null
          notes: string | null
          payment_terms: string | null
          region_id: string | null
          service_area_id: string | null
          status: string
          tax_id: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          billing_email?: string | null
          city?: string | null
          company_name: string
          contact_email: string
          contact_name: string
          contact_phone?: string | null
          country?: string | null
          created_at?: string
          credit_limit?: number | null
          current_balance?: number | null
          discount_percentage?: number | null
          employee_count?: number | null
          id?: string
          monthly_budget?: number | null
          notes?: string | null
          payment_terms?: string | null
          region_id?: string | null
          service_area_id?: string | null
          status?: string
          tax_id?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          billing_email?: string | null
          city?: string | null
          company_name?: string
          contact_email?: string
          contact_name?: string
          contact_phone?: string | null
          country?: string | null
          created_at?: string
          credit_limit?: number | null
          current_balance?: number | null
          discount_percentage?: number | null
          employee_count?: number | null
          id?: string
          monthly_budget?: number | null
          notes?: string | null
          payment_terms?: string | null
          region_id?: string | null
          service_area_id?: string | null
          status?: string
          tax_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "corporate_accounts_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "corporate_accounts_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
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
      corporate_invoices: {
        Row: {
          amount: number
          billing_period_end: string | null
          billing_period_start: string | null
          corporate_account_id: string
          created_at: string
          due_date: string
          id: string
          invoice_number: string
          notes: string | null
          paid_at: string | null
          region_id: string | null
          service_area_id: string | null
          status: string
          tax_amount: number | null
          total_amount: number
          trip_count: number | null
          updated_at: string
        }
        Insert: {
          amount?: number
          billing_period_end?: string | null
          billing_period_start?: string | null
          corporate_account_id: string
          created_at?: string
          due_date: string
          id?: string
          invoice_number: string
          notes?: string | null
          paid_at?: string | null
          region_id?: string | null
          service_area_id?: string | null
          status?: string
          tax_amount?: number | null
          total_amount?: number
          trip_count?: number | null
          updated_at?: string
        }
        Update: {
          amount?: number
          billing_period_end?: string | null
          billing_period_start?: string | null
          corporate_account_id?: string
          created_at?: string
          due_date?: string
          id?: string
          invoice_number?: string
          notes?: string | null
          paid_at?: string | null
          region_id?: string | null
          service_area_id?: string | null
          status?: string
          tax_amount?: number | null
          total_amount?: number
          trip_count?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "corporate_invoices_corporate_account_id_fkey"
            columns: ["corporate_account_id"]
            isOneToOne: false
            referencedRelation: "corporate_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "corporate_invoices_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "corporate_invoices_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      custom_zones: {
        Row: {
          center_lat: number | null
          center_lng: number | null
          color: string | null
          created_at: string
          description: string | null
          geo_boundary: Json | null
          id: string
          is_active: boolean
          metadata: Json | null
          name: string
          priority: number | null
          radius_meters: number | null
          region_id: string | null
          service_area_id: string | null
          shape_type: string
          updated_at: string
          zone_type: string
        }
        Insert: {
          center_lat?: number | null
          center_lng?: number | null
          color?: string | null
          created_at?: string
          description?: string | null
          geo_boundary?: Json | null
          id?: string
          is_active?: boolean
          metadata?: Json | null
          name: string
          priority?: number | null
          radius_meters?: number | null
          region_id?: string | null
          service_area_id?: string | null
          shape_type?: string
          updated_at?: string
          zone_type?: string
        }
        Update: {
          center_lat?: number | null
          center_lng?: number | null
          color?: string | null
          created_at?: string
          description?: string | null
          geo_boundary?: Json | null
          id?: string
          is_active?: boolean
          metadata?: Json | null
          name?: string
          priority?: number | null
          radius_meters?: number | null
          region_id?: string | null
          service_area_id?: string | null
          shape_type?: string
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
          {
            foreignKeyName: "custom_zones_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_push_tokens: {
        Row: {
          app_type: string
          created_at: string
          id: string
          platform: string
          token: string
          updated_at: string
          user_id: string
        }
        Insert: {
          app_type?: string
          created_at?: string
          id?: string
          platform: string
          token: string
          updated_at?: string
          user_id: string
        }
        Update: {
          app_type?: string
          created_at?: string
          id?: string
          platform?: string
          token?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
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
      document_types: {
        Row: {
          created_at: string
          description: string | null
          display_order: number | null
          has_expiry: boolean
          id: string
          is_active: boolean
          is_required: boolean
          name: string
          reminder_days_before_expiry: number[]
          slug: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          display_order?: number | null
          has_expiry?: boolean
          id?: string
          is_active?: boolean
          is_required?: boolean
          name: string
          reminder_days_before_expiry?: number[]
          slug: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          display_order?: number | null
          has_expiry?: boolean
          id?: string
          is_active?: boolean
          is_required?: boolean
          name?: string
          reminder_days_before_expiry?: number[]
          slug?: string
          updated_at?: string
        }
        Relationships: []
      }
      documents: {
        Row: {
          created_at: string
          document_name: string
          document_type: string
          document_type_id: string | null
          driver_id: string
          expiry_date: string | null
          file_url: string | null
          id: string
          last_reminded_at: string | null
          notes: string | null
          rejection_reason: string | null
          reminder_sent_days: number[] | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          document_name: string
          document_type: string
          document_type_id?: string | null
          driver_id: string
          expiry_date?: string | null
          file_url?: string | null
          id?: string
          last_reminded_at?: string | null
          notes?: string | null
          rejection_reason?: string | null
          reminder_sent_days?: number[] | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          document_name?: string
          document_type?: string
          document_type_id?: string | null
          driver_id?: string
          expiry_date?: string | null
          file_url?: string | null
          id?: string
          last_reminded_at?: string | null
          notes?: string | null
          rejection_reason?: string | null
          reminder_sent_days?: number[] | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "documents_document_type_id_fkey"
            columns: ["document_type_id"]
            isOneToOne: false
            referencedRelation: "document_types"
            referencedColumns: ["id"]
          },
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
            referencedRelation: "driver_wallet_balance"
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
      driver_inbox_messages: {
        Row: {
          body: string
          created_at: string
          document_id: string | null
          document_type_id: string | null
          driver_id: string
          expiry_date: string | null
          id: string
          is_read: boolean
          metadata: Json | null
          title: string
          type: string
          updated_at: string
        }
        Insert: {
          body: string
          created_at?: string
          document_id?: string | null
          document_type_id?: string | null
          driver_id: string
          expiry_date?: string | null
          id?: string
          is_read?: boolean
          metadata?: Json | null
          title: string
          type?: string
          updated_at?: string
        }
        Update: {
          body?: string
          created_at?: string
          document_id?: string | null
          document_type_id?: string | null
          driver_id?: string
          expiry_date?: string | null
          id?: string
          is_read?: boolean
          metadata?: Json | null
          title?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_inbox_messages_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_inbox_messages_document_type_id_fkey"
            columns: ["document_type_id"]
            isOneToOne: false
            referencedRelation: "document_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_inbox_messages_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_inbox_messages_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_inbox_messages_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_ledger: {
        Row: {
          amount_pence: number
          created_at: string
          currency_code: string
          description: string | null
          driver_id: string
          entry_type: string
          id: string
          reference_id: string | null
          trip_id: string | null
        }
        Insert: {
          amount_pence: number
          created_at?: string
          currency_code?: string
          description?: string | null
          driver_id: string
          entry_type: string
          id?: string
          reference_id?: string | null
          trip_id?: string | null
        }
        Update: {
          amount_pence?: number
          created_at?: string
          currency_code?: string
          description?: string | null
          driver_id?: string
          entry_type?: string
          id?: string
          reference_id?: string | null
          trip_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_ledger_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
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
            referencedRelation: "driver_wallet_balance"
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
            referencedRelation: "driver_wallet_balance"
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
            referencedRelation: "driver_wallet_balance"
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
          vehicle_edit_request_status: string | null
          vehicle_locked: boolean
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
          vehicle_edit_request_status?: string | null
          vehicle_locked?: boolean
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
          vehicle_edit_request_status?: string | null
          vehicle_locked?: boolean
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
      geofence_events: {
        Row: {
          created_at: string
          driver_id: string
          event_type: string
          id: string
          lat: number
          lng: number
          trip_id: string | null
          zone_id: string
        }
        Insert: {
          created_at?: string
          driver_id: string
          event_type: string
          id?: string
          lat: number
          lng: number
          trip_id?: string | null
          zone_id: string
        }
        Update: {
          created_at?: string
          driver_id?: string
          event_type?: string
          id?: string
          lat?: number
          lng?: number
          trip_id?: string | null
          zone_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "geofence_events_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "geofence_events_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "geofence_events_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "geofence_events_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "geofence_events_zone_id_fkey"
            columns: ["zone_id"]
            isOneToOne: false
            referencedRelation: "custom_zones"
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
      lost_property_cases: {
        Row: {
          case_number: string
          closed_at: string | null
          collected_at: string | null
          created_at: string
          customer_id: string
          driver_id: string | null
          driver_responded_at: string | null
          id: string
          item_category: string
          item_description: string
          item_found_at: string | null
          photos: string[] | null
          region_id: string
          return_method: string | null
          return_trip_id: string | null
          same_driver_requested: boolean | null
          service_area_id: string | null
          status: string
          trip_id: string
          updated_at: string
        }
        Insert: {
          case_number: string
          closed_at?: string | null
          collected_at?: string | null
          created_at?: string
          customer_id: string
          driver_id?: string | null
          driver_responded_at?: string | null
          id?: string
          item_category: string
          item_description: string
          item_found_at?: string | null
          photos?: string[] | null
          region_id: string
          return_method?: string | null
          return_trip_id?: string | null
          same_driver_requested?: boolean | null
          service_area_id?: string | null
          status?: string
          trip_id: string
          updated_at?: string
        }
        Update: {
          case_number?: string
          closed_at?: string | null
          collected_at?: string | null
          created_at?: string
          customer_id?: string
          driver_id?: string | null
          driver_responded_at?: string | null
          id?: string
          item_category?: string
          item_description?: string
          item_found_at?: string | null
          photos?: string[] | null
          region_id?: string
          return_method?: string | null
          return_trip_id?: string | null
          same_driver_requested?: boolean | null
          service_area_id?: string | null
          status?: string
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lost_property_cases_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "lost_property_cases_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "lost_property_cases_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lost_property_cases_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lost_property_cases_return_trip_id_fkey"
            columns: ["return_trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lost_property_cases_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lost_property_cases_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      lost_property_messages: {
        Row: {
          case_id: string
          created_at: string
          id: string
          message: string
          sender_id: string | null
          sender_type: string
        }
        Insert: {
          case_id: string
          created_at?: string
          id?: string
          message: string
          sender_id?: string | null
          sender_type: string
        }
        Update: {
          case_id?: string
          created_at?: string
          id?: string
          message?: string
          sender_id?: string | null
          sender_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "lost_property_messages_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "lost_property_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      lost_property_sequences: {
        Row: {
          created_at: string
          current_value: number
          id: string
          service_area_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_value?: number
          id?: string
          service_area_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_value?: number
          id?: string
          service_area_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lost_property_sequences_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: true
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      lost_property_status_history: {
        Row: {
          case_id: string
          changed_by: string | null
          changed_by_type: string | null
          created_at: string
          id: string
          new_status: string
          notes: string | null
          old_status: string | null
        }
        Insert: {
          case_id: string
          changed_by?: string | null
          changed_by_type?: string | null
          created_at?: string
          id?: string
          new_status: string
          notes?: string | null
          old_status?: string | null
        }
        Update: {
          case_id?: string
          changed_by?: string | null
          changed_by_type?: string | null
          created_at?: string
          id?: string
          new_status?: string
          notes?: string | null
          old_status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lost_property_status_history_case_id_fkey"
            columns: ["case_id"]
            isOneToOne: false
            referencedRelation: "lost_property_cases"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_settings: {
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
      notification_templates: {
        Row: {
          category: string
          created_at: string
          id: string
          is_active: boolean
          message_template: string
          name: string
          priority: string
          title_template: string
          type: string
          updated_at: string
        }
        Insert: {
          category?: string
          created_at?: string
          id?: string
          is_active?: boolean
          message_template: string
          name: string
          priority?: string
          title_template: string
          type?: string
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          id?: string
          is_active?: boolean
          message_template?: string
          name?: string
          priority?: string
          title_template?: string
          type?: string
          updated_at?: string
        }
        Relationships: []
      }
      notifications: {
        Row: {
          action_label: string | null
          action_url: string | null
          category: string
          created_at: string
          created_by: string | null
          expires_at: string | null
          id: string
          is_dismissed: boolean
          is_read: boolean
          message: string
          metadata: Json | null
          priority: string
          target_audience: string
          target_region_id: string | null
          target_service_area_id: string | null
          target_user_id: string | null
          title: string
          type: string
          updated_at: string
        }
        Insert: {
          action_label?: string | null
          action_url?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          is_dismissed?: boolean
          is_read?: boolean
          message: string
          metadata?: Json | null
          priority?: string
          target_audience?: string
          target_region_id?: string | null
          target_service_area_id?: string | null
          target_user_id?: string | null
          title: string
          type?: string
          updated_at?: string
        }
        Update: {
          action_label?: string | null
          action_url?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          expires_at?: string | null
          id?: string
          is_dismissed?: boolean
          is_read?: boolean
          message?: string
          metadata?: Json | null
          priority?: string
          target_audience?: string
          target_region_id?: string | null
          target_service_area_id?: string | null
          target_user_id?: string | null
          title?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_target_region_id_fkey"
            columns: ["target_region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notifications_target_service_area_id_fkey"
            columns: ["target_service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
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
      push_tokens: {
        Row: {
          app_type: string
          created_at: string
          driver_id: string
          id: string
          platform: string
          token: string
          updated_at: string
        }
        Insert: {
          app_type?: string
          created_at?: string
          driver_id: string
          id?: string
          platform: string
          token: string
          updated_at?: string
        }
        Update: {
          app_type?: string
          created_at?: string
          driver_id?: string
          id?: string
          platform?: string
          token?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_tokens_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "push_tokens_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "push_tokens_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
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
      ride_offers: {
        Row: {
          broadcast_round: number
          created_at: string
          distance_meters: number | null
          driver_id: string
          eta_seconds: number | null
          expires_at: string
          id: string
          offered_at: string
          responded_at: string | null
          status: string
          trip_id: string
          updated_at: string
        }
        Insert: {
          broadcast_round?: number
          created_at?: string
          distance_meters?: number | null
          driver_id: string
          eta_seconds?: number | null
          expires_at: string
          id?: string
          offered_at?: string
          responded_at?: string | null
          status?: string
          trip_id: string
          updated_at?: string
        }
        Update: {
          broadcast_round?: number
          created_at?: string
          distance_meters?: number | null
          driver_id?: string
          eta_seconds?: number | null
          expires_at?: string
          id?: string
          offered_at?: string
          responded_at?: string | null
          status?: string
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ride_offers_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "ride_offers_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "ride_offers_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_offers_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
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
            referencedRelation: "driver_wallet_balance"
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
      service_area_sequences: {
        Row: {
          created_at: string
          current_value: number
          id: string
          sequence_type: string
          service_area_code: string
          service_area_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_value?: number
          id?: string
          sequence_type?: string
          service_area_code: string
          service_area_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_value?: number
          id?: string
          sequence_type?: string
          service_area_code?: string
          service_area_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_area_sequences_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
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
          code: string | null
          country: string | null
          created_at: string
          currency_code: string | null
          distance_unit: string | null
          geo_boundary: Json | null
          id: string
          is_active: boolean
          name: string
          region_id: string
          timezone: string | null
          updated_at: string
        }
        Insert: {
          code?: string | null
          country?: string | null
          created_at?: string
          currency_code?: string | null
          distance_unit?: string | null
          geo_boundary?: Json | null
          id?: string
          is_active?: boolean
          name: string
          region_id: string
          timezone?: string | null
          updated_at?: string
        }
        Update: {
          code?: string | null
          country?: string | null
          created_at?: string
          currency_code?: string | null
          distance_unit?: string | null
          geo_boundary?: Json | null
          id?: string
          is_active?: boolean
          name?: string
          region_id?: string
          timezone?: string | null
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
      trip_offers: {
        Row: {
          created_at: string
          distance_km: number | null
          driver_id: string
          expires_at: string
          id: string
          offered_at: string
          priority_score: number | null
          responded_at: string | null
          status: string
          trip_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          distance_km?: number | null
          driver_id: string
          expires_at: string
          id?: string
          offered_at?: string
          priority_score?: number | null
          responded_at?: string | null
          status?: string
          trip_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          distance_km?: number | null
          driver_id?: string
          expires_at?: string
          id?: string
          offered_at?: string
          priority_score?: number | null
          responded_at?: string | null
          status?: string
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_offers_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trip_offers_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trip_offers_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_offers_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
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
          arrived_at: string | null
          broadcast_started_at: string | null
          client_action_id: string | null
          commission_pence: number | null
          completed_at: string | null
          confirm_deadline_at: string | null
          confirmed_driver_id: string | null
          created_at: string
          currency: string | null
          currency_code: string | null
          current_broadcast_round: number | null
          current_stop_index: number | null
          dispatch_mode: string | null
          dispatch_status: string | null
          driver_confirm_deadline_at: string | null
          driver_id: string | null
          driver_location_lat: number | null
          driver_location_lng: number | null
          driver_net_pence: number | null
          dropoff_address: string
          dropoff_latitude: number | null
          dropoff_longitude: number | null
          dropoff_zone_id: string | null
          escalation_status: string | null
          estimated_distance_km: number | null
          estimated_duration_minutes: number | null
          estimated_fare: number | null
          fare: number | null
          gross_fare_pence: number | null
          id: string
          is_scheduled: boolean | null
          job_type: string | null
          last_broadcast_at: string | null
          max_broadcast_rounds: number | null
          passenger_id: string
          passenger_name: string | null
          passenger_phone: string | null
          payment_method: string | null
          payment_status: string | null
          payment_type: string | null
          pickup_address: string
          pickup_latitude: number | null
          pickup_longitude: number | null
          pickup_zone_id: string | null
          pre_assigned_driver_id: string | null
          qr_session_id: string | null
          scheduled_at: string | null
          scheduled_broadcast_at: string | null
          scheduled_convert_at: string | null
          scheduled_status: string | null
          sequence_no: number | null
          service_area_code: string | null
          service_area_id: string | null
          special_instructions: string | null
          started_at: string | null
          status: string | null
          stops: Json | null
          stripe_payment_intent_id: string | null
          surge_multiplier: number | null
          total_stops: number | null
          trip_code: string | null
          trip_number: string | null
          trip_type: string | null
          updated_at: string
          vehicle_type: string | null
        }
        Insert: {
          arrived_at?: string | null
          broadcast_started_at?: string | null
          client_action_id?: string | null
          commission_pence?: number | null
          completed_at?: string | null
          confirm_deadline_at?: string | null
          confirmed_driver_id?: string | null
          created_at?: string
          currency?: string | null
          currency_code?: string | null
          current_broadcast_round?: number | null
          current_stop_index?: number | null
          dispatch_mode?: string | null
          dispatch_status?: string | null
          driver_confirm_deadline_at?: string | null
          driver_id?: string | null
          driver_location_lat?: number | null
          driver_location_lng?: number | null
          driver_net_pence?: number | null
          dropoff_address: string
          dropoff_latitude?: number | null
          dropoff_longitude?: number | null
          dropoff_zone_id?: string | null
          escalation_status?: string | null
          estimated_distance_km?: number | null
          estimated_duration_minutes?: number | null
          estimated_fare?: number | null
          fare?: number | null
          gross_fare_pence?: number | null
          id?: string
          is_scheduled?: boolean | null
          job_type?: string | null
          last_broadcast_at?: string | null
          max_broadcast_rounds?: number | null
          passenger_id: string
          passenger_name?: string | null
          passenger_phone?: string | null
          payment_method?: string | null
          payment_status?: string | null
          payment_type?: string | null
          pickup_address: string
          pickup_latitude?: number | null
          pickup_longitude?: number | null
          pickup_zone_id?: string | null
          pre_assigned_driver_id?: string | null
          qr_session_id?: string | null
          scheduled_at?: string | null
          scheduled_broadcast_at?: string | null
          scheduled_convert_at?: string | null
          scheduled_status?: string | null
          sequence_no?: number | null
          service_area_code?: string | null
          service_area_id?: string | null
          special_instructions?: string | null
          started_at?: string | null
          status?: string | null
          stops?: Json | null
          stripe_payment_intent_id?: string | null
          surge_multiplier?: number | null
          total_stops?: number | null
          trip_code?: string | null
          trip_number?: string | null
          trip_type?: string | null
          updated_at?: string
          vehicle_type?: string | null
        }
        Update: {
          arrived_at?: string | null
          broadcast_started_at?: string | null
          client_action_id?: string | null
          commission_pence?: number | null
          completed_at?: string | null
          confirm_deadline_at?: string | null
          confirmed_driver_id?: string | null
          created_at?: string
          currency?: string | null
          currency_code?: string | null
          current_broadcast_round?: number | null
          current_stop_index?: number | null
          dispatch_mode?: string | null
          dispatch_status?: string | null
          driver_confirm_deadline_at?: string | null
          driver_id?: string | null
          driver_location_lat?: number | null
          driver_location_lng?: number | null
          driver_net_pence?: number | null
          dropoff_address?: string
          dropoff_latitude?: number | null
          dropoff_longitude?: number | null
          dropoff_zone_id?: string | null
          escalation_status?: string | null
          estimated_distance_km?: number | null
          estimated_duration_minutes?: number | null
          estimated_fare?: number | null
          fare?: number | null
          gross_fare_pence?: number | null
          id?: string
          is_scheduled?: boolean | null
          job_type?: string | null
          last_broadcast_at?: string | null
          max_broadcast_rounds?: number | null
          passenger_id?: string
          passenger_name?: string | null
          passenger_phone?: string | null
          payment_method?: string | null
          payment_status?: string | null
          payment_type?: string | null
          pickup_address?: string
          pickup_latitude?: number | null
          pickup_longitude?: number | null
          pickup_zone_id?: string | null
          pre_assigned_driver_id?: string | null
          qr_session_id?: string | null
          scheduled_at?: string | null
          scheduled_broadcast_at?: string | null
          scheduled_convert_at?: string | null
          scheduled_status?: string | null
          sequence_no?: number | null
          service_area_code?: string | null
          service_area_id?: string | null
          special_instructions?: string | null
          started_at?: string | null
          status?: string | null
          stops?: Json | null
          stripe_payment_intent_id?: string | null
          surge_multiplier?: number | null
          total_stops?: number | null
          trip_code?: string | null
          trip_number?: string | null
          trip_type?: string | null
          updated_at?: string
          vehicle_type?: string | null
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
            referencedRelation: "driver_wallet_balance"
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
            referencedRelation: "driver_wallet_balance"
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
            foreignKeyName: "trips_dropoff_zone_id_fkey"
            columns: ["dropoff_zone_id"]
            isOneToOne: false
            referencedRelation: "custom_zones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_pickup_zone_id_fkey"
            columns: ["pickup_zone_id"]
            isOneToOne: false
            referencedRelation: "custom_zones"
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
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_pre_assigned_driver_id_fkey"
            columns: ["pre_assigned_driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
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
      vehicle_change_requests: {
        Row: {
          admin_notes: string | null
          created_at: string
          driver_id: string
          id: string
          requested_color: string
          requested_license_plate: string
          requested_make: string
          requested_model: string
          requested_year: number
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          updated_at: string
          vehicle_id: string
        }
        Insert: {
          admin_notes?: string | null
          created_at?: string
          driver_id: string
          id?: string
          requested_color: string
          requested_license_plate: string
          requested_make: string
          requested_model: string
          requested_year: number
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          vehicle_id: string
        }
        Update: {
          admin_notes?: string | null
          created_at?: string
          driver_id?: string
          id?: string
          requested_color?: string
          requested_license_plate?: string
          requested_make?: string
          requested_model?: string
          requested_year?: number
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          vehicle_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vehicle_change_requests_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "vehicle_change_requests_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "vehicle_change_requests_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_change_requests_vehicle_id_fkey"
            columns: ["vehicle_id"]
            isOneToOne: false
            referencedRelation: "vehicles"
            referencedColumns: ["id"]
          },
        ]
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
            referencedRelation: "driver_wallet_balance"
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
      driver_wallet_balance: {
        Row: {
          available_pence: number | null
          driver_id: string | null
          email: string | null
          first_name: string | null
          last_name: string | null
          total_debt_pence: number | null
          total_earnings_pence: number | null
          trip_count: number | null
        }
        Relationships: []
      }
    }
    Functions: {
      accept_ride_offer: {
        Args: { p_driver_id: string; p_offer_id: string }
        Returns: Json
      }
      assign_trip_number: {
        Args: { p_service_area_id: string; p_trip_id: string }
        Returns: Json
      }
      can_driver_edit_vehicle: {
        Args: { p_driver_id: string }
        Returns: boolean
      }
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
      decline_ride_offer: {
        Args: { p_driver_id: string; p_offer_id: string }
        Returns: Json
      }
      dispatch_trip_offers: { Args: { p_trip_id: string }; Returns: undefined }
      expire_stale_offers: { Args: never; Returns: Json }
      find_service_area_by_location: {
        Args: { p_lat: number; p_lng: number }
        Returns: string
      }
      generate_lost_property_case_number: {
        Args: { p_service_area_id: string }
        Returns: string
      }
      generate_trip_number: {
        Args: { p_service_area_id: string }
        Returns: {
          sequence_no: number
          service_area_code: string
          trip_number: string
        }[]
      }
      get_driver_wallet_balance: {
        Args: { p_driver_id: string }
        Returns: {
          available_pence: number
          can_early_cashout: boolean
          can_payout: boolean
        }[]
      }
      get_region_code: { Args: { p_region_id: string }; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      haversine_meters: {
        Args: { lat1: number; lat2: number; lon1: number; lon2: number }
        Returns: number
      }
      lock_driver_vehicle: { Args: { p_driver_id: string }; Returns: undefined }
      point_in_circle: {
        Args: {
          center_lat: number
          center_lng: number
          point_lat: number
          point_lng: number
          radius_meters: number
        }
        Returns: boolean
      }
      point_in_polygon: {
        Args: { point_lat: number; point_lng: number; polygon_geojson: Json }
        Returns: boolean
      }
      record_cash_trip_completion: {
        Args: {
          p_commission_pence: number
          p_currency_code?: string
          p_driver_id: string
          p_gross_fare_pence: number
          p_trip_id: string
        }
        Returns: string
      }
      record_digital_trip_payment: {
        Args: {
          p_commission_pence: number
          p_currency_code?: string
          p_driver_id: string
          p_gross_fare_pence: number
          p_stripe_payment_intent_id: string
          p_trip_id: string
        }
        Returns: string
      }
      resolve_zone: {
        Args: {
          p_region_id: string
          p_zone_type?: string
          point_lat: number
          point_lng: number
        }
        Returns: {
          metadata: Json
          priority: number
          zone_id: string
          zone_name: string
          zone_type: string
        }[]
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
