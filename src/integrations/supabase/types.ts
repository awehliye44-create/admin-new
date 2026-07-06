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
      account_email_change_requests: {
        Row: {
          account_id: string | null
          account_type: string
          attempt_count: number
          cancelled_at: string | null
          created_at: string
          created_ip: string | null
          current_email: string
          expires_at: string
          id: string
          new_email: string
          requested_at: string
          status: string
          token_hash: string
          user_agent: string | null
          user_id: string
          verified_at: string | null
        }
        Insert: {
          account_id?: string | null
          account_type: string
          attempt_count?: number
          cancelled_at?: string | null
          created_at?: string
          created_ip?: string | null
          current_email: string
          expires_at: string
          id?: string
          new_email: string
          requested_at?: string
          status?: string
          token_hash: string
          user_agent?: string | null
          user_id: string
          verified_at?: string | null
        }
        Update: {
          account_id?: string | null
          account_type?: string
          attempt_count?: number
          cancelled_at?: string | null
          created_at?: string
          created_ip?: string | null
          current_email?: string
          expires_at?: string
          id?: string
          new_email?: string
          requested_at?: string
          status?: string
          token_hash?: string
          user_agent?: string | null
          user_id?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      account_email_verifications: {
        Row: {
          app_type: string
          created_at: string
          email: string
          expires_at: string
          id: string
          token_hash: string
          user_id: string
          verified_at: string | null
        }
        Insert: {
          app_type: string
          created_at?: string
          email: string
          expires_at: string
          id?: string
          token_hash: string
          user_id: string
          verified_at?: string | null
        }
        Update: {
          app_type?: string
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          token_hash?: string
          user_id?: string
          verified_at?: string | null
        }
        Relationships: []
      }
      account_suspensions: {
        Row: {
          created_at: string
          duration_days: number | null
          expires_at: string | null
          id: string
          lifted_at: string | null
          lifted_by: string | null
          lifted_by_name: string | null
          notes: string | null
          reason: string
          status: string
          suspended_at: string
          suspended_by: string | null
          suspended_by_name: string
          updated_at: string
          user_email: string
          user_id: string
          user_name: string
          user_type: string
        }
        Insert: {
          created_at?: string
          duration_days?: number | null
          expires_at?: string | null
          id?: string
          lifted_at?: string | null
          lifted_by?: string | null
          lifted_by_name?: string | null
          notes?: string | null
          reason: string
          status?: string
          suspended_at?: string
          suspended_by?: string | null
          suspended_by_name?: string
          updated_at?: string
          user_email?: string
          user_id: string
          user_name?: string
          user_type: string
        }
        Update: {
          created_at?: string
          duration_days?: number | null
          expires_at?: string | null
          id?: string
          lifted_at?: string | null
          lifted_by?: string | null
          lifted_by_name?: string | null
          notes?: string | null
          reason?: string
          status?: string
          suspended_at?: string
          suspended_by?: string | null
          suspended_by_name?: string
          updated_at?: string
          user_email?: string
          user_id?: string
          user_name?: string
          user_type?: string
        }
        Relationships: []
      }
      admin_payment_audit: {
        Row: {
          action: string
          admin_user_id: string
          amount_pence_after: number | null
          amount_pence_before: number | null
          created_at: string
          delta_pence: number | null
          id: string
          metadata: Json | null
          reason: string
          stripe_payment_intent_id: string | null
          stripe_refund_id: string | null
          trip_id: string
        }
        Insert: {
          action: string
          admin_user_id: string
          amount_pence_after?: number | null
          amount_pence_before?: number | null
          created_at?: string
          delta_pence?: number | null
          id?: string
          metadata?: Json | null
          reason: string
          stripe_payment_intent_id?: string | null
          stripe_refund_id?: string | null
          trip_id: string
        }
        Update: {
          action?: string
          admin_user_id?: string
          amount_pence_after?: number | null
          amount_pence_before?: number | null
          created_at?: string
          delta_pence?: number | null
          id?: string
          metadata?: Json | null
          reason?: string
          stripe_payment_intent_id?: string | null
          stripe_refund_id?: string | null
          trip_id?: string
        }
        Relationships: []
      }
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
      ai_credit_packages: {
        Row: {
          active: boolean
          created_at: string
          credits: number
          currency: string
          id: string
          name: string
          price: number
          sort_order: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          credits: number
          currency?: string
          id?: string
          name: string
          price: number
          sort_order?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          credits?: number
          currency?: string
          id?: string
          name?: string
          price?: number
          sort_order?: number
          updated_at?: string
        }
        Relationships: []
      }
      ai_credit_settings: {
        Row: {
          ai_generation_enabled: boolean
          credit_cost_per_image: number
          credit_cost_per_regeneration: number
          credit_purchase_enabled: boolean
          free_credits_for_new_merchants: number
          id: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          ai_generation_enabled?: boolean
          credit_cost_per_image?: number
          credit_cost_per_regeneration?: number
          credit_purchase_enabled?: boolean
          free_credits_for_new_merchants?: number
          id?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          ai_generation_enabled?: boolean
          credit_cost_per_image?: number
          credit_cost_per_regeneration?: number
          credit_purchase_enabled?: boolean
          free_credits_for_new_merchants?: number
          id?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      alert_sound_mappings: {
        Row: {
          alert_sound_id: string
          created_at: string
          event_type: string
          id: string
          is_active: boolean
          is_default: boolean
          target_app: string
          updated_at: string
        }
        Insert: {
          alert_sound_id: string
          created_at?: string
          event_type: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          target_app: string
          updated_at?: string
        }
        Update: {
          alert_sound_id?: string
          created_at?: string
          event_type?: string
          id?: string
          is_active?: boolean
          is_default?: boolean
          target_app?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "alert_sound_mappings_alert_sound_id_fkey"
            columns: ["alert_sound_id"]
            isOneToOne: false
            referencedRelation: "alert_sounds"
            referencedColumns: ["id"]
          },
        ]
      }
      alert_sounds: {
        Row: {
          created_at: string
          duration: number | null
          file_size: number | null
          id: string
          is_active: boolean
          mime_type: string
          name: string
          storage_path: string
          target_app: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          duration?: number | null
          file_size?: number | null
          id?: string
          is_active?: boolean
          mime_type?: string
          name: string
          storage_path: string
          target_app?: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          duration?: number | null
          file_size?: number | null
          id?: string
          is_active?: boolean
          mime_type?: string
          name?: string
          storage_path?: string
          target_app?: string
          updated_at?: string
        }
        Relationships: []
      }
      app_performance_baselines: {
        Row: {
          action_name: string
          app_name: string
          baseline_type: string
          created_at: string
          failure_count: number
          id: string
          notes: string | null
          p50_ms: number | null
          p95_ms: number | null
          p99_ms: number | null
          platform: string
          sample_count: number
          target_ms: number
          timeout_count: number
          verdict: string
        }
        Insert: {
          action_name: string
          app_name: string
          baseline_type: string
          created_at?: string
          failure_count?: number
          id?: string
          notes?: string | null
          p50_ms?: number | null
          p95_ms?: number | null
          p99_ms?: number | null
          platform: string
          sample_count?: number
          target_ms: number
          timeout_count?: number
          verdict: string
        }
        Update: {
          action_name?: string
          app_name?: string
          baseline_type?: string
          created_at?: string
          failure_count?: number
          id?: string
          notes?: string | null
          p50_ms?: number | null
          p95_ms?: number | null
          p99_ms?: number | null
          platform?: string
          sample_count?: number
          target_ms?: number
          timeout_count?: number
          verdict?: string
        }
        Relationships: []
      }
      app_performance_events: {
        Row: {
          app_name: string
          app_version: string | null
          created_at: string
          device_model: string | null
          id: string
          is_synthetic: boolean
          metadata: Json | null
          metric_name: string
          metric_value: number
          os_version: string | null
          platform: string | null
          screen_name: string
          session_id: string | null
          unit: string
          user_id: string | null
        }
        Insert: {
          app_name: string
          app_version?: string | null
          created_at?: string
          device_model?: string | null
          id?: string
          is_synthetic?: boolean
          metadata?: Json | null
          metric_name: string
          metric_value: number
          os_version?: string | null
          platform?: string | null
          screen_name: string
          session_id?: string | null
          unit?: string
          user_id?: string | null
        }
        Update: {
          app_name?: string
          app_version?: string | null
          created_at?: string
          device_model?: string | null
          id?: string
          is_synthetic?: boolean
          metadata?: Json | null
          metric_name?: string
          metric_value?: number
          os_version?: string | null
          platform?: string | null
          screen_name?: string
          session_id?: string | null
          unit?: string
          user_id?: string | null
        }
        Relationships: []
      }
      app_performance_thresholds: {
        Row: {
          app_name: string
          created_at: string
          critical_threshold: number
          id: string
          is_active: boolean
          metric_name: string
          screen_name: string | null
          updated_at: string
          warning_threshold: number
        }
        Insert: {
          app_name: string
          created_at?: string
          critical_threshold: number
          id?: string
          is_active?: boolean
          metric_name: string
          screen_name?: string | null
          updated_at?: string
          warning_threshold: number
        }
        Update: {
          app_name?: string
          created_at?: string
          critical_threshold?: number
          id?: string
          is_active?: boolean
          metric_name?: string
          screen_name?: string | null
          updated_at?: string
          warning_threshold?: number
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          created_at: string | null
          details: Json | null
          driver_id: string | null
          event_type: string
          id: string
          ip_address: string | null
          trip_id: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string | null
          details?: Json | null
          driver_id?: string | null
          event_type: string
          id?: string
          ip_address?: string | null
          trip_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string | null
          details?: Json | null
          driver_id?: string | null
          event_type?: string
          id?: string
          ip_address?: string | null
          trip_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      booking_delivery_log: {
        Row: {
          booking_id: string
          created_at: string
          detail: Json
          driver_id: string | null
          id: string
          offer_id: string | null
          phase: string
          source: string
        }
        Insert: {
          booking_id: string
          created_at?: string
          detail?: Json
          driver_id?: string | null
          id?: string
          offer_id?: string | null
          phase: string
          source?: string
        }
        Update: {
          booking_id?: string
          created_at?: string
          detail?: Json
          driver_id?: string | null
          id?: string
          offer_id?: string | null
          phase?: string
          source?: string
        }
        Relationships: [
          {
            foreignKeyName: "booking_delivery_log_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_delivery_log_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_delivery_log_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_delivery_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_delivery_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "booking_delivery_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "booking_delivery_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "booking_delivery_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_delivery_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "booking_delivery_log_offer_id_fkey"
            columns: ["offer_id"]
            isOneToOne: false
            referencedRelation: "ride_offers"
            referencedColumns: ["id"]
          },
        ]
      }
      call_masking_call_logs: {
        Row: {
          booking_id: string
          call_end: string | null
          call_start: string
          caller_e164: string
          created_at: string
          destination_e164: string
          disconnect_reason: string | null
          duration_seconds: number | null
          id: string
          msg91_request_id: string | null
          msg91_uuid: string | null
          session_id: string
          status: string
        }
        Insert: {
          booking_id: string
          call_end?: string | null
          call_start?: string
          caller_e164: string
          created_at?: string
          destination_e164: string
          disconnect_reason?: string | null
          duration_seconds?: number | null
          id?: string
          msg91_request_id?: string | null
          msg91_uuid?: string | null
          session_id: string
          status?: string
        }
        Update: {
          booking_id?: string
          call_end?: string | null
          call_start?: string
          caller_e164?: string
          created_at?: string
          destination_e164?: string
          disconnect_reason?: string | null
          duration_seconds?: number | null
          id?: string
          msg91_request_id?: string | null
          msg91_uuid?: string | null
          session_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_masking_call_logs_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_masking_call_logs_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_masking_call_logs_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_masking_call_logs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "call_masking_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_masking_call_logs_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "driver_call_masking_view"
            referencedColumns: ["id"]
          },
        ]
      }
      call_masking_provider_configs: {
        Row: {
          country_code: string
          created_at: string
          id: string
          is_active: boolean
          label: string
          number_pool_id: string
          outbound_caller_id: string
          provider: string
        }
        Insert: {
          country_code: string
          created_at?: string
          id?: string
          is_active?: boolean
          label: string
          number_pool_id: string
          outbound_caller_id: string
          provider: string
        }
        Update: {
          country_code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          number_pool_id?: string
          outbound_caller_id?: string
          provider?: string
        }
        Relationships: []
      }
      call_masking_sessions: {
        Row: {
          caller_id: string | null
          created_at: string
          customer_id: string | null
          customer_phone: string
          driver_id: string
          driver_phone: string
          expires_at: string | null
          id: string
          msg91_request_id: string | null
          status: string
          trip_id: string
          updated_at: string
        }
        Insert: {
          caller_id?: string | null
          created_at?: string
          customer_id?: string | null
          customer_phone: string
          driver_id: string
          driver_phone: string
          expires_at?: string | null
          id?: string
          msg91_request_id?: string | null
          status?: string
          trip_id: string
          updated_at?: string
        }
        Update: {
          caller_id?: string | null
          created_at?: string
          customer_id?: string | null
          customer_phone?: string
          driver_id?: string
          driver_phone?: string
          expires_at?: string | null
          id?: string
          msg91_request_id?: string | null
          status?: string
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "call_masking_sessions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "admin_customer_code_audit"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "call_masking_sessions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "admin_riders_with_trip_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_masking_sessions_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_masking_sessions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_masking_sessions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "call_masking_sessions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "call_masking_sessions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "call_masking_sessions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_masking_sessions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_masking_sessions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_masking_sessions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_masking_sessions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_heads_up_campaigns: {
        Row: {
          accent_color: string
          background_image_url: string | null
          category: string
          created_at: string
          created_by: string | null
          cta_label: string | null
          cta_url: string | null
          deep_link: string | null
          delivered_count: number
          dismissed_count: number
          emoji: string | null
          ends_at: string | null
          failed_count: number
          gradient_from: string
          gradient_to: string
          id: string
          languages: Json
          metadata: Json
          opened_count: number
          priority: string
          schedule_mode: string
          scheduled_at: string | null
          sent_at: string | null
          sent_count: number
          starts_at: string | null
          status: string
          subtitle: string
          tapped_count: number
          target_app: string
          target_region_id: string | null
          target_scope: string
          target_service_area_id: string | null
          target_user_ids: string[] | null
          target_user_segment: string | null
          template_id: string | null
          template_slug: string | null
          title: string
          updated_at: string
        }
        Insert: {
          accent_color?: string
          background_image_url?: string | null
          category: string
          created_at?: string
          created_by?: string | null
          cta_label?: string | null
          cta_url?: string | null
          deep_link?: string | null
          delivered_count?: number
          dismissed_count?: number
          emoji?: string | null
          ends_at?: string | null
          failed_count?: number
          gradient_from?: string
          gradient_to?: string
          id?: string
          languages?: Json
          metadata?: Json
          opened_count?: number
          priority?: string
          schedule_mode?: string
          scheduled_at?: string | null
          sent_at?: string | null
          sent_count?: number
          starts_at?: string | null
          status?: string
          subtitle: string
          tapped_count?: number
          target_app?: string
          target_region_id?: string | null
          target_scope?: string
          target_service_area_id?: string | null
          target_user_ids?: string[] | null
          target_user_segment?: string | null
          template_id?: string | null
          template_slug?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          accent_color?: string
          background_image_url?: string | null
          category?: string
          created_at?: string
          created_by?: string | null
          cta_label?: string | null
          cta_url?: string | null
          deep_link?: string | null
          delivered_count?: number
          dismissed_count?: number
          emoji?: string | null
          ends_at?: string | null
          failed_count?: number
          gradient_from?: string
          gradient_to?: string
          id?: string
          languages?: Json
          metadata?: Json
          opened_count?: number
          priority?: string
          schedule_mode?: string
          scheduled_at?: string | null
          sent_at?: string | null
          sent_count?: number
          starts_at?: string | null
          status?: string
          subtitle?: string
          tapped_count?: number
          target_app?: string
          target_region_id?: string | null
          target_scope?: string
          target_service_area_id?: string | null
          target_user_ids?: string[] | null
          target_user_segment?: string | null
          template_id?: string | null
          template_slug?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_heads_up_campaigns_target_region_id_fkey"
            columns: ["target_region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_heads_up_campaigns_target_service_area_id_fkey"
            columns: ["target_service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaign_heads_up_campaigns_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "campaign_heads_up_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_heads_up_deliveries: {
        Row: {
          campaign_id: string
          created_at: string
          dedupe_key: string
          delivered_at: string | null
          dismissed_at: string | null
          failed_at: string | null
          failure_reason: string | null
          id: string
          opened_at: string | null
          status: string
          tapped_at: string | null
          user_app: string
          user_id: string
        }
        Insert: {
          campaign_id: string
          created_at?: string
          dedupe_key: string
          delivered_at?: string | null
          dismissed_at?: string | null
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          opened_at?: string | null
          status?: string
          tapped_at?: string | null
          user_app: string
          user_id: string
        }
        Update: {
          campaign_id?: string
          created_at?: string
          dedupe_key?: string
          delivered_at?: string | null
          dismissed_at?: string | null
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          opened_at?: string | null
          status?: string
          tapped_at?: string | null
          user_app?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "campaign_heads_up_deliveries_campaign_id_fkey"
            columns: ["campaign_id"]
            isOneToOne: false
            referencedRelation: "campaign_heads_up_campaigns"
            referencedColumns: ["id"]
          },
        ]
      }
      campaign_heads_up_templates: {
        Row: {
          accent_color: string
          background_image_url: string | null
          category: string
          created_at: string
          cta_label: string | null
          cta_url: string | null
          deep_link: string | null
          default_priority: string
          default_target_app: string
          emoji: string | null
          gradient_from: string
          gradient_to: string
          id: string
          is_active: boolean
          is_system: boolean
          name: string
          slug: string
          subtitle: string
          supported_languages: Json
          title: string
          updated_at: string
        }
        Insert: {
          accent_color?: string
          background_image_url?: string | null
          category: string
          created_at?: string
          cta_label?: string | null
          cta_url?: string | null
          deep_link?: string | null
          default_priority?: string
          default_target_app?: string
          emoji?: string | null
          gradient_from?: string
          gradient_to?: string
          id?: string
          is_active?: boolean
          is_system?: boolean
          name: string
          slug: string
          subtitle: string
          supported_languages?: Json
          title: string
          updated_at?: string
        }
        Update: {
          accent_color?: string
          background_image_url?: string | null
          category?: string
          created_at?: string
          cta_label?: string | null
          cta_url?: string | null
          deep_link?: string | null
          default_priority?: string
          default_target_app?: string
          emoji?: string | null
          gradient_from?: string
          gradient_to?: string
          id?: string
          is_active?: boolean
          is_system?: boolean
          name?: string
          slug?: string
          subtitle?: string
          supported_languages?: Json
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      canned_responses: {
        Row: {
          category: string | null
          content: string
          created_at: string
          created_by: string | null
          id: string
          is_active: boolean
          shortcut: string | null
          title: string
          updated_at: string
          usage_count: number
        }
        Insert: {
          category?: string | null
          content: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          shortcut?: string | null
          title: string
          updated_at?: string
          usage_count?: number
        }
        Update: {
          category?: string | null
          content?: string
          created_at?: string
          created_by?: string | null
          id?: string
          is_active?: boolean
          shortcut?: string | null
          title?: string
          updated_at?: string
          usage_count?: number
        }
        Relationships: []
      }
      complaint_sequences: {
        Row: {
          current_value: number
          service_area_id: string
          updated_at: string
        }
        Insert: {
          current_value?: number
          service_area_id: string
          updated_at?: string
        }
        Update: {
          current_value?: number
          service_area_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "complaint_sequences_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: true
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      complaints: {
        Row: {
          assigned_to: string | null
          category: string
          complaint_number: string
          created_at: string
          description: string
          id: string
          priority: string
          reported_user_id: string | null
          reported_user_name: string
          reported_user_type: string
          reporter_email: string | null
          reporter_id: string | null
          reporter_name: string
          reporter_type: string
          resolution: string | null
          resolved_at: string | null
          resolved_by: string | null
          service_area_id: string | null
          status: string
          subject: string
          trip_id: string | null
          updated_at: string
        }
        Insert: {
          assigned_to?: string | null
          category?: string
          complaint_number: string
          created_at?: string
          description?: string
          id?: string
          priority?: string
          reported_user_id?: string | null
          reported_user_name: string
          reported_user_type?: string
          reporter_email?: string | null
          reporter_id?: string | null
          reporter_name: string
          reporter_type?: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          service_area_id?: string | null
          status?: string
          subject: string
          trip_id?: string | null
          updated_at?: string
        }
        Update: {
          assigned_to?: string | null
          category?: string
          complaint_number?: string
          created_at?: string
          description?: string
          id?: string
          priority?: string
          reported_user_id?: string | null
          reported_user_name?: string
          reported_user_type?: string
          reporter_email?: string | null
          reporter_id?: string | null
          reporter_name?: string
          reporter_type?: string
          resolution?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          service_area_id?: string | null
          status?: string
          subject?: string
          trip_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "complaints_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "complaints_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "complaints_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "complaints_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      content_audit_log: {
        Row: {
          action: string
          content_item_id: string
          created_at: string
          details: Json | null
          id: string
          user_id: string | null
        }
        Insert: {
          action: string
          content_item_id: string
          created_at?: string
          details?: Json | null
          id?: string
          user_id?: string | null
        }
        Update: {
          action?: string
          content_item_id?: string
          created_at?: string
          details?: Json | null
          id?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "content_audit_log_content_item_id_fkey"
            columns: ["content_item_id"]
            isOneToOne: false
            referencedRelation: "content_items"
            referencedColumns: ["id"]
          },
        ]
      }
      content_items: {
        Row: {
          app_scope: Database["public"]["Enums"]["app_scope"]
          change_log: string | null
          content_html: string
          created_at: string
          id: string
          published_at: string | null
          published_by: string | null
          slug: string
          status: Database["public"]["Enums"]["content_status"]
          title: string
          updated_at: string
          updated_by: string | null
          version: number
        }
        Insert: {
          app_scope: Database["public"]["Enums"]["app_scope"]
          change_log?: string | null
          content_html?: string
          created_at?: string
          id?: string
          published_at?: string | null
          published_by?: string | null
          slug: string
          status?: Database["public"]["Enums"]["content_status"]
          title: string
          updated_at?: string
          updated_by?: string | null
          version?: number
        }
        Update: {
          app_scope?: Database["public"]["Enums"]["app_scope"]
          change_log?: string | null
          content_html?: string
          created_at?: string
          id?: string
          published_at?: string | null
          published_by?: string | null
          slug?: string
          status?: Database["public"]["Enums"]["content_status"]
          title?: string
          updated_at?: string
          updated_by?: string | null
          version?: number
        }
        Relationships: []
      }
      corporate_account_requests: {
        Row: {
          address: string | null
          approved_at: string | null
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
          suspended_at: string | null
          tax_id: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          address?: string | null
          approved_at?: string | null
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
          suspended_at?: string | null
          tax_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          address?: string | null
          approved_at?: string | null
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
          suspended_at?: string | null
          tax_id?: string | null
          updated_at?: string
          user_id?: string | null
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
          payment_apple_pay_enabled: boolean
          payment_card_enabled: boolean
          payment_google_pay_enabled: boolean
          payment_invoice_enabled: boolean
          payment_terms: string | null
          payment_wallet_enabled: boolean
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
          payment_apple_pay_enabled?: boolean
          payment_card_enabled?: boolean
          payment_google_pay_enabled?: boolean
          payment_invoice_enabled?: boolean
          payment_terms?: string | null
          payment_wallet_enabled?: boolean
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
          payment_apple_pay_enabled?: boolean
          payment_card_enabled?: boolean
          payment_google_pay_enabled?: boolean
          payment_invoice_enabled?: boolean
          payment_terms?: string | null
          payment_wallet_enabled?: boolean
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
      corporate_audit_log: {
        Row: {
          action: string
          action_type: string
          corporate_account_id: string
          created_at: string | null
          id: string
          ip_address: unknown
          metadata: Json | null
          target_id: string | null
          target_name: string | null
          target_type: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          action_type: string
          corporate_account_id: string
          created_at?: string | null
          id?: string
          ip_address?: unknown
          metadata?: Json | null
          target_id?: string | null
          target_name?: string | null
          target_type?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          action_type?: string
          corporate_account_id?: string
          created_at?: string | null
          id?: string
          ip_address?: unknown
          metadata?: Json | null
          target_id?: string | null
          target_name?: string | null
          target_type?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "corporate_audit_log_corporate_account_id_fkey"
            columns: ["corporate_account_id"]
            isOneToOne: false
            referencedRelation: "corporate_accounts"
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
      corporate_locations: {
        Row: {
          address: string
          corporate_account_id: string
          created_at: string | null
          created_by: string | null
          id: string
          is_active: boolean | null
          lat: number | null
          lng: number | null
          location_type: string | null
          name: string
          place_id: string | null
          updated_at: string | null
          usage_count: number | null
        }
        Insert: {
          address: string
          corporate_account_id: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_active?: boolean | null
          lat?: number | null
          lng?: number | null
          location_type?: string | null
          name: string
          place_id?: string | null
          updated_at?: string | null
          usage_count?: number | null
        }
        Update: {
          address?: string
          corporate_account_id?: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_active?: boolean | null
          lat?: number | null
          lng?: number | null
          location_type?: string | null
          name?: string
          place_id?: string | null
          updated_at?: string | null
          usage_count?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "corporate_locations_corporate_account_id_fkey"
            columns: ["corporate_account_id"]
            isOneToOne: false
            referencedRelation: "corporate_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      corporate_policies: {
        Row: {
          allowed_days: number[] | null
          allowed_vehicle_types: string[] | null
          corporate_account_id: string
          created_at: string | null
          description: string | null
          id: string
          is_active: boolean | null
          is_default: boolean | null
          max_per_trip_pence: number | null
          monthly_limit_pence: number | null
          name: string
          require_approval_above_pence: number | null
          time_window_end: string | null
          time_window_start: string | null
          updated_at: string | null
        }
        Insert: {
          allowed_days?: number[] | null
          allowed_vehicle_types?: string[] | null
          corporate_account_id: string
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          is_default?: boolean | null
          max_per_trip_pence?: number | null
          monthly_limit_pence?: number | null
          name: string
          require_approval_above_pence?: number | null
          time_window_end?: string | null
          time_window_start?: string | null
          updated_at?: string | null
        }
        Update: {
          allowed_days?: number[] | null
          allowed_vehicle_types?: string[] | null
          corporate_account_id?: string
          created_at?: string | null
          description?: string | null
          id?: string
          is_active?: boolean | null
          is_default?: boolean | null
          max_per_trip_pence?: number | null
          monthly_limit_pence?: number | null
          name?: string
          require_approval_above_pence?: number | null
          time_window_end?: string | null
          time_window_start?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "corporate_policies_corporate_account_id_fkey"
            columns: ["corporate_account_id"]
            isOneToOne: false
            referencedRelation: "corporate_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      corporate_support_tickets: {
        Row: {
          assigned_to: string | null
          category: string | null
          corporate_account_id: string
          created_at: string | null
          created_by: string | null
          id: string
          message: string
          priority: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string | null
          subject: string
          updated_at: string | null
        }
        Insert: {
          assigned_to?: string | null
          category?: string | null
          corporate_account_id: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          message: string
          priority?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string | null
          subject: string
          updated_at?: string | null
        }
        Update: {
          assigned_to?: string | null
          category?: string | null
          corporate_account_id?: string
          created_at?: string | null
          created_by?: string | null
          id?: string
          message?: string
          priority?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string | null
          subject?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "corporate_support_tickets_corporate_account_id_fkey"
            columns: ["corporate_account_id"]
            isOneToOne: false
            referencedRelation: "corporate_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      corporate_ticket_messages: {
        Row: {
          attachments: string[] | null
          created_at: string | null
          id: string
          message: string
          sender_id: string | null
          sender_type: string
          ticket_id: string
        }
        Insert: {
          attachments?: string[] | null
          created_at?: string | null
          id?: string
          message: string
          sender_id?: string | null
          sender_type: string
          ticket_id: string
        }
        Update: {
          attachments?: string[] | null
          created_at?: string | null
          id?: string
          message?: string
          sender_id?: string | null
          sender_type?: string
          ticket_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "corporate_ticket_messages_ticket_id_fkey"
            columns: ["ticket_id"]
            isOneToOne: false
            referencedRelation: "corporate_support_tickets"
            referencedColumns: ["id"]
          },
        ]
      }
      corporate_user_accounts: {
        Row: {
          corporate_account_id: string
          created_at: string | null
          id: string
          role: string | null
          user_id: string
        }
        Insert: {
          corporate_account_id: string
          created_at?: string | null
          id?: string
          role?: string | null
          user_id: string
        }
        Update: {
          corporate_account_id?: string
          created_at?: string | null
          id?: string
          role?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "corporate_user_accounts_corporate_account_id_fkey"
            columns: ["corporate_account_id"]
            isOneToOne: false
            referencedRelation: "corporate_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      corporate_users: {
        Row: {
          activated_at: string | null
          corporate_account_id: string
          created_at: string | null
          department: string | null
          email: string
          first_name: string
          id: string
          invited_at: string | null
          last_name: string
          monthly_limit_pence: number | null
          phone: string | null
          role: string | null
          spend_this_month_pence: number | null
          status: string | null
          trips_this_month: number | null
          updated_at: string | null
          user_id: string | null
        }
        Insert: {
          activated_at?: string | null
          corporate_account_id: string
          created_at?: string | null
          department?: string | null
          email: string
          first_name: string
          id?: string
          invited_at?: string | null
          last_name: string
          monthly_limit_pence?: number | null
          phone?: string | null
          role?: string | null
          spend_this_month_pence?: number | null
          status?: string | null
          trips_this_month?: number | null
          updated_at?: string | null
          user_id?: string | null
        }
        Update: {
          activated_at?: string | null
          corporate_account_id?: string
          created_at?: string | null
          department?: string | null
          email?: string
          first_name?: string
          id?: string
          invited_at?: string | null
          last_name?: string
          monthly_limit_pence?: number | null
          phone?: string | null
          role?: string | null
          spend_this_month_pence?: number | null
          status?: string | null
          trips_this_month?: number | null
          updated_at?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "corporate_users_corporate_account_id_fkey"
            columns: ["corporate_account_id"]
            isOneToOne: false
            referencedRelation: "corporate_accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      custom_zones: {
        Row: {
          airport_fee: number
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
          airport_fee?: number
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
          airport_fee?: number
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
      customer_active_devices: {
        Row: {
          claimed_at: string
          device_id: string
          last_seen_at: string
          platform: string | null
          updated_at: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          claimed_at?: string
          device_id: string
          last_seen_at?: string
          platform?: string | null
          updated_at?: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          claimed_at?: string
          device_id?: string
          last_seen_at?: string
          platform?: string | null
          updated_at?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      customer_live_locations: {
        Row: {
          accuracy: number | null
          created_at: string
          customer_id: string
          heading: number | null
          latitude: number
          longitude: number
          speed: number | null
          trip_id: string
          updated_at: string
        }
        Insert: {
          accuracy?: number | null
          created_at?: string
          customer_id: string
          heading?: number | null
          latitude: number
          longitude: number
          speed?: number | null
          trip_id: string
          updated_at?: string
        }
        Update: {
          accuracy?: number | null
          created_at?: string
          customer_id?: string
          heading?: number | null
          latitude?: number
          longitude?: number
          speed?: number | null
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_live_locations_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "admin_customer_code_audit"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "customer_live_locations_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "admin_riders_with_trip_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_live_locations_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_live_locations_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: true
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_live_locations_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: true
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_live_locations_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: true
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_personal_vouchers: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          customer_id: string
          discount_type: string
          discount_value: number
          expires_at: string | null
          id: string
          is_active: boolean
          max_uses: number
          min_fare: number
          notes: string | null
          used_count: number
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          customer_id: string
          discount_type: string
          discount_value: number
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_uses?: number
          min_fare?: number
          notes?: string | null
          used_count?: number
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string
          discount_type?: string
          discount_value?: number
          expires_at?: string | null
          id?: string
          is_active?: boolean
          max_uses?: number
          min_fare?: number
          notes?: string | null
          used_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "customer_personal_vouchers_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "admin_customer_code_audit"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "customer_personal_vouchers_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "admin_riders_with_trip_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_personal_vouchers_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
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
      customer_wallet_ledger: {
        Row: {
          amount_pence: number
          created_at: string
          description: string | null
          entry_type: string
          id: string
          status: string
          stripe_payment_intent_id: string | null
          trip_id: string | null
          updated_at: string
          wallet_id: string
        }
        Insert: {
          amount_pence: number
          created_at?: string
          description?: string | null
          entry_type: string
          id?: string
          status?: string
          stripe_payment_intent_id?: string | null
          trip_id?: string | null
          updated_at?: string
          wallet_id: string
        }
        Update: {
          amount_pence?: number
          created_at?: string
          description?: string | null
          entry_type?: string
          id?: string
          status?: string
          stripe_payment_intent_id?: string | null
          trip_id?: string | null
          updated_at?: string
          wallet_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_wallet_ledger_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_wallet_ledger_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_wallet_ledger_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_wallet_ledger_wallet_id_fkey"
            columns: ["wallet_id"]
            isOneToOne: false
            referencedRelation: "customer_wallets"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_wallets: {
        Row: {
          balance_pence: number
          created_at: string
          currency: string
          customer_id: string
          id: string
          updated_at: string
        }
        Insert: {
          balance_pence?: number
          created_at?: string
          currency?: string
          customer_id: string
          id?: string
          updated_at?: string
        }
        Update: {
          balance_pence?: number
          created_at?: string
          currency?: string
          customer_id?: string
          id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_wallets_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "admin_customer_code_audit"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "customer_wallets_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "admin_riders_with_trip_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_wallets_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          active_trip_id: string | null
          created_at: string
          customer_code: string | null
          deleted_at: string | null
          email_verified: boolean
          email_verified_at: string | null
          first_name: string
          id: string
          last_name: string
          pending_email_change: string | null
          pending_email_change_expires_at: string | null
          pending_email_change_requested_at: string | null
          pending_email_change_verified_at: string | null
          pending_phone_change: string | null
          pending_phone_change_expires_at: string | null
          pending_phone_change_otp_sent_at: string | null
          pending_phone_change_requested_at: string | null
          pending_phone_change_verified_at: string | null
          phone: string | null
          phone_verified: boolean
          phone_verified_at: string | null
          rider_status: string
          stripe_customer_id: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          active_trip_id?: string | null
          created_at?: string
          customer_code?: string | null
          deleted_at?: string | null
          email_verified?: boolean
          email_verified_at?: string | null
          first_name: string
          id?: string
          last_name: string
          pending_email_change?: string | null
          pending_email_change_expires_at?: string | null
          pending_email_change_requested_at?: string | null
          pending_email_change_verified_at?: string | null
          pending_phone_change?: string | null
          pending_phone_change_expires_at?: string | null
          pending_phone_change_otp_sent_at?: string | null
          pending_phone_change_requested_at?: string | null
          pending_phone_change_verified_at?: string | null
          phone?: string | null
          phone_verified?: boolean
          phone_verified_at?: string | null
          rider_status?: string
          stripe_customer_id?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          active_trip_id?: string | null
          created_at?: string
          customer_code?: string | null
          deleted_at?: string | null
          email_verified?: boolean
          email_verified_at?: string | null
          first_name?: string
          id?: string
          last_name?: string
          pending_email_change?: string | null
          pending_email_change_expires_at?: string | null
          pending_email_change_requested_at?: string | null
          pending_email_change_verified_at?: string | null
          pending_phone_change?: string | null
          pending_phone_change_expires_at?: string | null
          pending_phone_change_otp_sent_at?: string | null
          pending_phone_change_requested_at?: string | null
          pending_phone_change_verified_at?: string | null
          phone?: string | null
          phone_verified?: boolean
          phone_verified_at?: string | null
          rider_status?: string
          stripe_customer_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customers_active_trip_id_fkey"
            columns: ["active_trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_active_trip_id_fkey"
            columns: ["active_trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customers_active_trip_id_fkey"
            columns: ["active_trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      dispatch_audit_log: {
        Row: {
          created_at: string
          details: Json
          driver_id: string | null
          event_type: string
          id: string
          round: number | null
          trip_id: string
        }
        Insert: {
          created_at?: string
          details?: Json
          driver_id?: string | null
          event_type: string
          id?: string
          round?: number | null
          trip_id: string
        }
        Update: {
          created_at?: string
          details?: Json
          driver_id?: string | null
          event_type?: string
          id?: string
          round?: number | null
          trip_id?: string
        }
        Relationships: []
      }
      dispatch_candidates_log: {
        Row: {
          category_name: string | null
          category_priority: number | null
          created_at: string
          dispatch_score: number
          distance_km: number
          driver_id: string
          id: string
          offer_result: string | null
          trip_id: string
          waiting_minutes: number | null
          wave: number | null
        }
        Insert: {
          category_name?: string | null
          category_priority?: number | null
          created_at?: string
          dispatch_score: number
          distance_km: number
          driver_id: string
          id?: string
          offer_result?: string | null
          trip_id: string
          waiting_minutes?: number | null
          wave?: number | null
        }
        Update: {
          category_name?: string | null
          category_priority?: number | null
          created_at?: string
          dispatch_score?: number
          distance_km?: number
          driver_id?: string
          id?: string
          offer_result?: string | null
          trip_id?: string
          waiting_minutes?: number | null
          wave?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "dispatch_candidates_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_candidates_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "dispatch_candidates_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "dispatch_candidates_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "dispatch_candidates_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_candidates_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_candidates_log_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_candidates_log_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_candidates_log_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      dispatch_eligibility_log: {
        Row: {
          app_state: string | null
          approval_status: string | null
          context: Json | null
          created_at: string
          current_trip_id: string | null
          documents_approved: boolean | null
          driver_id: string
          driver_status: string | null
          has_location: boolean | null
          has_push_token: boolean | null
          heartbeat_age_seconds: number | null
          id: string
          is_eligible: boolean
          is_online: boolean | null
          last_heartbeat_at: string | null
          platform: string | null
          presence_status: string | null
          reject_reason: string | null
          trip_id: string | null
        }
        Insert: {
          app_state?: string | null
          approval_status?: string | null
          context?: Json | null
          created_at?: string
          current_trip_id?: string | null
          documents_approved?: boolean | null
          driver_id: string
          driver_status?: string | null
          has_location?: boolean | null
          has_push_token?: boolean | null
          heartbeat_age_seconds?: number | null
          id?: string
          is_eligible: boolean
          is_online?: boolean | null
          last_heartbeat_at?: string | null
          platform?: string | null
          presence_status?: string | null
          reject_reason?: string | null
          trip_id?: string | null
        }
        Update: {
          app_state?: string | null
          approval_status?: string | null
          context?: Json | null
          created_at?: string
          current_trip_id?: string | null
          documents_approved?: boolean | null
          driver_id?: string
          driver_status?: string | null
          has_location?: boolean | null
          has_push_token?: boolean | null
          heartbeat_age_seconds?: number | null
          id?: string
          is_eligible?: boolean
          is_online?: boolean | null
          last_heartbeat_at?: string | null
          platform?: string | null
          presence_status?: string | null
          reject_reason?: string | null
          trip_id?: string | null
        }
        Relationships: []
      }
      dispatch_round_advance_log: {
        Row: {
          created_at: string
          previous_round: number
          trigger_reason: string
          trip_id: string
        }
        Insert: {
          created_at?: string
          previous_round: number
          trigger_reason: string
          trip_id: string
        }
        Update: {
          created_at?: string
          previous_round?: number
          trigger_reason?: string
          trip_id?: string
        }
        Relationships: []
      }
      dispatch_settings: {
        Row: {
          accept_timeout_seconds: number
          auto_reassign_enabled: boolean
          auto_retry_attempts: number
          batch_mode: string
          block_multiple_active_rides: boolean
          cancel_protection: boolean
          cancellation_fee_after_grace_pence: number
          cascade_batch_size: number
          cascade_step_delay_seconds: number
          cooldown_after_reject_seconds: number
          created_at: string
          customer_response_timeout_seconds: number
          distance_penalty_per_km: number
          driver_fare_display: string
          driver_final_response_timeout_seconds: number
          enable_logging: boolean
          enable_stop_waiting_charge: boolean
          fairness_boost_score: number
          fairness_idle_minutes: number
          fare_negotiation_enabled: boolean
          global_timeout_minutes: number
          id: string
          instant_retry_enabled: boolean
          late_cancel_enabled: boolean
          late_cancel_fee_pence: number
          late_cancel_threshold_minutes: number
          manual_emergency_dispatch_only: boolean
          max_advance_days: number
          max_cancel_rate: number
          max_concurrent_offers_per_driver: number
          max_driver_find_time_minutes: number
          max_offer_hops: number
          max_offers_per_request: number
          max_stacked_rides: number
          max_waiting_bonus_minutes: number
          min_advance_time_minutes: number
          minimum_rating: number
          no_show_charge_pence: number
          offer_expiry_seconds: number
          pickup_paid_waiting_enabled: boolean
          pickup_paid_waiting_rate_pence_per_minute: number
          pickup_radius_enabled: boolean
          pickup_radius_meters: number
          pickup_waiting_grace_period_seconds: number
          pickup_waiting_max_minutes: number | null
          priority_order: string
          scheduled_ride_incentives_enabled: boolean
          scheduled_rides_enabled: boolean
          search_radius_expand_km: number
          search_radius_max_km: number
          search_radius_meters: number
          search_radius_start_km: number
          service_area_id: string | null
          shortlist_limit: number
          simulate_mode: boolean
          stacked_allow_rider_opt_out: boolean
          stacked_driver_incentive: number
          stacked_max_detour_minutes: number
          stacked_min_trip_distance_km: number
          stacked_offer_layout: string
          stacked_offer_window_minutes: number
          stacked_priority_mode: string
          stacked_rider_discount: number
          stacked_rides_enabled: boolean
          stacked_search_radius_meters: number
          stacked_show_eta_to_driver: boolean
          stop_radius_enabled: boolean
          stop_radius_meters: number
          stop_waiting_charge_interval_seconds: number
          stop_waiting_grace_period_seconds: number
          stop_waiting_max_minutes: number | null
          stop_waiting_rate_pence_per_minute: number
          suppress_recent_offers_seconds: number
          updated_at: string
          waiting_bonus_per_minute: number
          waiting_time_grace_period_minutes: number
          wave1_offer_expiry_seconds: number
          wave1_size: number
          wave2_offer_expiry_seconds: number
          wave2_size: number
          wave3_offer_expiry_seconds: number
          wave3_size: number
        }
        Insert: {
          accept_timeout_seconds?: number
          auto_reassign_enabled?: boolean
          auto_retry_attempts?: number
          batch_mode?: string
          block_multiple_active_rides?: boolean
          cancel_protection?: boolean
          cancellation_fee_after_grace_pence?: number
          cascade_batch_size?: number
          cascade_step_delay_seconds?: number
          cooldown_after_reject_seconds?: number
          created_at?: string
          customer_response_timeout_seconds?: number
          distance_penalty_per_km?: number
          driver_fare_display?: string
          driver_final_response_timeout_seconds?: number
          enable_logging?: boolean
          enable_stop_waiting_charge?: boolean
          fairness_boost_score?: number
          fairness_idle_minutes?: number
          fare_negotiation_enabled?: boolean
          global_timeout_minutes?: number
          id?: string
          instant_retry_enabled?: boolean
          late_cancel_enabled?: boolean
          late_cancel_fee_pence?: number
          late_cancel_threshold_minutes?: number
          manual_emergency_dispatch_only?: boolean
          max_advance_days?: number
          max_cancel_rate?: number
          max_concurrent_offers_per_driver?: number
          max_driver_find_time_minutes?: number
          max_offer_hops?: number
          max_offers_per_request?: number
          max_stacked_rides?: number
          max_waiting_bonus_minutes?: number
          min_advance_time_minutes?: number
          minimum_rating?: number
          no_show_charge_pence?: number
          offer_expiry_seconds?: number
          pickup_paid_waiting_enabled?: boolean
          pickup_paid_waiting_rate_pence_per_minute?: number
          pickup_radius_enabled?: boolean
          pickup_radius_meters?: number
          pickup_waiting_grace_period_seconds?: number
          pickup_waiting_max_minutes?: number | null
          priority_order?: string
          scheduled_ride_incentives_enabled?: boolean
          scheduled_rides_enabled?: boolean
          search_radius_expand_km?: number
          search_radius_max_km?: number
          search_radius_meters?: number
          search_radius_start_km?: number
          service_area_id?: string | null
          shortlist_limit?: number
          simulate_mode?: boolean
          stacked_allow_rider_opt_out?: boolean
          stacked_driver_incentive?: number
          stacked_max_detour_minutes?: number
          stacked_min_trip_distance_km?: number
          stacked_offer_layout?: string
          stacked_offer_window_minutes?: number
          stacked_priority_mode?: string
          stacked_rider_discount?: number
          stacked_rides_enabled?: boolean
          stacked_search_radius_meters?: number
          stacked_show_eta_to_driver?: boolean
          stop_radius_enabled?: boolean
          stop_radius_meters?: number
          stop_waiting_charge_interval_seconds?: number
          stop_waiting_grace_period_seconds?: number
          stop_waiting_max_minutes?: number | null
          stop_waiting_rate_pence_per_minute?: number
          suppress_recent_offers_seconds?: number
          updated_at?: string
          waiting_bonus_per_minute?: number
          waiting_time_grace_period_minutes?: number
          wave1_offer_expiry_seconds?: number
          wave1_size?: number
          wave2_offer_expiry_seconds?: number
          wave2_size?: number
          wave3_offer_expiry_seconds?: number
          wave3_size?: number
        }
        Update: {
          accept_timeout_seconds?: number
          auto_reassign_enabled?: boolean
          auto_retry_attempts?: number
          batch_mode?: string
          block_multiple_active_rides?: boolean
          cancel_protection?: boolean
          cancellation_fee_after_grace_pence?: number
          cascade_batch_size?: number
          cascade_step_delay_seconds?: number
          cooldown_after_reject_seconds?: number
          created_at?: string
          customer_response_timeout_seconds?: number
          distance_penalty_per_km?: number
          driver_fare_display?: string
          driver_final_response_timeout_seconds?: number
          enable_logging?: boolean
          enable_stop_waiting_charge?: boolean
          fairness_boost_score?: number
          fairness_idle_minutes?: number
          fare_negotiation_enabled?: boolean
          global_timeout_minutes?: number
          id?: string
          instant_retry_enabled?: boolean
          late_cancel_enabled?: boolean
          late_cancel_fee_pence?: number
          late_cancel_threshold_minutes?: number
          manual_emergency_dispatch_only?: boolean
          max_advance_days?: number
          max_cancel_rate?: number
          max_concurrent_offers_per_driver?: number
          max_driver_find_time_minutes?: number
          max_offer_hops?: number
          max_offers_per_request?: number
          max_stacked_rides?: number
          max_waiting_bonus_minutes?: number
          min_advance_time_minutes?: number
          minimum_rating?: number
          no_show_charge_pence?: number
          offer_expiry_seconds?: number
          pickup_paid_waiting_enabled?: boolean
          pickup_paid_waiting_rate_pence_per_minute?: number
          pickup_radius_enabled?: boolean
          pickup_radius_meters?: number
          pickup_waiting_grace_period_seconds?: number
          pickup_waiting_max_minutes?: number | null
          priority_order?: string
          scheduled_ride_incentives_enabled?: boolean
          scheduled_rides_enabled?: boolean
          search_radius_expand_km?: number
          search_radius_max_km?: number
          search_radius_meters?: number
          search_radius_start_km?: number
          service_area_id?: string | null
          shortlist_limit?: number
          simulate_mode?: boolean
          stacked_allow_rider_opt_out?: boolean
          stacked_driver_incentive?: number
          stacked_max_detour_minutes?: number
          stacked_min_trip_distance_km?: number
          stacked_offer_layout?: string
          stacked_offer_window_minutes?: number
          stacked_priority_mode?: string
          stacked_rider_discount?: number
          stacked_rides_enabled?: boolean
          stacked_search_radius_meters?: number
          stacked_show_eta_to_driver?: boolean
          stop_radius_enabled?: boolean
          stop_radius_meters?: number
          stop_waiting_charge_interval_seconds?: number
          stop_waiting_grace_period_seconds?: number
          stop_waiting_max_minutes?: number | null
          stop_waiting_rate_pence_per_minute?: number
          suppress_recent_offers_seconds?: number
          updated_at?: string
          waiting_bonus_per_minute?: number
          waiting_time_grace_period_minutes?: number
          wave1_offer_expiry_seconds?: number
          wave1_size?: number
          wave2_offer_expiry_seconds?: number
          wave2_size?: number
          wave3_offer_expiry_seconds?: number
          wave3_size?: number
        }
        Relationships: [
          {
            foreignKeyName: "dispatch_settings_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: true
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      dispatch_wave_snapshot: {
        Row: {
          created_at: string
          dispatch_round: number
          driver_id: string | null
          id: string
          metadata: Json
          ride_offer_id: string | null
          source: string | null
          stage: string
          trip_id: string
          wave_number: number
        }
        Insert: {
          created_at?: string
          dispatch_round?: number
          driver_id?: string | null
          id?: string
          metadata?: Json
          ride_offer_id?: string | null
          source?: string | null
          stage: string
          trip_id: string
          wave_number?: number
        }
        Update: {
          created_at?: string
          dispatch_round?: number
          driver_id?: string | null
          id?: string
          metadata?: Json
          ride_offer_id?: string | null
          source?: string | null
          stage?: string
          trip_id?: string
          wave_number?: number
        }
        Relationships: [
          {
            foreignKeyName: "dispatch_wave_snapshot_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_wave_snapshot_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "dispatch_wave_snapshot_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "dispatch_wave_snapshot_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "dispatch_wave_snapshot_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_wave_snapshot_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_wave_snapshot_ride_offer_id_fkey"
            columns: ["ride_offer_id"]
            isOneToOne: false
            referencedRelation: "ride_offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_wave_snapshot_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_wave_snapshot_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "dispatch_wave_snapshot_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      dispatch_wave_snapshots: {
        Row: {
          candidate_count: number
          created_at: string
          degraded_count: number
          dispatch_round: number
          eligible_count: number
          errors: Json | null
          hard_excluded_count: number
          id: string
          offer_created_count: number
          previous_round_drivers: Json
          reason_for_next_wave: string | null
          search_radius_meters: number
          selected_count: number
          selected_drivers: Json
          trigger_reason: string
          trip_id: string
          wave_cap: number
        }
        Insert: {
          candidate_count?: number
          created_at?: string
          degraded_count?: number
          dispatch_round: number
          eligible_count?: number
          errors?: Json | null
          hard_excluded_count?: number
          id?: string
          offer_created_count?: number
          previous_round_drivers?: Json
          reason_for_next_wave?: string | null
          search_radius_meters?: number
          selected_count?: number
          selected_drivers?: Json
          trigger_reason?: string
          trip_id: string
          wave_cap?: number
        }
        Update: {
          candidate_count?: number
          created_at?: string
          degraded_count?: number
          dispatch_round?: number
          eligible_count?: number
          errors?: Json | null
          hard_excluded_count?: number
          id?: string
          offer_created_count?: number
          previous_round_drivers?: Json
          reason_for_next_wave?: string | null
          search_radius_meters?: number
          selected_count?: number
          selected_drivers?: Json
          trigger_reason?: string
          trip_id?: string
          wave_cap?: number
        }
        Relationships: []
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
          show_in_driver_app: boolean
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
          show_in_driver_app?: boolean
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
          show_in_driver_app?: boolean
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
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "documents_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
      driver_active_devices: {
        Row: {
          created_at: string
          device_id: string
          device_label: string | null
          driver_id: string
          last_seen_at: string
          platform: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          device_id: string
          device_label?: string | null
          driver_id: string
          last_seen_at?: string
          platform: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          device_id?: string
          device_label?: string | null
          driver_id?: string
          last_seen_at?: string
          platform?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_active_devices_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_active_devices_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_active_devices_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_active_devices_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_active_devices_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_active_devices_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_alerts: {
        Row: {
          alert_type: string
          booking_id: string | null
          context: Json
          created_at: string
          driver_id: string
          first_detected_at: string
          id: string
          last_detected_at: string
          message: string
          resolved_at: string | null
          severity: Database["public"]["Enums"]["driver_alert_severity"]
          status: Database["public"]["Enums"]["driver_alert_status"]
          updated_at: string
        }
        Insert: {
          alert_type: string
          booking_id?: string | null
          context?: Json
          created_at?: string
          driver_id: string
          first_detected_at?: string
          id?: string
          last_detected_at?: string
          message: string
          resolved_at?: string | null
          severity?: Database["public"]["Enums"]["driver_alert_severity"]
          status?: Database["public"]["Enums"]["driver_alert_status"]
          updated_at?: string
        }
        Update: {
          alert_type?: string
          booking_id?: string | null
          context?: Json
          created_at?: string
          driver_id?: string
          first_detected_at?: string
          id?: string
          last_detected_at?: string
          message?: string
          resolved_at?: string | null
          severity?: Database["public"]["Enums"]["driver_alert_severity"]
          status?: Database["public"]["Enums"]["driver_alert_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_alerts_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_alerts_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_alerts_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_alerts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_alerts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_alerts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_alerts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_alerts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_alerts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_categories: {
        Row: {
          category_priority: number
          color: string | null
          commission_pct: number | null
          created_at: string
          description: string | null
          display_order: number | null
          icon: string | null
          id: string
          is_active: boolean
          level_order: number | null
          min_rating: number | null
          min_trips: number | null
          name: string
          requirements: string[] | null
          trip_target: number | null
          updated_at: string
        }
        Insert: {
          category_priority?: number
          color?: string | null
          commission_pct?: number | null
          created_at?: string
          description?: string | null
          display_order?: number | null
          icon?: string | null
          id?: string
          is_active?: boolean
          level_order?: number | null
          min_rating?: number | null
          min_trips?: number | null
          name: string
          requirements?: string[] | null
          trip_target?: number | null
          updated_at?: string
        }
        Update: {
          category_priority?: number
          color?: string | null
          commission_pct?: number | null
          created_at?: string
          description?: string | null
          display_order?: number | null
          icon?: string | null
          id?: string
          is_active?: boolean
          level_order?: number | null
          min_rating?: number | null
          min_trips?: number | null
          name?: string
          requirements?: string[] | null
          trip_target?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      driver_commitment_sessions: {
        Row: {
          created_at: string
          driver_id: string
          id: string
          last_distance_m: number | null
          last_progress_at: string
          min_distance_m: number | null
          moving_away_warned_at: string | null
          no_progress_warned_at: string | null
          pickup_lat: number
          pickup_lng: number
          started_at: string
          stop_reason: string | null
          stopped_at: string | null
          trip_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          driver_id: string
          id?: string
          last_distance_m?: number | null
          last_progress_at?: string
          min_distance_m?: number | null
          moving_away_warned_at?: string | null
          no_progress_warned_at?: string | null
          pickup_lat: number
          pickup_lng: number
          started_at?: string
          stop_reason?: string | null
          stopped_at?: string | null
          trip_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          driver_id?: string
          id?: string
          last_distance_m?: number | null
          last_progress_at?: string
          min_distance_m?: number | null
          moving_away_warned_at?: string | null
          no_progress_warned_at?: string | null
          pickup_lat?: number
          pickup_lng?: number
          started_at?: string
          stop_reason?: string | null
          stopped_at?: string | null
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_commitment_sessions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_commitment_sessions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_commitment_sessions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_commitment_sessions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_commitment_sessions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_commitment_sessions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_commitment_sessions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: true
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_commitment_sessions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: true
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_commitment_sessions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: true
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_commitment_warnings: {
        Row: {
          created_at: string
          driver_id: string
          id: string
          message: string
          session_id: string
          trip_id: string
          warning_type: string
        }
        Insert: {
          created_at?: string
          driver_id: string
          id?: string
          message: string
          session_id: string
          trip_id: string
          warning_type: string
        }
        Update: {
          created_at?: string
          driver_id?: string
          id?: string
          message?: string
          session_id?: string
          trip_id?: string
          warning_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_commitment_warnings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_commitment_warnings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_commitment_warnings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_commitment_warnings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_commitment_warnings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_commitment_warnings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_commitment_warnings_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "driver_commitment_sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_commitment_warnings_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_commitment_warnings_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_commitment_warnings_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_demand_zones: {
        Row: {
          active: boolean
          center_lat: number
          center_lng: number
          created_at: string
          demand_level: string
          id: string
          name: string
          radius_meters: number
          region_id: string | null
          service_area_id: string | null
          source: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          center_lat: number
          center_lng: number
          created_at?: string
          demand_level?: string
          id?: string
          name: string
          radius_meters?: number
          region_id?: string | null
          service_area_id?: string | null
          source?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          center_lat?: number
          center_lng?: number
          created_at?: string
          demand_level?: string
          id?: string
          name?: string
          radius_meters?: number
          region_id?: string | null
          service_area_id?: string | null
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_demand_zones_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_demand_zones_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_early_cashouts: {
        Row: {
          created_at: string
          currency: string
          driver_id: string
          driver_receives_pence: number
          early_cashout_fee_pence: number
          failed_at: string | null
          failure_reason: string | null
          id: string
          idempotency_key: string
          ledger_cashout_id: string | null
          ledger_fee_id: string | null
          onecab_cashout_fee_pence: number
          paid_at: string | null
          payout_method: string | null
          payout_type: string
          requested_cashout_pence: number
          status: string
          stripe_fee_pence: number | null
          stripe_instant_available_before_pence: number | null
          stripe_method: string
          stripe_payout_id: string | null
          stripe_transfer_id: string | null
          updated_at: string
          wallet_after_pence: number | null
          wallet_before_pence: number | null
        }
        Insert: {
          created_at?: string
          currency?: string
          driver_id: string
          driver_receives_pence: number
          early_cashout_fee_pence: number
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          idempotency_key: string
          ledger_cashout_id?: string | null
          ledger_fee_id?: string | null
          onecab_cashout_fee_pence: number
          paid_at?: string | null
          payout_method?: string | null
          payout_type?: string
          requested_cashout_pence: number
          status?: string
          stripe_fee_pence?: number | null
          stripe_instant_available_before_pence?: number | null
          stripe_method?: string
          stripe_payout_id?: string | null
          stripe_transfer_id?: string | null
          updated_at?: string
          wallet_after_pence?: number | null
          wallet_before_pence?: number | null
        }
        Update: {
          created_at?: string
          currency?: string
          driver_id?: string
          driver_receives_pence?: number
          early_cashout_fee_pence?: number
          failed_at?: string | null
          failure_reason?: string | null
          id?: string
          idempotency_key?: string
          ledger_cashout_id?: string | null
          ledger_fee_id?: string | null
          onecab_cashout_fee_pence?: number
          paid_at?: string | null
          payout_method?: string | null
          payout_type?: string
          requested_cashout_pence?: number
          status?: string
          stripe_fee_pence?: number | null
          stripe_instant_available_before_pence?: number | null
          stripe_method?: string
          stripe_payout_id?: string | null
          stripe_transfer_id?: string | null
          updated_at?: string
          wallet_after_pence?: number | null
          wallet_before_pence?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_early_cashouts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_early_cashouts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_early_cashouts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_early_cashouts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_early_cashouts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_early_cashouts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_early_cashouts_ledger_cashout_id_fkey"
            columns: ["ledger_cashout_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_early_cashouts_ledger_cashout_id_fkey"
            columns: ["ledger_cashout_id"]
            isOneToOne: false
            referencedRelation: "v_finance_era_digital"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_early_cashouts_ledger_cashout_id_fkey"
            columns: ["ledger_cashout_id"]
            isOneToOne: false
            referencedRelation: "v_finance_era_legacy_cash"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_early_cashouts_ledger_fee_id_fkey"
            columns: ["ledger_fee_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_early_cashouts_ledger_fee_id_fkey"
            columns: ["ledger_fee_id"]
            isOneToOne: false
            referencedRelation: "v_finance_era_digital"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_early_cashouts_ledger_fee_id_fkey"
            columns: ["ledger_fee_id"]
            isOneToOne: false
            referencedRelation: "v_finance_era_legacy_cash"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_earning_settlement: {
        Row: {
          allocated_amount_pence: number
          allocated_at: string | null
          allocated_to_payout: boolean
          capture_time: string | null
          created_at: string
          driver_id: string
          eligible_for_payout: boolean
          id: string
          ineligible_reason: string | null
          ledger_entry_id: string
          paid_at: string | null
          paid_in_batch_id: string | null
          paid_in_payout_item_id: string | null
          payment_id: string | null
          settled_at: string | null
          settlement_lifecycle_status: string
          settlement_status: string
          stripe_available_on: string | null
          stripe_balance_tx_id: string | null
          stripe_charge_id: string | null
          stripe_transfer_id: string | null
          trip_id: string | null
          updated_at: string
        }
        Insert: {
          allocated_amount_pence?: number
          allocated_at?: string | null
          allocated_to_payout?: boolean
          capture_time?: string | null
          created_at?: string
          driver_id: string
          eligible_for_payout?: boolean
          id?: string
          ineligible_reason?: string | null
          ledger_entry_id: string
          paid_at?: string | null
          paid_in_batch_id?: string | null
          paid_in_payout_item_id?: string | null
          payment_id?: string | null
          settled_at?: string | null
          settlement_lifecycle_status?: string
          settlement_status?: string
          stripe_available_on?: string | null
          stripe_balance_tx_id?: string | null
          stripe_charge_id?: string | null
          stripe_transfer_id?: string | null
          trip_id?: string | null
          updated_at?: string
        }
        Update: {
          allocated_amount_pence?: number
          allocated_at?: string | null
          allocated_to_payout?: boolean
          capture_time?: string | null
          created_at?: string
          driver_id?: string
          eligible_for_payout?: boolean
          id?: string
          ineligible_reason?: string | null
          ledger_entry_id?: string
          paid_at?: string | null
          paid_in_batch_id?: string | null
          paid_in_payout_item_id?: string | null
          payment_id?: string | null
          settled_at?: string | null
          settlement_lifecycle_status?: string
          settlement_status?: string
          stripe_available_on?: string | null
          stripe_balance_tx_id?: string | null
          stripe_charge_id?: string | null
          stripe_transfer_id?: string | null
          trip_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_earning_settlement_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_earning_settlement_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_earning_settlement_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_earning_settlement_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_earning_settlement_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_earning_settlement_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_earning_settlement_ledger_entry_id_fkey"
            columns: ["ledger_entry_id"]
            isOneToOne: true
            referencedRelation: "driver_wallet_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_earning_settlement_ledger_entry_id_fkey"
            columns: ["ledger_entry_id"]
            isOneToOne: true
            referencedRelation: "v_finance_era_digital"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_earning_settlement_ledger_entry_id_fkey"
            columns: ["ledger_entry_id"]
            isOneToOne: true
            referencedRelation: "v_finance_era_legacy_cash"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_earning_settlement_paid_in_batch_id_fkey"
            columns: ["paid_in_batch_id"]
            isOneToOne: false
            referencedRelation: "payout_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_earning_settlement_paid_in_payout_item_id_fkey"
            columns: ["paid_in_payout_item_id"]
            isOneToOne: false
            referencedRelation: "payout_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_earning_settlement_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_earning_settlement_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_earning_settlement_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_earning_settlement_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_inbox_messages: {
        Row: {
          body: string
          created_at: string
          dismissed_at: string | null
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
          dismissed_at?: string | null
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
          dismissed_at?: string | null
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
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_inbox_messages_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_inbox_messages_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
      driver_invoice_dismissals: {
        Row: {
          dismissed_at: string
          driver_id: string
          id: string
          invoice_id: string
        }
        Insert: {
          dismissed_at?: string
          driver_id: string
          id?: string
          invoice_id: string
        }
        Update: {
          dismissed_at?: string
          driver_id?: string
          id?: string
          invoice_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_invoice_dismissals_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_invoice_dismissals_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_invoice_dismissals_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_invoice_dismissals_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_invoice_dismissals_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_invoice_dismissals_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_invoice_dismissals_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_invoice_monthly_sequences: {
        Row: {
          invoice_month: string
          last_seq: number
        }
        Insert: {
          invoice_month: string
          last_seq?: number
        }
        Update: {
          invoice_month?: string
          last_seq?: number
        }
        Relationships: []
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
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_ledger_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
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
      driver_live_locations: {
        Row: {
          driver_id: string
          geohash6: string
          heading: number | null
          lat: number
          lng: number
          loc: unknown
          speed: number | null
          updated_at: string
        }
        Insert: {
          driver_id: string
          geohash6: string
          heading?: number | null
          lat: number
          lng: number
          loc: unknown
          speed?: number | null
          updated_at?: string
        }
        Update: {
          driver_id?: string
          geohash6?: string
          heading?: number | null
          lat?: number
          lng?: number
          loc?: unknown
          speed?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_live_locations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_live_locations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_live_locations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_live_locations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_live_locations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_live_locations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_payout_destination_audit: {
        Row: {
          action: string
          changed_by_role: string | null
          changed_by_user_id: string
          created_at: string
          destination_type: string | null
          device_id: string | null
          driver_id: string
          id: string
          ip_address: string | null
          metadata: Json | null
          new_payload: Json | null
          new_payout_account_id: string | null
          old_payout_account_id: string | null
          previous_payload: Json | null
          provider: string
        }
        Insert: {
          action: string
          changed_by_role?: string | null
          changed_by_user_id: string
          created_at?: string
          destination_type?: string | null
          device_id?: string | null
          driver_id: string
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          new_payload?: Json | null
          new_payout_account_id?: string | null
          old_payout_account_id?: string | null
          previous_payload?: Json | null
          provider: string
        }
        Update: {
          action?: string
          changed_by_role?: string | null
          changed_by_user_id?: string
          created_at?: string
          destination_type?: string | null
          device_id?: string | null
          driver_id?: string
          id?: string
          ip_address?: string | null
          metadata?: Json | null
          new_payload?: Json | null
          new_payout_account_id?: string | null
          old_payout_account_id?: string | null
          previous_payload?: Json | null
          provider?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_payout_destination_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_new_payout_account_id_fkey"
            columns: ["new_payout_account_id"]
            isOneToOne: false
            referencedRelation: "driver_payout_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_new_payout_account_id_fkey"
            columns: ["new_payout_account_id"]
            isOneToOne: false
            referencedRelation: "driver_payout_destinations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_old_payout_account_id_fkey"
            columns: ["old_payout_account_id"]
            isOneToOne: false
            referencedRelation: "driver_payout_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_old_payout_account_id_fkey"
            columns: ["old_payout_account_id"]
            isOneToOne: false
            referencedRelation: "driver_payout_destinations"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_payout_destinations: {
        Row: {
          account_holder_name: string | null
          archived_at: string | null
          created_at: string
          currency_code: string | null
          destination_identifier_encrypted: string | null
          destination_label: string | null
          destination_last4: string | null
          destination_payload: Json
          destination_type: string
          driver_id: string
          id: string
          is_active: boolean
          provider: string
          service_area_id: string | null
          updated_at: string
        }
        Insert: {
          account_holder_name?: string | null
          archived_at?: string | null
          created_at?: string
          currency_code?: string | null
          destination_identifier_encrypted?: string | null
          destination_label?: string | null
          destination_last4?: string | null
          destination_payload?: Json
          destination_type?: string
          driver_id: string
          id?: string
          is_active?: boolean
          provider: string
          service_area_id?: string | null
          updated_at?: string
        }
        Update: {
          account_holder_name?: string | null
          archived_at?: string | null
          created_at?: string
          currency_code?: string | null
          destination_identifier_encrypted?: string | null
          destination_label?: string | null
          destination_last4?: string | null
          destination_payload?: Json
          destination_type?: string
          driver_id?: string
          id?: string
          is_active?: boolean
          provider?: string
          service_area_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_payout_destinations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destinations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_payout_destinations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_payout_destinations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_payout_destinations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destinations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destinations_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_presence: {
        Row: {
          accuracy_m: number | null
          app_state: string
          battery_level: number | null
          created_at: string
          driver_id: string
          heading: number | null
          last_heartbeat_at: string
          last_location_at: string | null
          last_offline_at: string | null
          last_realtime_seen_at: string | null
          last_significant_move_at: string | null
          last_significant_move_lat: number | null
          last_significant_move_lng: number | null
          last_socket_pong_at: string | null
          lat: number | null
          lng: number | null
          low_accuracy: boolean
          low_accuracy_since: string | null
          network_type: string | null
          offline_reason: string | null
          platform: string | null
          presence_health: string
          push_token: string | null
          socket_connected: boolean | null
          speed: number | null
          status: string
          unresolved_critical_tracking: boolean
          updated_at: string
        }
        Insert: {
          accuracy_m?: number | null
          app_state?: string
          battery_level?: number | null
          created_at?: string
          driver_id: string
          heading?: number | null
          last_heartbeat_at?: string
          last_location_at?: string | null
          last_offline_at?: string | null
          last_realtime_seen_at?: string | null
          last_significant_move_at?: string | null
          last_significant_move_lat?: number | null
          last_significant_move_lng?: number | null
          last_socket_pong_at?: string | null
          lat?: number | null
          lng?: number | null
          low_accuracy?: boolean
          low_accuracy_since?: string | null
          network_type?: string | null
          offline_reason?: string | null
          platform?: string | null
          presence_health?: string
          push_token?: string | null
          socket_connected?: boolean | null
          speed?: number | null
          status?: string
          unresolved_critical_tracking?: boolean
          updated_at?: string
        }
        Update: {
          accuracy_m?: number | null
          app_state?: string
          battery_level?: number | null
          created_at?: string
          driver_id?: string
          heading?: number | null
          last_heartbeat_at?: string
          last_location_at?: string | null
          last_offline_at?: string | null
          last_realtime_seen_at?: string | null
          last_significant_move_at?: string | null
          last_significant_move_lat?: number | null
          last_significant_move_lng?: number | null
          last_socket_pong_at?: string | null
          lat?: number | null
          lng?: number | null
          low_accuracy?: boolean
          low_accuracy_since?: string | null
          network_type?: string | null
          offline_reason?: string | null
          platform?: string | null
          presence_health?: string
          push_token?: string | null
          socket_connected?: boolean | null
          speed?: number | null
          status?: string
          unresolved_critical_tracking?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_presence_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_presence_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_presence_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_presence_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_presence_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_presence_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "drivers"
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
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_service_areas_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_service_areas_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
          accept_delivery_jobs: boolean
          auto_accept: boolean
          created_at: string
          delivery_category_preferences: Json
          driver_id: string
          id: string
          max_pickup_distance_miles: number
          preferred_map_service: string
          saved_destinations: Json | null
          sound_alerts: boolean
          theme: string
          towards_destination_active: boolean
          towards_destination_address: string | null
          towards_destination_last_reset: string | null
          towards_destination_lat: number | null
          towards_destination_lng: number | null
          towards_destination_uses_today: number
          updated_at: string
        }
        Insert: {
          accept_cash?: boolean
          accept_delivery_jobs?: boolean
          auto_accept?: boolean
          created_at?: string
          delivery_category_preferences?: Json
          driver_id: string
          id?: string
          max_pickup_distance_miles?: number
          preferred_map_service?: string
          saved_destinations?: Json | null
          sound_alerts?: boolean
          theme?: string
          towards_destination_active?: boolean
          towards_destination_address?: string | null
          towards_destination_last_reset?: string | null
          towards_destination_lat?: number | null
          towards_destination_lng?: number | null
          towards_destination_uses_today?: number
          updated_at?: string
        }
        Update: {
          accept_cash?: boolean
          accept_delivery_jobs?: boolean
          auto_accept?: boolean
          created_at?: string
          delivery_category_preferences?: Json
          driver_id?: string
          id?: string
          max_pickup_distance_miles?: number
          preferred_map_service?: string
          saved_destinations?: Json | null
          sound_alerts?: boolean
          theme?: string
          towards_destination_active?: boolean
          towards_destination_address?: string | null
          towards_destination_last_reset?: string | null
          towards_destination_lat?: number | null
          towards_destination_lng?: number | null
          towards_destination_uses_today?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_settings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_settings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_settings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
      driver_statements: {
        Row: {
          adjustments_pence: number
          commission_pence: number
          created_at: string
          currency_code: string
          driver_id: string
          generated_at: string
          generated_by: string | null
          gross_earnings_pence: number
          id: string
          net_earnings_pence: number
          payouts_pence: number
          period_end: string
          period_start: string
          region_id: string
          service_area_id: string | null
          statement_data: Json | null
          status: string
          tips_pence: number
          total_trips: number
          updated_at: string
        }
        Insert: {
          adjustments_pence?: number
          commission_pence?: number
          created_at?: string
          currency_code: string
          driver_id: string
          generated_at?: string
          generated_by?: string | null
          gross_earnings_pence?: number
          id?: string
          net_earnings_pence?: number
          payouts_pence?: number
          period_end: string
          period_start: string
          region_id: string
          service_area_id?: string | null
          statement_data?: Json | null
          status?: string
          tips_pence?: number
          total_trips?: number
          updated_at?: string
        }
        Update: {
          adjustments_pence?: number
          commission_pence?: number
          created_at?: string
          currency_code?: string
          driver_id?: string
          generated_at?: string
          generated_by?: string | null
          gross_earnings_pence?: number
          id?: string
          net_earnings_pence?: number
          payouts_pence?: number
          period_end?: string
          period_start?: string
          region_id?: string
          service_area_id?: string | null
          statement_data?: Json | null
          status?: string
          tips_pence?: number
          total_trips?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_statements_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_statements_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_statements_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_statements_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_statements_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_statements_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_statements_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_statements_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_support_tickets: {
        Row: {
          admin_reply: string | null
          created_at: string
          driver_id: string
          id: string
          message: string
          priority: string
          replied_at: string | null
          replied_by: string | null
          status: string
          subject: string
          updated_at: string
        }
        Insert: {
          admin_reply?: string | null
          created_at?: string
          driver_id: string
          id?: string
          message: string
          priority?: string
          replied_at?: string | null
          replied_by?: string | null
          status?: string
          subject: string
          updated_at?: string
        }
        Update: {
          admin_reply?: string | null
          created_at?: string
          driver_id?: string
          id?: string
          message?: string
          priority?: string
          replied_at?: string | null
          replied_by?: string | null
          status?: string
          subject?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_support_tickets_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_support_tickets_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_support_tickets_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_support_tickets_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_support_tickets_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_support_tickets_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
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
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_vehicle_categories_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_vehicle_categories_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
      driver_wallet_ledger: {
        Row: {
          amount_pence: number
          created_at: string
          currency: string
          description: string | null
          driver_id: string
          id: string
          related_trip_id: string | null
          service_area_id: string | null
          stripe_payout_id: string | null
          stripe_transfer_id: string | null
          type: string
        }
        Insert: {
          amount_pence: number
          created_at?: string
          currency?: string
          description?: string | null
          driver_id: string
          id?: string
          related_trip_id?: string | null
          service_area_id?: string | null
          stripe_payout_id?: string | null
          stripe_transfer_id?: string | null
          type: string
        }
        Update: {
          amount_pence?: number
          created_at?: string
          currency?: string
          description?: string | null
          driver_id?: string
          id?: string
          related_trip_id?: string | null
          service_area_id?: string | null
          stripe_payout_id?: string | null
          stripe_transfer_id?: string | null
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_related_trip_id_fkey"
            columns: ["related_trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_related_trip_id_fkey"
            columns: ["related_trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_related_trip_id_fkey"
            columns: ["related_trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_wallets: {
        Row: {
          available_pence: number
          driver_id: string
          id: string
          lifetime_earned_pence: number
          pending_pence: number
          updated_at: string
        }
        Insert: {
          available_pence?: number
          driver_id: string
          id?: string
          lifetime_earned_pence?: number
          pending_pence?: number
          updated_at?: string
        }
        Update: {
          available_pence?: number
          driver_id?: string
          id?: string
          lifetime_earned_pence?: number
          pending_pence?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "driver_wallets_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallets_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_wallets_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_wallets_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_wallets_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallets_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: true
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      drivers: {
        Row: {
          approval_status: string
          business_website_url: string | null
          category_id: string | null
          charges_enabled: boolean | null
          city: string | null
          country: string | null
          country_code: string | null
          created_at: string
          current_lat: number | null
          current_lng: number | null
          current_trip_id: string | null
          deleted_at: string | null
          display_rating: number
          documents_approved: boolean
          driver_code: string | null
          driver_online_intent: boolean
          driver_status: Database["public"]["Enums"]["driver_status"]
          email: string
          email_verified: boolean
          email_verified_at: string | null
          first_name: string
          heading: number | null
          id: string
          is_online: boolean
          is_pet_friendly: boolean
          last_location_updated_at: string | null
          last_name: string
          last_offer_at: string | null
          last_seen_at: string | null
          last_trip_end_at: string | null
          onboarding_complete: boolean | null
          online_since: string | null
          payouts_enabled: boolean | null
          pending_email_change: string | null
          pending_email_change_expires_at: string | null
          pending_email_change_requested_at: string | null
          pending_email_change_verified_at: string | null
          pending_phone_change: string | null
          pending_phone_change_expires_at: string | null
          pending_phone_change_otp_sent_at: string | null
          pending_phone_change_requested_at: string | null
          pending_phone_change_verified_at: string | null
          phone: string
          phone_verified: boolean
          phone_verified_at: string | null
          postcode: string | null
          profile_photo_url: string | null
          rating: number | null
          rating_count: number
          rating_sum: number
          region_id: string
          residential_address: string | null
          service_area_id: string | null
          speed: number | null
          stripe_account_id: string | null
          total_trips: number | null
          updated_at: string
          user_id: string
          using_platform_business_profile: boolean
          vehicle_edit_request_status: string | null
          vehicle_locked: boolean
        }
        Insert: {
          approval_status?: string
          business_website_url?: string | null
          category_id?: string | null
          charges_enabled?: boolean | null
          city?: string | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          current_lat?: number | null
          current_lng?: number | null
          current_trip_id?: string | null
          deleted_at?: string | null
          display_rating?: number
          documents_approved?: boolean
          driver_code?: string | null
          driver_online_intent?: boolean
          driver_status?: Database["public"]["Enums"]["driver_status"]
          email: string
          email_verified?: boolean
          email_verified_at?: string | null
          first_name: string
          heading?: number | null
          id?: string
          is_online?: boolean
          is_pet_friendly?: boolean
          last_location_updated_at?: string | null
          last_name: string
          last_offer_at?: string | null
          last_seen_at?: string | null
          last_trip_end_at?: string | null
          onboarding_complete?: boolean | null
          online_since?: string | null
          payouts_enabled?: boolean | null
          pending_email_change?: string | null
          pending_email_change_expires_at?: string | null
          pending_email_change_requested_at?: string | null
          pending_email_change_verified_at?: string | null
          pending_phone_change?: string | null
          pending_phone_change_expires_at?: string | null
          pending_phone_change_otp_sent_at?: string | null
          pending_phone_change_requested_at?: string | null
          pending_phone_change_verified_at?: string | null
          phone: string
          phone_verified?: boolean
          phone_verified_at?: string | null
          postcode?: string | null
          profile_photo_url?: string | null
          rating?: number | null
          rating_count?: number
          rating_sum?: number
          region_id: string
          residential_address?: string | null
          service_area_id?: string | null
          speed?: number | null
          stripe_account_id?: string | null
          total_trips?: number | null
          updated_at?: string
          user_id: string
          using_platform_business_profile?: boolean
          vehicle_edit_request_status?: string | null
          vehicle_locked?: boolean
        }
        Update: {
          approval_status?: string
          business_website_url?: string | null
          category_id?: string | null
          charges_enabled?: boolean | null
          city?: string | null
          country?: string | null
          country_code?: string | null
          created_at?: string
          current_lat?: number | null
          current_lng?: number | null
          current_trip_id?: string | null
          deleted_at?: string | null
          display_rating?: number
          documents_approved?: boolean
          driver_code?: string | null
          driver_online_intent?: boolean
          driver_status?: Database["public"]["Enums"]["driver_status"]
          email?: string
          email_verified?: boolean
          email_verified_at?: string | null
          first_name?: string
          heading?: number | null
          id?: string
          is_online?: boolean
          is_pet_friendly?: boolean
          last_location_updated_at?: string | null
          last_name?: string
          last_offer_at?: string | null
          last_seen_at?: string | null
          last_trip_end_at?: string | null
          onboarding_complete?: boolean | null
          online_since?: string | null
          payouts_enabled?: boolean | null
          pending_email_change?: string | null
          pending_email_change_expires_at?: string | null
          pending_email_change_requested_at?: string | null
          pending_email_change_verified_at?: string | null
          pending_phone_change?: string | null
          pending_phone_change_expires_at?: string | null
          pending_phone_change_otp_sent_at?: string | null
          pending_phone_change_requested_at?: string | null
          pending_phone_change_verified_at?: string | null
          phone?: string
          phone_verified?: boolean
          phone_verified_at?: string | null
          postcode?: string | null
          profile_photo_url?: string | null
          rating?: number | null
          rating_count?: number
          rating_sum?: number
          region_id?: string
          residential_address?: string | null
          service_area_id?: string | null
          speed?: number | null
          stripe_account_id?: string | null
          total_trips?: number | null
          updated_at?: string
          user_id?: string
          using_platform_business_profile?: boolean
          vehicle_edit_request_status?: string | null
          vehicle_locked?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "drivers_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "driver_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drivers_current_trip_id_fkey"
            columns: ["current_trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drivers_current_trip_id_fkey"
            columns: ["current_trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
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
          {
            foreignKeyName: "drivers_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      faqs: {
        Row: {
          answer: string
          category: string | null
          created_at: string
          display_order: number
          id: string
          is_active: boolean
          question: string
          updated_at: string
        }
        Insert: {
          answer: string
          category?: string | null
          created_at?: string
          display_order?: number
          id?: string
          is_active?: boolean
          question: string
          updated_at?: string
        }
        Update: {
          answer?: string
          category?: string | null
          created_at?: string
          display_order?: number
          id?: string
          is_active?: boolean
          question?: string
          updated_at?: string
        }
        Relationships: []
      }
      fare_audit_logs: {
        Row: {
          adjustment_pence: number | null
          created_at: string
          event_type: string
          id: string
          metadata: Json | null
          new_fare_pence: number | null
          old_fare_pence: number | null
          reason: string | null
          trip_id: string
        }
        Insert: {
          adjustment_pence?: number | null
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json | null
          new_fare_pence?: number | null
          old_fare_pence?: number | null
          reason?: string | null
          trip_id: string
        }
        Update: {
          adjustment_pence?: number | null
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json | null
          new_fare_pence?: number | null
          old_fare_pence?: number | null
          reason?: string | null
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "fare_audit_logs_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fare_audit_logs_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fare_audit_logs_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      fare_pricing_settings: {
        Row: {
          airport_charge_pence: number
          arrival_cancellation_after_arrival_only: boolean
          arrival_cancellation_apply_after_free_waiting_expired: boolean
          arrival_cancellation_enabled: boolean
          arrival_cancellation_fee_pence: number
          base_fare_pence: number
          booking_fee_pence: number
          cancellation_apply_after_arrival_only: boolean
          cancellation_fee_pence: number
          cancellation_grace_period_minutes: number
          created_at: string
          currency_code: string
          demand_supply_multiplier: number
          distance_pricing_bands: Json | null
          enable_surge: boolean
          extra_stop_flat_fee_pence: number
          free_waiting_minutes: number
          id: string
          late_cancel_airport_fare_threshold_pence: number
          late_cancel_airport_fee_percentage: number
          late_cancel_airport_fee_type: string
          late_cancel_airport_protection_enabled: boolean
          late_cancel_airport_protection_trigger: string
          late_cancel_enabled: boolean
          late_cancel_fee_pence: number
          late_cancel_threshold_minutes: number
          minimum_fare_pence: number
          no_show_apply_after_arrival_only: boolean
          no_show_fee_pence: number
          no_show_wait_time_minutes: number
          peak_hour_multiplier: number
          per_km_rate_pence: number
          per_min_rate_pence: number
          pickup_paid_waiting_enabled: boolean
          pickup_waiting_max_minutes: number | null
          pricing_mode: string
          recalculate_on_dropoff_changed: boolean
          recalculate_on_stop_added: boolean
          recalculate_on_waiting: boolean
          service_area_id: string
          stop_waiting_grace_period_minutes: number
          stop_waiting_max_minutes: number | null
          stop_waiting_rate_pence_per_minute: number
          surge_multiplier_default: number
          traffic_multiplier: number
          updated_at: string
          vehicle_type_id: string | null
          waiting_per_minute_pence: number
          zone_multiplier: number
        }
        Insert: {
          airport_charge_pence?: number
          arrival_cancellation_after_arrival_only?: boolean
          arrival_cancellation_apply_after_free_waiting_expired?: boolean
          arrival_cancellation_enabled?: boolean
          arrival_cancellation_fee_pence?: number
          base_fare_pence?: number
          booking_fee_pence?: number
          cancellation_apply_after_arrival_only?: boolean
          cancellation_fee_pence?: number
          cancellation_grace_period_minutes?: number
          created_at?: string
          currency_code?: string
          demand_supply_multiplier?: number
          distance_pricing_bands?: Json | null
          enable_surge?: boolean
          extra_stop_flat_fee_pence?: number
          free_waiting_minutes?: number
          id?: string
          late_cancel_airport_fare_threshold_pence?: number
          late_cancel_airport_fee_percentage?: number
          late_cancel_airport_fee_type?: string
          late_cancel_airport_protection_enabled?: boolean
          late_cancel_airport_protection_trigger?: string
          late_cancel_enabled?: boolean
          late_cancel_fee_pence?: number
          late_cancel_threshold_minutes?: number
          minimum_fare_pence?: number
          no_show_apply_after_arrival_only?: boolean
          no_show_fee_pence?: number
          no_show_wait_time_minutes?: number
          peak_hour_multiplier?: number
          per_km_rate_pence?: number
          per_min_rate_pence?: number
          pickup_paid_waiting_enabled?: boolean
          pickup_waiting_max_minutes?: number | null
          pricing_mode?: string
          recalculate_on_dropoff_changed?: boolean
          recalculate_on_stop_added?: boolean
          recalculate_on_waiting?: boolean
          service_area_id: string
          stop_waiting_grace_period_minutes?: number
          stop_waiting_max_minutes?: number | null
          stop_waiting_rate_pence_per_minute?: number
          surge_multiplier_default?: number
          traffic_multiplier?: number
          updated_at?: string
          vehicle_type_id?: string | null
          waiting_per_minute_pence?: number
          zone_multiplier?: number
        }
        Update: {
          airport_charge_pence?: number
          arrival_cancellation_after_arrival_only?: boolean
          arrival_cancellation_apply_after_free_waiting_expired?: boolean
          arrival_cancellation_enabled?: boolean
          arrival_cancellation_fee_pence?: number
          base_fare_pence?: number
          booking_fee_pence?: number
          cancellation_apply_after_arrival_only?: boolean
          cancellation_fee_pence?: number
          cancellation_grace_period_minutes?: number
          created_at?: string
          currency_code?: string
          demand_supply_multiplier?: number
          distance_pricing_bands?: Json | null
          enable_surge?: boolean
          extra_stop_flat_fee_pence?: number
          free_waiting_minutes?: number
          id?: string
          late_cancel_airport_fare_threshold_pence?: number
          late_cancel_airport_fee_percentage?: number
          late_cancel_airport_fee_type?: string
          late_cancel_airport_protection_enabled?: boolean
          late_cancel_airport_protection_trigger?: string
          late_cancel_enabled?: boolean
          late_cancel_fee_pence?: number
          late_cancel_threshold_minutes?: number
          minimum_fare_pence?: number
          no_show_apply_after_arrival_only?: boolean
          no_show_fee_pence?: number
          no_show_wait_time_minutes?: number
          peak_hour_multiplier?: number
          per_km_rate_pence?: number
          per_min_rate_pence?: number
          pickup_paid_waiting_enabled?: boolean
          pickup_waiting_max_minutes?: number | null
          pricing_mode?: string
          recalculate_on_dropoff_changed?: boolean
          recalculate_on_stop_added?: boolean
          recalculate_on_waiting?: boolean
          service_area_id?: string
          stop_waiting_grace_period_minutes?: number
          stop_waiting_max_minutes?: number | null
          stop_waiting_rate_pence_per_minute?: number
          surge_multiplier_default?: number
          traffic_multiplier?: number
          updated_at?: string
          vehicle_type_id?: string | null
          waiting_per_minute_pence?: number
          zone_multiplier?: number
        }
        Relationships: [
          {
            foreignKeyName: "fare_pricing_settings_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fare_pricing_settings_vehicle_type_id_fkey"
            columns: ["vehicle_type_id"]
            isOneToOne: false
            referencedRelation: "vehicle_types"
            referencedColumns: ["id"]
          },
        ]
      }
      finance_reconciliation_notes: {
        Row: {
          classification: string | null
          created_at: string
          driver_id: string
          id: string
          ledger_debit_pence: number
          ledger_entry_id: string | null
          metadata: Json
          note: string
          operational_loss_pence: number
          reference_doc: string | null
          remediation_option: string
          stripe_payout_amount_pence: number
          stripe_payout_id: string
        }
        Insert: {
          classification?: string | null
          created_at?: string
          driver_id: string
          id?: string
          ledger_debit_pence: number
          ledger_entry_id?: string | null
          metadata?: Json
          note: string
          operational_loss_pence?: number
          reference_doc?: string | null
          remediation_option: string
          stripe_payout_amount_pence: number
          stripe_payout_id: string
        }
        Update: {
          classification?: string | null
          created_at?: string
          driver_id?: string
          id?: string
          ledger_debit_pence?: number
          ledger_entry_id?: string | null
          metadata?: Json
          note?: string
          operational_loss_pence?: number
          reference_doc?: string | null
          remediation_option?: string
          stripe_payout_amount_pence?: number
          stripe_payout_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "finance_reconciliation_notes_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_reconciliation_notes_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "finance_reconciliation_notes_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "finance_reconciliation_notes_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "finance_reconciliation_notes_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_reconciliation_notes_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_reconciliation_notes_ledger_entry_id_fkey"
            columns: ["ledger_entry_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_reconciliation_notes_ledger_entry_id_fkey"
            columns: ["ledger_entry_id"]
            isOneToOne: false
            referencedRelation: "v_finance_era_digital"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finance_reconciliation_notes_ledger_entry_id_fkey"
            columns: ["ledger_entry_id"]
            isOneToOne: false
            referencedRelation: "v_finance_era_legacy_cash"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_ssot_mismatches: {
        Row: {
          actual_pence: number
          details: Json | null
          detected_at: string
          expected_pence: number
          field_name: string | null
          id: string
          resolved_at: string | null
          stage: string
          trip_code: string | null
          trip_id: string
        }
        Insert: {
          actual_pence: number
          details?: Json | null
          detected_at?: string
          expected_pence: number
          field_name?: string | null
          id?: string
          resolved_at?: string | null
          stage: string
          trip_code?: string | null
          trip_id: string
        }
        Update: {
          actual_pence?: number
          details?: Json | null
          detected_at?: string
          expected_pence?: number
          field_name?: string | null
          id?: string
          resolved_at?: string | null
          stage?: string
          trip_code?: string | null
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "financial_ssot_mismatches_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "financial_ssot_mismatches_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "financial_ssot_mismatches_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_ssot_repairs: {
        Row: {
          after_json: Json
          before_json: Json
          id: string
          repair_type: string
          repaired_at: string
          trip_code: string | null
          trip_id: string
        }
        Insert: {
          after_json: Json
          before_json: Json
          id?: string
          repair_type: string
          repaired_at?: string
          trip_code?: string | null
          trip_id: string
        }
        Update: {
          after_json?: Json
          before_json?: Json
          id?: string
          repair_type?: string
          repaired_at?: string
          trip_code?: string | null
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "financial_ssot_repairs_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "financial_ssot_repairs_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "financial_ssot_repairs_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
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
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "geofence_events_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "geofence_events_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "geofence_events_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
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
      global_dispatch_settings: {
        Row: {
          allow_airport_stacking: boolean
          allow_new_ride_while_driver_active: boolean
          allow_same_direction_only: boolean
          allow_scheduled_stacking: boolean
          allow_stacking_during_pickup_waiting: boolean
          allow_stacking_during_stop_waiting: boolean
          block_multiple_active_rides: boolean
          cancel_protection: boolean
          created_at: string
          degraded_driver_penalty: number
          distance_penalty_per_meter: number
          driver_fare_display: string
          enable_logging: boolean
          enable_scheduled_to_urgent_conversion: boolean
          expand_radius_meters: number
          fairness_boost_score: number
          fairness_idle_minutes: number
          id: string
          locked_driver_response_minutes: number
          max_active_rides_per_driver: number
          max_advance_days: number
          max_dispatch_rounds: number
          max_driver_find_time_minutes: number
          max_dropoff_detour_meters: number
          max_pickup_detour_meters: number
          max_radius_meters: number
          max_stacked_rides: number
          max_waiting_bonus_minutes: number
          min_advance_time_minutes: number
          presence_max_age_seconds: number
          scheduled_response_window_minutes: number
          scheduled_ride_incentives_enabled: boolean
          scheduled_rides_enabled: boolean
          scheduled_urgent_card_label: string
          simulate_mode: boolean
          singleton: boolean
          stacked_max_detour_minutes: number
          stacked_min_trip_distance_meters: number
          stacked_offer_window_minutes: number
          stacked_rides_enabled: boolean
          stacked_same_direction_only: boolean
          stacked_search_radius_meters: number
          start_radius_meters: number
          updated_at: string
          urgent_dispatch_trigger_minutes_before_pickup: number
          waiting_bonus_per_minute: number
          waiting_time_grace_period_minutes: number
          wave1_offer_expiry_seconds: number
          wave1_size: number
          wave2_offer_expiry_seconds: number
          wave2_size: number
          wave3_offer_expiry_seconds: number
          wave3_size: number
        }
        Insert: {
          allow_airport_stacking?: boolean
          allow_new_ride_while_driver_active?: boolean
          allow_same_direction_only?: boolean
          allow_scheduled_stacking?: boolean
          allow_stacking_during_pickup_waiting?: boolean
          allow_stacking_during_stop_waiting?: boolean
          block_multiple_active_rides?: boolean
          cancel_protection?: boolean
          created_at?: string
          degraded_driver_penalty?: number
          distance_penalty_per_meter?: number
          driver_fare_display?: string
          enable_logging?: boolean
          enable_scheduled_to_urgent_conversion?: boolean
          expand_radius_meters?: number
          fairness_boost_score?: number
          fairness_idle_minutes?: number
          id?: string
          locked_driver_response_minutes?: number
          max_active_rides_per_driver?: number
          max_advance_days?: number
          max_dispatch_rounds?: number
          max_driver_find_time_minutes?: number
          max_dropoff_detour_meters?: number
          max_pickup_detour_meters?: number
          max_radius_meters?: number
          max_stacked_rides?: number
          max_waiting_bonus_minutes?: number
          min_advance_time_minutes?: number
          presence_max_age_seconds?: number
          scheduled_response_window_minutes?: number
          scheduled_ride_incentives_enabled?: boolean
          scheduled_rides_enabled?: boolean
          scheduled_urgent_card_label?: string
          simulate_mode?: boolean
          singleton?: boolean
          stacked_max_detour_minutes?: number
          stacked_min_trip_distance_meters?: number
          stacked_offer_window_minutes?: number
          stacked_rides_enabled?: boolean
          stacked_same_direction_only?: boolean
          stacked_search_radius_meters?: number
          start_radius_meters?: number
          updated_at?: string
          urgent_dispatch_trigger_minutes_before_pickup?: number
          waiting_bonus_per_minute?: number
          waiting_time_grace_period_minutes?: number
          wave1_offer_expiry_seconds?: number
          wave1_size?: number
          wave2_offer_expiry_seconds?: number
          wave2_size?: number
          wave3_offer_expiry_seconds?: number
          wave3_size?: number
        }
        Update: {
          allow_airport_stacking?: boolean
          allow_new_ride_while_driver_active?: boolean
          allow_same_direction_only?: boolean
          allow_scheduled_stacking?: boolean
          allow_stacking_during_pickup_waiting?: boolean
          allow_stacking_during_stop_waiting?: boolean
          block_multiple_active_rides?: boolean
          cancel_protection?: boolean
          created_at?: string
          degraded_driver_penalty?: number
          distance_penalty_per_meter?: number
          driver_fare_display?: string
          enable_logging?: boolean
          enable_scheduled_to_urgent_conversion?: boolean
          expand_radius_meters?: number
          fairness_boost_score?: number
          fairness_idle_minutes?: number
          id?: string
          locked_driver_response_minutes?: number
          max_active_rides_per_driver?: number
          max_advance_days?: number
          max_dispatch_rounds?: number
          max_driver_find_time_minutes?: number
          max_dropoff_detour_meters?: number
          max_pickup_detour_meters?: number
          max_radius_meters?: number
          max_stacked_rides?: number
          max_waiting_bonus_minutes?: number
          min_advance_time_minutes?: number
          presence_max_age_seconds?: number
          scheduled_response_window_minutes?: number
          scheduled_ride_incentives_enabled?: boolean
          scheduled_rides_enabled?: boolean
          scheduled_urgent_card_label?: string
          simulate_mode?: boolean
          singleton?: boolean
          stacked_max_detour_minutes?: number
          stacked_min_trip_distance_meters?: number
          stacked_offer_window_minutes?: number
          stacked_rides_enabled?: boolean
          stacked_same_direction_only?: boolean
          stacked_search_radius_meters?: number
          start_radius_meters?: number
          updated_at?: string
          urgent_dispatch_trigger_minutes_before_pickup?: number
          waiting_bonus_per_minute?: number
          waiting_time_grace_period_minutes?: number
          wave1_offer_expiry_seconds?: number
          wave1_size?: number
          wave2_offer_expiry_seconds?: number
          wave2_size?: number
          wave3_offer_expiry_seconds?: number
          wave3_size?: number
        }
        Relationships: []
      }
      global_sequences: {
        Row: {
          current_value: number
          sequence_type: string
          updated_at: string
        }
        Insert: {
          current_value?: number
          sequence_type: string
          updated_at?: string
        }
        Update: {
          current_value?: number
          sequence_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      id_sequences: {
        Row: {
          created_at: string
          current_value: number
          id: string
          region_id: string | null
          sequence_type: string
          service_area_id: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          current_value?: number
          id?: string
          region_id?: string | null
          sequence_type: string
          service_area_id?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          current_value?: number
          id?: string
          region_id?: string | null
          sequence_type?: string
          service_area_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "id_sequences_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      integration_secret_vault: {
        Row: {
          created_at: string
          id: string
          masked_preview: string
          namespace: string
          owner_id: string
          secret_name: string
          secret_value: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          masked_preview: string
          namespace: string
          owner_id: string
          secret_name: string
          secret_value: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          masked_preview?: string
          namespace?: string
          owner_id?: string
          secret_name?: string
          secret_value?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      invoice_delivery_logs: {
        Row: {
          delivery_status: string
          error_message: string | null
          id: string
          invoice_id: string
          sent_at: string
          sent_by: string | null
          sent_to_email: string
        }
        Insert: {
          delivery_status?: string
          error_message?: string | null
          id?: string
          invoice_id: string
          sent_at?: string
          sent_by?: string | null
          sent_to_email: string
        }
        Update: {
          delivery_status?: string
          error_message?: string | null
          id?: string
          invoice_id?: string
          sent_at?: string
          sent_by?: string | null
          sent_to_email?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_delivery_logs_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_email_outbox: {
        Row: {
          created_at: string
          email_type: string
          error_message: string | null
          id: string
          metadata: Json | null
          pdf_storage_path: string | null
          provider_message_id: string | null
          recipient_email: string
          recipient_user_id: string
          retry_count: number
          sent_at: string | null
          status: string
          trip_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email_type?: string
          error_message?: string | null
          id?: string
          metadata?: Json | null
          pdf_storage_path?: string | null
          provider_message_id?: string | null
          recipient_email: string
          recipient_user_id: string
          retry_count?: number
          sent_at?: string | null
          status?: string
          trip_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email_type?: string
          error_message?: string | null
          id?: string
          metadata?: Json | null
          pdf_storage_path?: string | null
          provider_message_id?: string | null
          recipient_email?: string
          recipient_user_id?: string
          retry_count?: number
          sent_at?: string | null
          status?: string
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_email_outbox_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_email_outbox_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_email_outbox_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_items: {
        Row: {
          amount_pence: number
          description: string
          id: string
          invoice_id: string
          item_type: string
          metadata: Json | null
          quantity: number | null
          sort_order: number
          unit_price_pence: number
        }
        Insert: {
          amount_pence?: number
          description: string
          id?: string
          invoice_id: string
          item_type: string
          metadata?: Json | null
          quantity?: number | null
          sort_order?: number
          unit_price_pence?: number
        }
        Update: {
          amount_pence?: number
          description?: string
          id?: string
          invoice_id?: string
          item_type?: string
          metadata?: Json | null
          quantity?: number | null
          sort_order?: number
          unit_price_pence?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoice_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_pdf_delivery_logs: {
        Row: {
          created_at: string
          driver_id: string | null
          error_message: string | null
          id: string
          invoice_id: string
          status: string
        }
        Insert: {
          created_at?: string
          driver_id?: string | null
          error_message?: string | null
          id?: string
          invoice_id: string
          status: string
        }
        Update: {
          created_at?: string
          driver_id?: string | null
          error_message?: string | null
          id?: string
          invoice_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "invoice_pdf_delivery_logs_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_pdf_delivery_logs_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "invoice_pdf_delivery_logs_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "invoice_pdf_delivery_logs_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "invoice_pdf_delivery_logs_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_pdf_delivery_logs_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_pdf_delivery_logs_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_templates: {
        Row: {
          auto_email_enabled: boolean
          company_address: string | null
          company_email: string | null
          company_name: string
          company_phone: string | null
          company_registration: string | null
          company_website: string | null
          created_at: string
          created_by: string | null
          due_date_label: string | null
          email_body: string | null
          email_subject: string | null
          footer_text: string | null
          id: string
          invoice_title: string
          is_default: boolean
          logo_url: string | null
          name: string
          notes_footer: string | null
          payment_terms: string | null
          table_columns: Json
          template_type: string
          updated_at: string
        }
        Insert: {
          auto_email_enabled?: boolean
          company_address?: string | null
          company_email?: string | null
          company_name?: string
          company_phone?: string | null
          company_registration?: string | null
          company_website?: string | null
          created_at?: string
          created_by?: string | null
          due_date_label?: string | null
          email_body?: string | null
          email_subject?: string | null
          footer_text?: string | null
          id?: string
          invoice_title?: string
          is_default?: boolean
          logo_url?: string | null
          name?: string
          notes_footer?: string | null
          payment_terms?: string | null
          table_columns?: Json
          template_type?: string
          updated_at?: string
        }
        Update: {
          auto_email_enabled?: boolean
          company_address?: string | null
          company_email?: string | null
          company_name?: string
          company_phone?: string | null
          company_registration?: string | null
          company_website?: string | null
          created_at?: string
          created_by?: string | null
          due_date_label?: string | null
          email_body?: string | null
          email_subject?: string | null
          footer_text?: string | null
          id?: string
          invoice_title?: string
          is_default?: boolean
          logo_url?: string | null
          name?: string
          notes_footer?: string | null
          payment_terms?: string | null
          table_columns?: Json
          template_type?: string
          updated_at?: string
        }
        Relationships: []
      }
      invoices: {
        Row: {
          adjustments_pence: number
          airport_fee_earnings_pence: number
          bonuses_pence: number
          card_trip_earnings_pence: number
          card_trips: number
          cash_collected_pence: number
          cash_trip_earnings_pence: number
          cash_trips: number
          commission_pence: number
          completed_trips: number
          created_at: string
          currency_code: string
          driver_display_code: string | null
          driver_display_email: string | null
          driver_display_name: string | null
          driver_id: string | null
          extra_charge_earnings_pence: number
          finalized_at: string | null
          gross_earnings_pence: number
          id: string
          invoice_email_error: string | null
          invoice_email_sent: boolean
          invoice_email_sent_at: string | null
          invoice_email_status: string | null
          invoice_generated_at: string | null
          invoice_number: string
          invoice_pdf_url: string | null
          late_cancel_trips: number
          net_earnings_pence: number
          no_show_trips: number
          pdf_storage_path: string | null
          penalties_pence: number
          period_end: string
          period_start: string
          region_id: string
          sent_at: string | null
          sent_by: string | null
          service_area_id: string | null
          statement_run_id: string | null
          status: string
          template_id: string | null
          template_version: number | null
          viewed_at: string | null
        }
        Insert: {
          adjustments_pence?: number
          airport_fee_earnings_pence?: number
          bonuses_pence?: number
          card_trip_earnings_pence?: number
          card_trips?: number
          cash_collected_pence?: number
          cash_trip_earnings_pence?: number
          cash_trips?: number
          commission_pence?: number
          completed_trips?: number
          created_at?: string
          currency_code: string
          driver_display_code?: string | null
          driver_display_email?: string | null
          driver_display_name?: string | null
          driver_id?: string | null
          extra_charge_earnings_pence?: number
          finalized_at?: string | null
          gross_earnings_pence?: number
          id?: string
          invoice_email_error?: string | null
          invoice_email_sent?: boolean
          invoice_email_sent_at?: string | null
          invoice_email_status?: string | null
          invoice_generated_at?: string | null
          invoice_number: string
          invoice_pdf_url?: string | null
          late_cancel_trips?: number
          net_earnings_pence?: number
          no_show_trips?: number
          pdf_storage_path?: string | null
          penalties_pence?: number
          period_end: string
          period_start: string
          region_id: string
          sent_at?: string | null
          sent_by?: string | null
          service_area_id?: string | null
          statement_run_id?: string | null
          status?: string
          template_id?: string | null
          template_version?: number | null
          viewed_at?: string | null
        }
        Update: {
          adjustments_pence?: number
          airport_fee_earnings_pence?: number
          bonuses_pence?: number
          card_trip_earnings_pence?: number
          card_trips?: number
          cash_collected_pence?: number
          cash_trip_earnings_pence?: number
          cash_trips?: number
          commission_pence?: number
          completed_trips?: number
          created_at?: string
          currency_code?: string
          driver_display_code?: string | null
          driver_display_email?: string | null
          driver_display_name?: string | null
          driver_id?: string | null
          extra_charge_earnings_pence?: number
          finalized_at?: string | null
          gross_earnings_pence?: number
          id?: string
          invoice_email_error?: string | null
          invoice_email_sent?: boolean
          invoice_email_sent_at?: string | null
          invoice_email_status?: string | null
          invoice_generated_at?: string | null
          invoice_number?: string
          invoice_pdf_url?: string | null
          late_cancel_trips?: number
          net_earnings_pence?: number
          no_show_trips?: number
          pdf_storage_path?: string | null
          penalties_pence?: number
          period_end?: string
          period_start?: string
          region_id?: string
          sent_at?: string | null
          sent_by?: string | null
          service_area_id?: string | null
          statement_run_id?: string | null
          status?: string
          template_id?: string | null
          template_version?: number | null
          viewed_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "invoices_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "invoices_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "invoices_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_statement_run_id_fkey"
            columns: ["statement_run_id"]
            isOneToOne: false
            referencedRelation: "statement_runs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "invoice_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      lost_property_cases: {
        Row: {
          admin_joined_at: string | null
          admin_last_read_message_at: string | null
          admin_viewed_at: string | null
          case_number: string
          chat_enabled: boolean
          chat_expires_at: string
          chat_lock_reason: string | null
          chat_locked_at: string | null
          chat_opened_at: string | null
          closed_at: string | null
          collected_at: string | null
          created_at: string
          customer_confirmed: boolean | null
          customer_id: string
          driver_id: string | null
          driver_photos: string[] | null
          driver_responded_at: string | null
          found_item_photos: string[] | null
          id: string
          item_category: string
          item_description: string
          item_found_at: string | null
          photos: string[] | null
          photos_delete_at: string | null
          photos_hidden_at: string | null
          region_id: string
          return_method: string | null
          return_trip_id: string | null
          same_driver_requested: boolean | null
          service_area_id: string
          status: string
          trip_id: string
          updated_at: string
        }
        Insert: {
          admin_joined_at?: string | null
          admin_last_read_message_at?: string | null
          admin_viewed_at?: string | null
          case_number: string
          chat_enabled?: boolean
          chat_expires_at?: string
          chat_lock_reason?: string | null
          chat_locked_at?: string | null
          chat_opened_at?: string | null
          closed_at?: string | null
          collected_at?: string | null
          created_at?: string
          customer_confirmed?: boolean | null
          customer_id: string
          driver_id?: string | null
          driver_photos?: string[] | null
          driver_responded_at?: string | null
          found_item_photos?: string[] | null
          id?: string
          item_category: string
          item_description: string
          item_found_at?: string | null
          photos?: string[] | null
          photos_delete_at?: string | null
          photos_hidden_at?: string | null
          region_id: string
          return_method?: string | null
          return_trip_id?: string | null
          same_driver_requested?: boolean | null
          service_area_id: string
          status?: string
          trip_id: string
          updated_at?: string
        }
        Update: {
          admin_joined_at?: string | null
          admin_last_read_message_at?: string | null
          admin_viewed_at?: string | null
          case_number?: string
          chat_enabled?: boolean
          chat_expires_at?: string
          chat_lock_reason?: string | null
          chat_locked_at?: string | null
          chat_opened_at?: string | null
          closed_at?: string | null
          collected_at?: string | null
          created_at?: string
          customer_confirmed?: boolean | null
          customer_id?: string
          driver_id?: string | null
          driver_photos?: string[] | null
          driver_responded_at?: string | null
          found_item_photos?: string[] | null
          id?: string
          item_category?: string
          item_description?: string
          item_found_at?: string | null
          photos?: string[] | null
          photos_delete_at?: string | null
          photos_hidden_at?: string | null
          region_id?: string
          return_method?: string | null
          return_trip_id?: string | null
          same_driver_requested?: boolean | null
          service_area_id?: string
          status?: string
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "lost_property_cases_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lost_property_cases_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "lost_property_cases_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lost_property_cases_return_trip_id_fkey"
            columns: ["return_trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
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
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lost_property_cases_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
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
          attachments: string[] | null
          case_id: string
          created_at: string
          id: string
          message: string
          sender_id: string | null
          sender_type: string
        }
        Insert: {
          attachments?: string[] | null
          case_id: string
          created_at?: string
          id?: string
          message: string
          sender_id?: string | null
          sender_type: string
        }
        Update: {
          attachments?: string[] | null
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
      merchant_ai_credit_history: {
        Row: {
          action_type: string
          admin_user_id: string | null
          balance_after: number
          created_at: string
          credits_changed: number
          id: string
          merchant_id: string
          notes: string | null
          package_id: string | null
          stripe_payment_id: string | null
        }
        Insert: {
          action_type: string
          admin_user_id?: string | null
          balance_after: number
          created_at?: string
          credits_changed: number
          id?: string
          merchant_id: string
          notes?: string | null
          package_id?: string | null
          stripe_payment_id?: string | null
        }
        Update: {
          action_type?: string
          admin_user_id?: string | null
          balance_after?: number
          created_at?: string
          credits_changed?: number
          id?: string
          merchant_id?: string
          notes?: string | null
          package_id?: string | null
          stripe_payment_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "merchant_ai_credit_history_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merchant_ai_credit_history_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merchant_ai_credit_history_package_id_fkey"
            columns: ["package_id"]
            isOneToOne: false
            referencedRelation: "ai_credit_packages"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_ai_credits: {
        Row: {
          credits_remaining: number
          merchant_id: string
          updated_at: string
        }
        Insert: {
          credits_remaining?: number
          merchant_id: string
          updated_at?: string
        }
        Update: {
          credits_remaining?: number
          merchant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_ai_credits_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: true
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merchant_ai_credits_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: true
            referencedRelation: "merchants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_ai_generations: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          image_url: string | null
          merchant_id: string
          product_id: string | null
          prompt: string
          status: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          image_url?: string | null
          merchant_id: string
          product_id?: string | null
          prompt: string
          status?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          image_url?: string | null
          merchant_id?: string
          product_id?: string | null
          prompt?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_ai_generations_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merchant_ai_generations_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merchant_ai_generations_product_id_fkey"
            columns: ["product_id"]
            isOneToOne: false
            referencedRelation: "merchant_products"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_categories: {
        Row: {
          category: Database["public"]["Enums"]["merchant_category"]
          display_name: string
          enabled: boolean
          updated_at: string
        }
        Insert: {
          category: Database["public"]["Enums"]["merchant_category"]
          display_name: string
          enabled?: boolean
          updated_at?: string
        }
        Update: {
          category?: Database["public"]["Enums"]["merchant_category"]
          display_name?: string
          enabled?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      merchant_product_categories: {
        Row: {
          created_at: string
          id: string
          merchant_id: string
          name: string
          sort_order: number
        }
        Insert: {
          created_at?: string
          id?: string
          merchant_id: string
          name: string
          sort_order?: number
        }
        Update: {
          created_at?: string
          id?: string
          merchant_id?: string
          name?: string
          sort_order?: number
        }
        Relationships: [
          {
            foreignKeyName: "merchant_product_categories_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merchant_product_categories_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants_public"
            referencedColumns: ["id"]
          },
        ]
      }
      merchant_products: {
        Row: {
          attributes: Json
          availability: boolean
          created_at: string
          description: string | null
          id: string
          image_approved: boolean
          image_source: Database["public"]["Enums"]["merchant_image_source"]
          image_url: string | null
          merchant_id: string
          name: string
          price: number
          product_category_id: string | null
          updated_at: string
        }
        Insert: {
          attributes?: Json
          availability?: boolean
          created_at?: string
          description?: string | null
          id?: string
          image_approved?: boolean
          image_source?: Database["public"]["Enums"]["merchant_image_source"]
          image_url?: string | null
          merchant_id: string
          name: string
          price?: number
          product_category_id?: string | null
          updated_at?: string
        }
        Update: {
          attributes?: Json
          availability?: boolean
          created_at?: string
          description?: string | null
          id?: string
          image_approved?: boolean
          image_source?: Database["public"]["Enums"]["merchant_image_source"]
          image_url?: string | null
          merchant_id?: string
          name?: string
          price?: number
          product_category_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchant_products_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merchant_products_merchant_id_fkey"
            columns: ["merchant_id"]
            isOneToOne: false
            referencedRelation: "merchants_public"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "merchant_products_product_category_id_fkey"
            columns: ["product_category_id"]
            isOneToOne: false
            referencedRelation: "merchant_product_categories"
            referencedColumns: ["id"]
          },
        ]
      }
      merchants: {
        Row: {
          address: string | null
          admin_notes: string | null
          ai_access_suspended: boolean
          banner_url: string | null
          business_name: string
          category: Database["public"]["Enums"]["merchant_category"]
          city: string | null
          commission_pct: number | null
          created_at: string
          delivery_radius_km: number
          description: string | null
          email: string | null
          free_ai_credits_granted: boolean
          id: string
          is_open: boolean
          logo_url: string | null
          min_order_amount: number
          opening_hours: Json
          owner_name: string | null
          owner_user_id: string | null
          phone: string | null
          postcode: string | null
          prep_time_minutes: number
          rejection_reason: string | null
          service_area_id: string
          status: Database["public"]["Enums"]["merchant_status"]
          updated_at: string
        }
        Insert: {
          address?: string | null
          admin_notes?: string | null
          ai_access_suspended?: boolean
          banner_url?: string | null
          business_name: string
          category: Database["public"]["Enums"]["merchant_category"]
          city?: string | null
          commission_pct?: number | null
          created_at?: string
          delivery_radius_km?: number
          description?: string | null
          email?: string | null
          free_ai_credits_granted?: boolean
          id?: string
          is_open?: boolean
          logo_url?: string | null
          min_order_amount?: number
          opening_hours?: Json
          owner_name?: string | null
          owner_user_id?: string | null
          phone?: string | null
          postcode?: string | null
          prep_time_minutes?: number
          rejection_reason?: string | null
          service_area_id: string
          status?: Database["public"]["Enums"]["merchant_status"]
          updated_at?: string
        }
        Update: {
          address?: string | null
          admin_notes?: string | null
          ai_access_suspended?: boolean
          banner_url?: string | null
          business_name?: string
          category?: Database["public"]["Enums"]["merchant_category"]
          city?: string | null
          commission_pct?: number | null
          created_at?: string
          delivery_radius_km?: number
          description?: string | null
          email?: string | null
          free_ai_credits_granted?: boolean
          id?: string
          is_open?: boolean
          logo_url?: string | null
          min_order_amount?: number
          opening_hours?: Json
          owner_name?: string | null
          owner_user_id?: string | null
          phone?: string | null
          postcode?: string | null
          prep_time_minutes?: number
          rejection_reason?: string | null
          service_area_id?: string
          status?: Database["public"]["Enums"]["merchant_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "merchants_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
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
      offer_redemptions: {
        Row: {
          created_at: string
          currency: string
          customer_id: string | null
          discount_pence: number
          final_fare_pence: number
          id: string
          metadata: Json | null
          offer_id: string
          original_fare_pence: number
          service_area_id: string | null
          status: Database["public"]["Enums"]["offer_redemption_status"]
          trip_id: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          currency: string
          customer_id?: string | null
          discount_pence: number
          final_fare_pence: number
          id?: string
          metadata?: Json | null
          offer_id: string
          original_fare_pence: number
          service_area_id?: string | null
          status?: Database["public"]["Enums"]["offer_redemption_status"]
          trip_id?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          currency?: string
          customer_id?: string | null
          discount_pence?: number
          final_fare_pence?: number
          id?: string
          metadata?: Json | null
          offer_id?: string
          original_fare_pence?: number
          service_area_id?: string | null
          status?: Database["public"]["Enums"]["offer_redemption_status"]
          trip_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "offer_redemptions_offer_id_fkey"
            columns: ["offer_id"]
            isOneToOne: false
            referencedRelation: "offers"
            referencedColumns: ["id"]
          },
        ]
      }
      offer_service_areas: {
        Row: {
          created_at: string
          id: string
          offer_id: string
          service_area_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          offer_id: string
          service_area_id: string
        }
        Update: {
          created_at?: string
          id?: string
          offer_id?: string
          service_area_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "offer_service_areas_offer_id_fkey"
            columns: ["offer_id"]
            isOneToOne: false
            referencedRelation: "offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "offer_service_areas_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      offers: {
        Row: {
          badge_text: string | null
          banner_subtitle: string | null
          banner_title: string
          code: string
          created_at: string
          created_by: string | null
          cta_text: string
          currency: string
          description: string | null
          discount_value: number
          ends_at: string | null
          first_ride_only: boolean
          id: string
          is_enabled: boolean
          max_discount_pence: number | null
          min_fare_pence: number
          name: string
          new_customer_only: boolean
          offer_type: Database["public"]["Enums"]["offer_type"]
          per_user_limit: number | null
          priority: number
          starts_at: string
          status: Database["public"]["Enums"]["offer_status"]
          style_variant: string
          terms: string | null
          total_usage_limit: number | null
          updated_at: string
          usage_count: number
        }
        Insert: {
          badge_text?: string | null
          banner_subtitle?: string | null
          banner_title: string
          code: string
          created_at?: string
          created_by?: string | null
          cta_text?: string
          currency?: string
          description?: string | null
          discount_value: number
          ends_at?: string | null
          first_ride_only?: boolean
          id?: string
          is_enabled?: boolean
          max_discount_pence?: number | null
          min_fare_pence?: number
          name: string
          new_customer_only?: boolean
          offer_type: Database["public"]["Enums"]["offer_type"]
          per_user_limit?: number | null
          priority?: number
          starts_at?: string
          status?: Database["public"]["Enums"]["offer_status"]
          style_variant?: string
          terms?: string | null
          total_usage_limit?: number | null
          updated_at?: string
          usage_count?: number
        }
        Update: {
          badge_text?: string | null
          banner_subtitle?: string | null
          banner_title?: string
          code?: string
          created_at?: string
          created_by?: string | null
          cta_text?: string
          currency?: string
          description?: string | null
          discount_value?: number
          ends_at?: string | null
          first_ride_only?: boolean
          id?: string
          is_enabled?: boolean
          max_discount_pence?: number | null
          min_fare_pence?: number
          name?: string
          new_customer_only?: boolean
          offer_type?: Database["public"]["Enums"]["offer_type"]
          per_user_limit?: number | null
          priority?: number
          starts_at?: string
          status?: Database["public"]["Enums"]["offer_status"]
          style_variant?: string
          terms?: string | null
          total_usage_limit?: number | null
          updated_at?: string
          usage_count?: number
        }
        Relationships: []
      }
      onboarding_login_audit_log: {
        Row: {
          app_type: string
          block_code: string
          created_at: string
          id: string
          intent: string
          message: string
          user_id: string
        }
        Insert: {
          app_type: string
          block_code: string
          created_at?: string
          id?: string
          intent?: string
          message: string
          user_id: string
        }
        Update: {
          app_type?: string
          block_code?: string
          created_at?: string
          id?: string
          intent?: string
          message?: string
          user_id?: string
        }
        Relationships: []
      }
      onecab_document_activity_log: {
        Row: {
          action: string
          created_at: string
          details: string | null
          document_id: string | null
          id: string
          performed_by: string | null
        }
        Insert: {
          action: string
          created_at?: string
          details?: string | null
          document_id?: string | null
          id?: string
          performed_by?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          details?: string | null
          document_id?: string | null
          id?: string
          performed_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "onecab_document_activity_log_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "onecab_documents"
            referencedColumns: ["id"]
          },
        ]
      }
      onecab_documents: {
        Row: {
          category: string
          created_at: string
          deleted_at: string | null
          description: string | null
          document_type: string | null
          expiry_date: string | null
          file_name: string | null
          file_path: string | null
          id: string
          issue_date: string | null
          issuing_authority: string | null
          mime_type: string | null
          notes: string | null
          reference_number: string | null
          reminder_days_before: number
          renewal_status: string
          status: string
          title: string
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          category?: string
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          document_type?: string | null
          expiry_date?: string | null
          file_name?: string | null
          file_path?: string | null
          id?: string
          issue_date?: string | null
          issuing_authority?: string | null
          mime_type?: string | null
          notes?: string | null
          reference_number?: string | null
          reminder_days_before?: number
          renewal_status?: string
          status?: string
          title: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          category?: string
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          document_type?: string | null
          expiry_date?: string | null
          file_name?: string | null
          file_path?: string | null
          id?: string
          issue_date?: string | null
          issuing_authority?: string | null
          mime_type?: string | null
          notes?: string | null
          reference_number?: string | null
          reminder_days_before?: number
          renewal_status?: string
          status?: string
          title?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: []
      }
      onecab_expenses: {
        Row: {
          amount_pence: number
          category: string
          created_at: string
          created_by: string | null
          currency_code: string
          description: string | null
          expense_date: string
          id: string
          notes: string | null
          region_id: string | null
          service_area_id: string | null
          subcategory: string
          updated_at: string
        }
        Insert: {
          amount_pence: number
          category: string
          created_at?: string
          created_by?: string | null
          currency_code?: string
          description?: string | null
          expense_date?: string
          id?: string
          notes?: string | null
          region_id?: string | null
          service_area_id?: string | null
          subcategory: string
          updated_at?: string
        }
        Update: {
          amount_pence?: number
          category?: string
          created_at?: string
          created_by?: string | null
          currency_code?: string
          description?: string | null
          expense_date?: string
          id?: string
          notes?: string | null
          region_id?: string | null
          service_area_id?: string | null
          subcategory?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "onecab_expenses_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "onecab_expenses_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      ops_ai_summaries: {
        Row: {
          alert_id: string
          confidence_score: number | null
          created_at: string
          generated_at: string
          id: string
          model_used: string | null
          recommended_action: string | null
          root_cause: string | null
          summary: string
        }
        Insert: {
          alert_id: string
          confidence_score?: number | null
          created_at?: string
          generated_at?: string
          id?: string
          model_used?: string | null
          recommended_action?: string | null
          root_cause?: string | null
          summary: string
        }
        Update: {
          alert_id?: string
          confidence_score?: number | null
          created_at?: string
          generated_at?: string
          id?: string
          model_used?: string | null
          recommended_action?: string | null
          root_cause?: string | null
          summary?: string
        }
        Relationships: [
          {
            foreignKeyName: "ops_ai_summaries_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "ops_alerts"
            referencedColumns: ["id"]
          },
        ]
      }
      ops_alert_rules: {
        Row: {
          auto_resolve_minutes: number | null
          category: string
          cooldown_minutes: number | null
          created_at: string
          description: string | null
          event_type: string
          id: string
          is_active: boolean
          metadata: Json | null
          name: string
          severity: string
          threshold_count: number | null
          threshold_window_minutes: number | null
          updated_at: string
        }
        Insert: {
          auto_resolve_minutes?: number | null
          category: string
          cooldown_minutes?: number | null
          created_at?: string
          description?: string | null
          event_type: string
          id?: string
          is_active?: boolean
          metadata?: Json | null
          name: string
          severity?: string
          threshold_count?: number | null
          threshold_window_minutes?: number | null
          updated_at?: string
        }
        Update: {
          auto_resolve_minutes?: number | null
          category?: string
          cooldown_minutes?: number | null
          created_at?: string
          description?: string | null
          event_type?: string
          id?: string
          is_active?: boolean
          metadata?: Json | null
          name?: string
          severity?: string
          threshold_count?: number | null
          threshold_window_minutes?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      ops_alert_summaries: {
        Row: {
          alert_id: string
          confidence_score: number | null
          created_at: string
          id: string
          model_used: string
          recommended_action: string
          root_cause: string
          summary: string
          updated_at: string
        }
        Insert: {
          alert_id: string
          confidence_score?: number | null
          created_at?: string
          id?: string
          model_used?: string
          recommended_action: string
          root_cause: string
          summary: string
          updated_at?: string
        }
        Update: {
          alert_id?: string
          confidence_score?: number | null
          created_at?: string
          id?: string
          model_used?: string
          recommended_action?: string
          root_cause?: string
          summary?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ops_alert_summaries_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "ops_alerts"
            referencedColumns: ["id"]
          },
        ]
      }
      ops_alerts: {
        Row: {
          acknowledged_at: string | null
          acknowledged_by: string | null
          app: string | null
          category: string
          created_at: string
          description: string | null
          fingerprint: string
          fingerprint_count: number
          first_detected_at: string
          id: string
          last_detected_at: string
          metadata: Json | null
          related_driver_id: string | null
          related_entity_id: string | null
          related_entity_type: string | null
          related_payment_id: string | null
          related_payout_batch_id: string | null
          related_trip_id: string | null
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          source: string
          status: string
          suppressed_until: string | null
          title: string
          updated_at: string
        }
        Insert: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          app?: string | null
          category: string
          created_at?: string
          description?: string | null
          fingerprint: string
          fingerprint_count?: number
          first_detected_at?: string
          id?: string
          last_detected_at?: string
          metadata?: Json | null
          related_driver_id?: string | null
          related_entity_id?: string | null
          related_entity_type?: string | null
          related_payment_id?: string | null
          related_payout_batch_id?: string | null
          related_trip_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          source?: string
          status?: string
          suppressed_until?: string | null
          title: string
          updated_at?: string
        }
        Update: {
          acknowledged_at?: string | null
          acknowledged_by?: string | null
          app?: string | null
          category?: string
          created_at?: string
          description?: string | null
          fingerprint?: string
          fingerprint_count?: number
          first_detected_at?: string
          id?: string
          last_detected_at?: string
          metadata?: Json | null
          related_driver_id?: string | null
          related_entity_id?: string | null
          related_entity_type?: string | null
          related_payment_id?: string | null
          related_payout_batch_id?: string | null
          related_trip_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          source?: string
          status?: string
          suppressed_until?: string | null
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      ops_events: {
        Row: {
          alert_id: string | null
          amount_pence: number | null
          app: string | null
          category: string
          created_at: string
          currency_code: string | null
          customer_id: string | null
          description: string | null
          driver_id: string | null
          event_type: string
          id: string
          metadata: Json | null
          payment_id: string | null
          payout_batch_id: string | null
          resolved: boolean
          resolved_at: string | null
          service_area_id: string | null
          severity: string
          trip_id: string | null
        }
        Insert: {
          alert_id?: string | null
          amount_pence?: number | null
          app?: string | null
          category: string
          created_at?: string
          currency_code?: string | null
          customer_id?: string | null
          description?: string | null
          driver_id?: string | null
          event_type: string
          id?: string
          metadata?: Json | null
          payment_id?: string | null
          payout_batch_id?: string | null
          resolved?: boolean
          resolved_at?: string | null
          service_area_id?: string | null
          severity?: string
          trip_id?: string | null
        }
        Update: {
          alert_id?: string | null
          amount_pence?: number | null
          app?: string | null
          category?: string
          created_at?: string
          currency_code?: string | null
          customer_id?: string | null
          description?: string | null
          driver_id?: string | null
          event_type?: string
          id?: string
          metadata?: Json | null
          payment_id?: string | null
          payout_batch_id?: string | null
          resolved?: boolean
          resolved_at?: string | null
          service_area_id?: string | null
          severity?: string
          trip_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ops_events_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "ops_alerts"
            referencedColumns: ["id"]
          },
        ]
      }
      ops_fix_actions: {
        Row: {
          action_type: string
          ai_explanation: string | null
          alert_id: string
          created_at: string
          executed_by: string | null
          function_name: string
          id: string
          input_payload: Json
          preview_data: Json | null
          result: Json | null
          risk_level: string
          status: string
        }
        Insert: {
          action_type: string
          ai_explanation?: string | null
          alert_id: string
          created_at?: string
          executed_by?: string | null
          function_name: string
          id?: string
          input_payload?: Json
          preview_data?: Json | null
          result?: Json | null
          risk_level?: string
          status?: string
        }
        Update: {
          action_type?: string
          ai_explanation?: string | null
          alert_id?: string
          created_at?: string
          executed_by?: string | null
          function_name?: string
          id?: string
          input_payload?: Json
          preview_data?: Json | null
          result?: Json | null
          risk_level?: string
          status?: string
        }
        Relationships: []
      }
      ops_logs: {
        Row: {
          app: string | null
          created_at: string
          driver_id: string | null
          duration_ms: number | null
          error_code: string | null
          http_status: number | null
          id: string
          is_synthetic: boolean
          level: string
          message: string
          metadata: Json | null
          request_id: string | null
          source: string
          trip_id: string | null
          user_id: string | null
        }
        Insert: {
          app?: string | null
          created_at?: string
          driver_id?: string | null
          duration_ms?: number | null
          error_code?: string | null
          http_status?: number | null
          id?: string
          is_synthetic?: boolean
          level?: string
          message: string
          metadata?: Json | null
          request_id?: string | null
          source: string
          trip_id?: string | null
          user_id?: string | null
        }
        Update: {
          app?: string | null
          created_at?: string
          driver_id?: string | null
          duration_ms?: number | null
          error_code?: string | null
          http_status?: number | null
          id?: string
          is_synthetic?: boolean
          level?: string
          message?: string
          metadata?: Json | null
          request_id?: string | null
          source?: string
          trip_id?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      ops_workflow_events: {
        Row: {
          alert_id: string | null
          app_name: string
          app_version: string | null
          created_at: string
          customer_id: string | null
          device_model: string | null
          driver_id: string | null
          duration_ms: number | null
          error_code: string | null
          event_type: string
          id: string
          message: string | null
          metadata: Json
          os_version: string | null
          platform: string | null
          session_id: string | null
          severity: string
          trip_id: string | null
        }
        Insert: {
          alert_id?: string | null
          app_name: string
          app_version?: string | null
          created_at?: string
          customer_id?: string | null
          device_model?: string | null
          driver_id?: string | null
          duration_ms?: number | null
          error_code?: string | null
          event_type: string
          id?: string
          message?: string | null
          metadata?: Json
          os_version?: string | null
          platform?: string | null
          session_id?: string | null
          severity?: string
          trip_id?: string | null
        }
        Update: {
          alert_id?: string | null
          app_name?: string
          app_version?: string | null
          created_at?: string
          customer_id?: string | null
          device_model?: string | null
          driver_id?: string | null
          duration_ms?: number | null
          error_code?: string | null
          event_type?: string
          id?: string
          message?: string | null
          metadata?: Json
          os_version?: string | null
          platform?: string | null
          session_id?: string | null
          severity?: string
          trip_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ops_workflow_events_alert_id_fkey"
            columns: ["alert_id"]
            isOneToOne: false
            referencedRelation: "ops_alerts"
            referencedColumns: ["id"]
          },
        ]
      }
      orphan_payments: {
        Row: {
          amount_pence: number
          client_action_id: string | null
          created_at: string
          currency: string
          customer_id: string | null
          failure_reason: string | null
          id: string
          metadata: Json
          payment_status: string | null
          resolved_at: string | null
          reversal_status: string
          service_area_id: string | null
          stripe_payment_intent_id: string
          trip_id: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          amount_pence: number
          client_action_id?: string | null
          created_at?: string
          currency?: string
          customer_id?: string | null
          failure_reason?: string | null
          id?: string
          metadata?: Json
          payment_status?: string | null
          resolved_at?: string | null
          reversal_status?: string
          service_area_id?: string | null
          stripe_payment_intent_id: string
          trip_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          amount_pence?: number
          client_action_id?: string | null
          created_at?: string
          currency?: string
          customer_id?: string | null
          failure_reason?: string | null
          id?: string
          metadata?: Json
          payment_status?: string | null
          resolved_at?: string | null
          reversal_status?: string
          service_area_id?: string | null
          stripe_payment_intent_id?: string
          trip_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      otp_allowed_countries: {
        Row: {
          country_code: string
          country_name: string
          created_at: string
          id: string
          is_enabled: boolean
          notes: string | null
          updated_at: string
        }
        Insert: {
          country_code: string
          country_name: string
          created_at?: string
          id?: string
          is_enabled?: boolean
          notes?: string | null
          updated_at?: string
        }
        Update: {
          country_code?: string
          country_name?: string
          created_at?: string
          id?: string
          is_enabled?: boolean
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      passenger_ratings: {
        Row: {
          comment: string | null
          created_at: string
          driver_id: string
          id: string
          passenger_id: string | null
          skipped: boolean
          stars: number | null
          tags: string[] | null
          trip_id: string
        }
        Insert: {
          comment?: string | null
          created_at?: string
          driver_id: string
          id?: string
          passenger_id?: string | null
          skipped?: boolean
          stars?: number | null
          tags?: string[] | null
          trip_id: string
        }
        Update: {
          comment?: string | null
          created_at?: string
          driver_id?: string
          id?: string
          passenger_id?: string | null
          skipped?: boolean
          stars?: number | null
          tags?: string[] | null
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "passenger_ratings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passenger_ratings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "passenger_ratings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "passenger_ratings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "passenger_ratings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passenger_ratings_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passenger_ratings_passenger_id_fkey"
            columns: ["passenger_id"]
            isOneToOne: false
            referencedRelation: "admin_customer_code_audit"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "passenger_ratings_passenger_id_fkey"
            columns: ["passenger_id"]
            isOneToOne: false
            referencedRelation: "admin_riders_with_trip_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passenger_ratings_passenger_id_fkey"
            columns: ["passenger_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passenger_ratings_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passenger_ratings_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "passenger_ratings_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_authorization_ledger: {
        Row: {
          amount_pence: number
          created_at: string
          error_message: string | null
          fare_revision_number: number
          id: string
          idempotency_key: string
          metadata: Json
          operation: string
          status: string
          stripe_payment_intent_id: string | null
          trip_id: string
          updated_at: string
        }
        Insert: {
          amount_pence: number
          created_at?: string
          error_message?: string | null
          fare_revision_number?: number
          id?: string
          idempotency_key: string
          metadata?: Json
          operation: string
          status?: string
          stripe_payment_intent_id?: string | null
          trip_id: string
          updated_at?: string
        }
        Update: {
          amount_pence?: number
          created_at?: string
          error_message?: string | null
          fare_revision_number?: number
          id?: string
          idempotency_key?: string
          metadata?: Json
          operation?: string
          status?: string
          stripe_payment_intent_id?: string | null
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_authorization_ledger_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_authorization_ledger_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_authorization_ledger_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_provider_configs: {
        Row: {
          apple_pay_enabled: boolean | null
          connect_enabled: boolean | null
          created_at: string
          display_name: string
          environment: string
          google_pay_enabled: boolean | null
          id: string
          is_enabled: boolean
          is_primary: boolean
          last_connection_test_at: string | null
          last_connection_test_status: string | null
          last_error_message: string | null
          provider: string
          status: string
          supports_customer_payments: boolean
          supports_driver_payouts: boolean
          updated_at: string
          webhook_endpoint_url: string | null
        }
        Insert: {
          apple_pay_enabled?: boolean | null
          connect_enabled?: boolean | null
          created_at?: string
          display_name: string
          environment?: string
          google_pay_enabled?: boolean | null
          id?: string
          is_enabled?: boolean
          is_primary?: boolean
          last_connection_test_at?: string | null
          last_connection_test_status?: string | null
          last_error_message?: string | null
          provider: string
          status?: string
          supports_customer_payments?: boolean
          supports_driver_payouts?: boolean
          updated_at?: string
          webhook_endpoint_url?: string | null
        }
        Update: {
          apple_pay_enabled?: boolean | null
          connect_enabled?: boolean | null
          created_at?: string
          display_name?: string
          environment?: string
          google_pay_enabled?: boolean | null
          id?: string
          is_enabled?: boolean
          is_primary?: boolean
          last_connection_test_at?: string | null
          last_connection_test_status?: string | null
          last_error_message?: string | null
          provider?: string
          status?: string
          supports_customer_payments?: boolean
          supports_driver_payouts?: boolean
          updated_at?: string
          webhook_endpoint_url?: string | null
        }
        Relationships: []
      }
      payment_provider_secret_metadata: {
        Row: {
          environment: string
          id: string
          is_configured: boolean
          last_updated: string | null
          masked_value: string | null
          provider: string
          secret_name: string
          updated_by: string | null
        }
        Insert: {
          environment: string
          id?: string
          is_configured?: boolean
          last_updated?: string | null
          masked_value?: string | null
          provider: string
          secret_name: string
          updated_by?: string | null
        }
        Update: {
          environment?: string
          id?: string
          is_configured?: boolean
          last_updated?: string | null
          masked_value?: string | null
          provider?: string
          secret_name?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      payment_provider_vault: {
        Row: {
          environment: string
          id: string
          provider: string
          secret_name: string
          secret_value: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          environment: string
          id?: string
          provider: string
          secret_name: string
          secret_value: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          environment?: string
          id?: string
          provider?: string
          secret_name?: string
          secret_value?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      payments: {
        Row: {
          amount_pence: number
          capture_method: string | null
          captured_amount_pence: number | null
          commission_amount_pence: number | null
          commission_pct: number | null
          created_at: string
          currency: string
          driver_amount_pence: number | null
          driver_id: string | null
          driver_stripe_account_id: string | null
          fee_type: string | null
          gross_amount_pence: number | null
          id: string
          last_error: string | null
          metadata: Json | null
          net_platform_amount_pence: number | null
          payment_provider: string | null
          provider_available_on: string | null
          provider_charge_id: string | null
          provider_fee_pence: number | null
          provider_payment_id: string | null
          provider_payout_id: string | null
          provider_status: string | null
          provider_transfer_id: string | null
          provider_webhook_event_id: string | null
          refund_status: string | null
          refunded_amount_pence: number
          refunded_at: string | null
          status: string
          stripe_application_fee_amount: number | null
          stripe_fee_pence: number | null
          stripe_payment_intent_id: string
          stripe_refund_id: string | null
          trip_id: string
          updated_at: string
        }
        Insert: {
          amount_pence: number
          capture_method?: string | null
          captured_amount_pence?: number | null
          commission_amount_pence?: number | null
          commission_pct?: number | null
          created_at?: string
          currency?: string
          driver_amount_pence?: number | null
          driver_id?: string | null
          driver_stripe_account_id?: string | null
          fee_type?: string | null
          gross_amount_pence?: number | null
          id?: string
          last_error?: string | null
          metadata?: Json | null
          net_platform_amount_pence?: number | null
          payment_provider?: string | null
          provider_available_on?: string | null
          provider_charge_id?: string | null
          provider_fee_pence?: number | null
          provider_payment_id?: string | null
          provider_payout_id?: string | null
          provider_status?: string | null
          provider_transfer_id?: string | null
          provider_webhook_event_id?: string | null
          refund_status?: string | null
          refunded_amount_pence?: number
          refunded_at?: string | null
          status?: string
          stripe_application_fee_amount?: number | null
          stripe_fee_pence?: number | null
          stripe_payment_intent_id: string
          stripe_refund_id?: string | null
          trip_id: string
          updated_at?: string
        }
        Update: {
          amount_pence?: number
          capture_method?: string | null
          captured_amount_pence?: number | null
          commission_amount_pence?: number | null
          commission_pct?: number | null
          created_at?: string
          currency?: string
          driver_amount_pence?: number | null
          driver_id?: string | null
          driver_stripe_account_id?: string | null
          fee_type?: string | null
          gross_amount_pence?: number | null
          id?: string
          last_error?: string | null
          metadata?: Json | null
          net_platform_amount_pence?: number | null
          payment_provider?: string | null
          provider_available_on?: string | null
          provider_charge_id?: string | null
          provider_fee_pence?: number | null
          provider_payment_id?: string | null
          provider_payout_id?: string | null
          provider_status?: string | null
          provider_transfer_id?: string | null
          provider_webhook_event_id?: string | null
          refund_status?: string | null
          refunded_amount_pence?: number
          refunded_at?: string | null
          status?: string
          stripe_application_fee_amount?: number | null
          stripe_fee_pence?: number | null
          stripe_payment_intent_id?: string
          stripe_refund_id?: string | null
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "payments_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "payments_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "payments_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      payout_audit_log: {
        Row: {
          created_at: string
          driver_id: string | null
          event_type: string
          id: string
          metadata: Json
          payout_type: string
          provider_balance_pence: number | null
          provider_error_code: string | null
          provider_error_message: string | null
          requested_amount_pence: number | null
        }
        Insert: {
          created_at?: string
          driver_id?: string | null
          event_type: string
          id?: string
          metadata?: Json
          payout_type?: string
          provider_balance_pence?: number | null
          provider_error_code?: string | null
          provider_error_message?: string | null
          requested_amount_pence?: number | null
        }
        Update: {
          created_at?: string
          driver_id?: string | null
          event_type?: string
          id?: string
          metadata?: Json
          payout_type?: string
          provider_balance_pence?: number | null
          provider_error_code?: string | null
          provider_error_message?: string | null
          requested_amount_pence?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "payout_audit_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_audit_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "payout_audit_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "payout_audit_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "payout_audit_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_audit_log_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      payout_authorization: {
        Row: {
          allocation_snapshot: Json
          authorization_id: string
          authorized_amount_pence: number
          authorized_at: string
          calculation_hash: string
          created_at: string
          driver_id: string
          eligible_settled_unpaid_pence: number
          expires_at: string
          in_flight_pence_at_auth: number
          invalidated_at: string | null
          invalidation_reason: string | null
          ledger_snapshot_hash: string
          manual_review_holdback_pence: number
          payout_item_id: string | null
          settlement_snapshot_hash: string
          status: string
          updated_at: string
          wallet_balance_pence_at_auth: number
        }
        Insert: {
          allocation_snapshot?: Json
          authorization_id?: string
          authorized_amount_pence: number
          authorized_at?: string
          calculation_hash: string
          created_at?: string
          driver_id: string
          eligible_settled_unpaid_pence?: number
          expires_at: string
          in_flight_pence_at_auth?: number
          invalidated_at?: string | null
          invalidation_reason?: string | null
          ledger_snapshot_hash: string
          manual_review_holdback_pence?: number
          payout_item_id?: string | null
          settlement_snapshot_hash: string
          status?: string
          updated_at?: string
          wallet_balance_pence_at_auth?: number
        }
        Update: {
          allocation_snapshot?: Json
          authorization_id?: string
          authorized_amount_pence?: number
          authorized_at?: string
          calculation_hash?: string
          created_at?: string
          driver_id?: string
          eligible_settled_unpaid_pence?: number
          expires_at?: string
          in_flight_pence_at_auth?: number
          invalidated_at?: string | null
          invalidation_reason?: string | null
          ledger_snapshot_hash?: string
          manual_review_holdback_pence?: number
          payout_item_id?: string | null
          settlement_snapshot_hash?: string
          status?: string
          updated_at?: string
          wallet_balance_pence_at_auth?: number
        }
        Relationships: [
          {
            foreignKeyName: "payout_authorization_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_authorization_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "payout_authorization_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "payout_authorization_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "payout_authorization_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_authorization_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_authorization_payout_item_id_fkey"
            columns: ["payout_item_id"]
            isOneToOne: false
            referencedRelation: "payout_items"
            referencedColumns: ["id"]
          },
        ]
      }
      payout_batches: {
        Row: {
          completed_at: string | null
          created_at: string
          created_by: string | null
          failed_at: string | null
          failed_payouts: number | null
          failure_code: string | null
          failure_reason: string | null
          id: string
          kind: string
          notes: string | null
          provider_response: Json | null
          run_date: string
          status: string
          successful_payouts: number | null
          total_amount_pence: number | null
          total_drivers: number | null
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          failed_at?: string | null
          failed_payouts?: number | null
          failure_code?: string | null
          failure_reason?: string | null
          id?: string
          kind: string
          notes?: string | null
          provider_response?: Json | null
          run_date?: string
          status?: string
          successful_payouts?: number | null
          total_amount_pence?: number | null
          total_drivers?: number | null
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          failed_at?: string | null
          failed_payouts?: number | null
          failure_code?: string | null
          failure_reason?: string | null
          id?: string
          kind?: string
          notes?: string | null
          provider_response?: Json | null
          run_date?: string
          status?: string
          successful_payouts?: number | null
          total_amount_pence?: number | null
          total_drivers?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      payout_item_ledger_allocations: {
        Row: {
          allocated_at: string | null
          amount_pence: number
          created_at: string
          id: string
          ledger_entry_id: string
          payout_item_id: string | null
          source_ledger_debit_id: string | null
        }
        Insert: {
          allocated_at?: string | null
          amount_pence: number
          created_at?: string
          id?: string
          ledger_entry_id: string
          payout_item_id?: string | null
          source_ledger_debit_id?: string | null
        }
        Update: {
          allocated_at?: string | null
          amount_pence?: number
          created_at?: string
          id?: string
          ledger_entry_id?: string
          payout_item_id?: string | null
          source_ledger_debit_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payout_item_ledger_allocations_ledger_entry_id_fkey"
            columns: ["ledger_entry_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_item_ledger_allocations_ledger_entry_id_fkey"
            columns: ["ledger_entry_id"]
            isOneToOne: false
            referencedRelation: "v_finance_era_digital"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_item_ledger_allocations_ledger_entry_id_fkey"
            columns: ["ledger_entry_id"]
            isOneToOne: false
            referencedRelation: "v_finance_era_legacy_cash"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_item_ledger_allocations_payout_item_id_fkey"
            columns: ["payout_item_id"]
            isOneToOne: false
            referencedRelation: "payout_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_item_ledger_allocations_source_ledger_debit_id_fkey"
            columns: ["source_ledger_debit_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_item_ledger_allocations_source_ledger_debit_id_fkey"
            columns: ["source_ledger_debit_id"]
            isOneToOne: false
            referencedRelation: "v_finance_era_digital"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_item_ledger_allocations_source_ledger_debit_id_fkey"
            columns: ["source_ledger_debit_id"]
            isOneToOne: false
            referencedRelation: "v_finance_era_legacy_cash"
            referencedColumns: ["id"]
          },
        ]
      }
      payout_items: {
        Row: {
          amount_pence: number
          authorization_id: string | null
          batch_id: string | null
          cash_commission_recovered_pence: number | null
          commission_amount_pence: number | null
          commission_pct: number | null
          completed_at: string | null
          created_at: string
          driver_amount_pence: number | null
          driver_id: string
          driver_paid_out_pence: number | null
          driver_stripe_account_id: string | null
          error_message: string | null
          excluded_from_auto_allocation: boolean
          failed_at: string | null
          failed_payout_amount_pence: number | null
          failure_code: string | null
          failure_reason: string | null
          gross_amount_pence: number | null
          gross_payable_pence: number | null
          id: string
          ledger_entry_id: string | null
          ledger_sync_error: string | null
          manual_review_reason: string | null
          manual_review_required: boolean
          net_driver_payout_pence: number | null
          onecab_fee_pence: number | null
          payment_id: string | null
          payout_type: string | null
          provider_reference: string | null
          provider_response: Json | null
          provider_status: string | null
          return_ledger_entry_id: string | null
          returned_to_wallet_pence: number | null
          settlement_status: string | null
          status: string
          stripe_fee_pence: number | null
          stripe_instant_available_before_pence: number | null
          stripe_method: string
          stripe_payout_id: string | null
          stripe_transfer_id: string | null
          trip_id: string | null
          updated_at: string
          wallet_after_pence: number | null
          wallet_before_pence: number | null
          wallet_recalculated_at: string | null
        }
        Insert: {
          amount_pence: number
          authorization_id?: string | null
          batch_id?: string | null
          cash_commission_recovered_pence?: number | null
          commission_amount_pence?: number | null
          commission_pct?: number | null
          completed_at?: string | null
          created_at?: string
          driver_amount_pence?: number | null
          driver_id: string
          driver_paid_out_pence?: number | null
          driver_stripe_account_id?: string | null
          error_message?: string | null
          excluded_from_auto_allocation?: boolean
          failed_at?: string | null
          failed_payout_amount_pence?: number | null
          failure_code?: string | null
          failure_reason?: string | null
          gross_amount_pence?: number | null
          gross_payable_pence?: number | null
          id?: string
          ledger_entry_id?: string | null
          ledger_sync_error?: string | null
          manual_review_reason?: string | null
          manual_review_required?: boolean
          net_driver_payout_pence?: number | null
          onecab_fee_pence?: number | null
          payment_id?: string | null
          payout_type?: string | null
          provider_reference?: string | null
          provider_response?: Json | null
          provider_status?: string | null
          return_ledger_entry_id?: string | null
          returned_to_wallet_pence?: number | null
          settlement_status?: string | null
          status?: string
          stripe_fee_pence?: number | null
          stripe_instant_available_before_pence?: number | null
          stripe_method?: string
          stripe_payout_id?: string | null
          stripe_transfer_id?: string | null
          trip_id?: string | null
          updated_at?: string
          wallet_after_pence?: number | null
          wallet_before_pence?: number | null
          wallet_recalculated_at?: string | null
        }
        Update: {
          amount_pence?: number
          authorization_id?: string | null
          batch_id?: string | null
          cash_commission_recovered_pence?: number | null
          commission_amount_pence?: number | null
          commission_pct?: number | null
          completed_at?: string | null
          created_at?: string
          driver_amount_pence?: number | null
          driver_id?: string
          driver_paid_out_pence?: number | null
          driver_stripe_account_id?: string | null
          error_message?: string | null
          excluded_from_auto_allocation?: boolean
          failed_at?: string | null
          failed_payout_amount_pence?: number | null
          failure_code?: string | null
          failure_reason?: string | null
          gross_amount_pence?: number | null
          gross_payable_pence?: number | null
          id?: string
          ledger_entry_id?: string | null
          ledger_sync_error?: string | null
          manual_review_reason?: string | null
          manual_review_required?: boolean
          net_driver_payout_pence?: number | null
          onecab_fee_pence?: number | null
          payment_id?: string | null
          payout_type?: string | null
          provider_reference?: string | null
          provider_response?: Json | null
          provider_status?: string | null
          return_ledger_entry_id?: string | null
          returned_to_wallet_pence?: number | null
          settlement_status?: string | null
          status?: string
          stripe_fee_pence?: number | null
          stripe_instant_available_before_pence?: number | null
          stripe_method?: string
          stripe_payout_id?: string | null
          stripe_transfer_id?: string | null
          trip_id?: string | null
          updated_at?: string
          wallet_after_pence?: number | null
          wallet_before_pence?: number | null
          wallet_recalculated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "payout_items_authorization_id_fkey"
            columns: ["authorization_id"]
            isOneToOne: false
            referencedRelation: "payout_authorization"
            referencedColumns: ["authorization_id"]
          },
          {
            foreignKeyName: "payout_items_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "payout_batches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "payout_items_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "payout_items_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "payout_items_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_ledger_entry_id_fkey"
            columns: ["ledger_entry_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_ledger_entry_id_fkey"
            columns: ["ledger_entry_id"]
            isOneToOne: false
            referencedRelation: "v_finance_era_digital"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_ledger_entry_id_fkey"
            columns: ["ledger_entry_id"]
            isOneToOne: false
            referencedRelation: "v_finance_era_legacy_cash"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_return_ledger_entry_id_fkey"
            columns: ["return_ledger_entry_id"]
            isOneToOne: false
            referencedRelation: "driver_wallet_ledger"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_return_ledger_entry_id_fkey"
            columns: ["return_ledger_entry_id"]
            isOneToOne: false
            referencedRelation: "v_finance_era_digital"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_return_ledger_entry_id_fkey"
            columns: ["return_ledger_entry_id"]
            isOneToOne: false
            referencedRelation: "v_finance_era_legacy_cash"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payout_items_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      pending_customer_signups: {
        Row: {
          created_at: string
          email: string
          email_verified_at: string | null
          expires_at: string
          first_name: string
          id: string
          last_name: string
          phone: string
          phone_verified_at: string | null
          signup_source: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          email: string
          email_verified_at?: string | null
          expires_at?: string
          first_name: string
          id?: string
          last_name: string
          phone: string
          phone_verified_at?: string | null
          signup_source?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          email?: string
          email_verified_at?: string | null
          expires_at?: string
          first_name?: string
          id?: string
          last_name?: string
          phone?: string
          phone_verified_at?: string | null
          signup_source?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      places: {
        Row: {
          address: string
          category: string | null
          created_at: string
          display_name: string | null
          icon: string | null
          id: string
          is_active: boolean
          latitude: number
          longitude: number
          name: string
          postcode: string | null
          search_priority: number
          service_area_id: string | null
          tags: string[]
          updated_at: string
        }
        Insert: {
          address: string
          category?: string | null
          created_at?: string
          display_name?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          latitude: number
          longitude: number
          name: string
          postcode?: string | null
          search_priority?: number
          service_area_id?: string | null
          tags?: string[]
          updated_at?: string
        }
        Update: {
          address?: string
          category?: string | null
          created_at?: string
          display_name?: string | null
          icon?: string | null
          id?: string
          is_active?: boolean
          latitude?: number
          longitude?: number
          name?: string
          postcode?: string | null
          search_priority?: number
          service_area_id?: string | null
          tags?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "places_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      preset_offer_configs: {
        Row: {
          countdown_auto_select: boolean
          countdown_auto_select_offer_id: string | null
          countdown_enabled: boolean
          countdown_seconds: number
          created_at: string
          default_selected_offer_id: string | null
          id: string
          is_enabled: boolean
          price_mode: string
          schedule_days: number[]
          schedule_enabled: boolean
          schedule_end_time: string
          schedule_start_time: string
          service_area_id: string
          updated_at: string
        }
        Insert: {
          countdown_auto_select?: boolean
          countdown_auto_select_offer_id?: string | null
          countdown_enabled?: boolean
          countdown_seconds?: number
          created_at?: string
          default_selected_offer_id?: string | null
          id?: string
          is_enabled?: boolean
          price_mode?: string
          schedule_days?: number[]
          schedule_enabled?: boolean
          schedule_end_time?: string
          schedule_start_time?: string
          service_area_id: string
          updated_at?: string
        }
        Update: {
          countdown_auto_select?: boolean
          countdown_auto_select_offer_id?: string | null
          countdown_enabled?: boolean
          countdown_seconds?: number
          created_at?: string
          default_selected_offer_id?: string | null
          id?: string
          is_enabled?: boolean
          price_mode?: string
          schedule_days?: number[]
          schedule_enabled?: boolean
          schedule_end_time?: string
          schedule_start_time?: string
          service_area_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "preset_offer_configs_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: true
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      preset_offers: {
        Row: {
          color: string | null
          config_id: string
          created_at: string
          description: string | null
          display_order: number
          fixed_amount_pence: number | null
          icon: string | null
          id: string
          is_active: boolean
          label: string
          multiplier: number | null
          offer_key: string
          updated_at: string
        }
        Insert: {
          color?: string | null
          config_id: string
          created_at?: string
          description?: string | null
          display_order?: number
          fixed_amount_pence?: number | null
          icon?: string | null
          id?: string
          is_active?: boolean
          label: string
          multiplier?: number | null
          offer_key: string
          updated_at?: string
        }
        Update: {
          color?: string | null
          config_id?: string
          created_at?: string
          description?: string | null
          display_order?: number
          fixed_amount_pence?: number | null
          icon?: string | null
          id?: string
          is_active?: boolean
          label?: string
          multiplier?: number | null
          offer_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "preset_offers_config_id_fkey"
            columns: ["config_id"]
            isOneToOne: false
            referencedRelation: "preset_offer_configs"
            referencedColumns: ["id"]
          },
        ]
      }
      processed_stripe_events: {
        Row: {
          error: string | null
          event_id: string
          event_type: string
          id: string
          processed_at: string
          status: string
        }
        Insert: {
          error?: string | null
          event_id: string
          event_type: string
          id?: string
          processed_at?: string
          status?: string
        }
        Update: {
          error?: string | null
          event_id?: string
          event_type?: string
          id?: string
          processed_at?: string
          status?: string
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          full_name: string
          phone: string | null
          role: Database["public"]["Enums"]["app_user_role"]
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          full_name?: string
          phone?: string | null
          role: Database["public"]["Enums"]["app_user_role"]
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          full_name?: string
          phone?: string | null
          role?: Database["public"]["Enums"]["app_user_role"]
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      promo_code_redemptions: {
        Row: {
          amount_credited_pence: number
          created_at: string
          id: string
          promo_code_id: string
          user_id: string
        }
        Insert: {
          amount_credited_pence?: number
          created_at?: string
          id?: string
          promo_code_id: string
          user_id: string
        }
        Update: {
          amount_credited_pence?: number
          created_at?: string
          id?: string
          promo_code_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "promo_code_redemptions_promo_code_id_fkey"
            columns: ["promo_code_id"]
            isOneToOne: false
            referencedRelation: "promo_codes"
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
          app_version: string | null
          created_at: string
          device_id: string | null
          driver_id: string
          failure_count: number
          id: string
          is_active: boolean
          last_failure_at: string | null
          last_failure_reason: string | null
          last_seen_at: string | null
          last_success_at: string | null
          platform: string
          token: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          app_type?: string
          app_version?: string | null
          created_at?: string
          device_id?: string | null
          driver_id: string
          failure_count?: number
          id?: string
          is_active?: boolean
          last_failure_at?: string | null
          last_failure_reason?: string | null
          last_seen_at?: string | null
          last_success_at?: string | null
          platform: string
          token: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          app_type?: string
          app_version?: string | null
          created_at?: string
          device_id?: string | null
          driver_id?: string
          failure_count?: number
          id?: string
          is_active?: boolean
          last_failure_at?: string | null
          last_failure_reason?: string | null
          last_seen_at?: string | null
          last_success_at?: string | null
          platform?: string
          token?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "push_tokens_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_tokens_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "push_tokens_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
      qr_booking_audit_log: {
        Row: {
          changed_by: string | null
          changed_by_email: string | null
          created_at: string
          id: string
          new_values: Json
          old_values: Json
        }
        Insert: {
          changed_by?: string | null
          changed_by_email?: string | null
          created_at?: string
          id?: string
          new_values?: Json
          old_values?: Json
        }
        Update: {
          changed_by?: string | null
          changed_by_email?: string | null
          created_at?: string
          id?: string
          new_values?: Json
          old_values?: Json
        }
        Relationships: []
      }
      qr_booking_config: {
        Row: {
          allow_apple_pay: boolean
          allow_card: boolean
          allow_google_pay: boolean
          created_at: string
          id: string
          pickup_address: string
          pickup_lat: number
          pickup_lng: number
          pickup_name: string
          qr_url: string
          status: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          allow_apple_pay?: boolean
          allow_card?: boolean
          allow_google_pay?: boolean
          created_at?: string
          id?: string
          pickup_address?: string
          pickup_lat?: number
          pickup_lng?: number
          pickup_name?: string
          qr_url?: string
          status?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          allow_apple_pay?: boolean
          allow_card?: boolean
          allow_google_pay?: boolean
          created_at?: string
          id?: string
          pickup_address?: string
          pickup_lat?: number
          pickup_lng?: number
          pickup_name?: string
          qr_url?: string
          status?: string
          updated_at?: string
          updated_by?: string | null
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
      ride_offers: {
        Row: {
          ack_at: string | null
          broadcast_round: number
          counter_fare: number | null
          created_at: string
          customer_counter_fare: number | null
          customer_respond_by: string | null
          decline_reason: string | null
          delivered_at: string | null
          delivery_first_dispatched_at: string | null
          delivery_method: string | null
          delivery_phase: string
          delivery_push_attempts: number
          delivery_trace: Json
          distance_meters: number | null
          driver_id: string
          driver_offer_fare: number | null
          driver_respond_by: string | null
          eta_seconds: number | null
          expires_at: string
          grace_window_expires_at: string | null
          id: string
          is_stacked: boolean
          is_urgent_dispatch: boolean
          last_push_requested_at: string | null
          negotiation_expires_at: string | null
          negotiation_status: string | null
          offer_options: number[] | null
          offer_snapshot: Json | null
          offered_at: string
          responded_at: string | null
          revoked_reason: string | null
          status: string
          trip_id: string
          updated_at: string
        }
        Insert: {
          ack_at?: string | null
          broadcast_round?: number
          counter_fare?: number | null
          created_at?: string
          customer_counter_fare?: number | null
          customer_respond_by?: string | null
          decline_reason?: string | null
          delivered_at?: string | null
          delivery_first_dispatched_at?: string | null
          delivery_method?: string | null
          delivery_phase?: string
          delivery_push_attempts?: number
          delivery_trace?: Json
          distance_meters?: number | null
          driver_id: string
          driver_offer_fare?: number | null
          driver_respond_by?: string | null
          eta_seconds?: number | null
          expires_at: string
          grace_window_expires_at?: string | null
          id?: string
          is_stacked?: boolean
          is_urgent_dispatch?: boolean
          last_push_requested_at?: string | null
          negotiation_expires_at?: string | null
          negotiation_status?: string | null
          offer_options?: number[] | null
          offer_snapshot?: Json | null
          offered_at?: string
          responded_at?: string | null
          revoked_reason?: string | null
          status?: string
          trip_id: string
          updated_at?: string
        }
        Update: {
          ack_at?: string | null
          broadcast_round?: number
          counter_fare?: number | null
          created_at?: string
          customer_counter_fare?: number | null
          customer_respond_by?: string | null
          decline_reason?: string | null
          delivered_at?: string | null
          delivery_first_dispatched_at?: string | null
          delivery_method?: string | null
          delivery_phase?: string
          delivery_push_attempts?: number
          delivery_trace?: Json
          distance_meters?: number | null
          driver_id?: string
          driver_offer_fare?: number | null
          driver_respond_by?: string | null
          eta_seconds?: number | null
          expires_at?: string
          grace_window_expires_at?: string | null
          id?: string
          is_stacked?: boolean
          is_urgent_dispatch?: boolean
          last_push_requested_at?: string | null
          negotiation_expires_at?: string | null
          negotiation_status?: string | null
          offer_options?: number[] | null
          offer_snapshot?: Json | null
          offered_at?: string
          responded_at?: string | null
          revoked_reason?: string | null
          status?: string
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ride_offers_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_offers_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "ride_offers_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ride_offers_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
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
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rider_feedback_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "rider_feedback_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rider_feedback_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
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
      role_page_permissions: {
        Row: {
          can_access: boolean
          created_at: string
          id: string
          page_slug: string
          role: Database["public"]["Enums"]["staff_role"]
          updated_at: string
        }
        Insert: {
          can_access?: boolean
          created_at?: string
          id?: string
          page_slug: string
          role: Database["public"]["Enums"]["staff_role"]
          updated_at?: string
        }
        Update: {
          can_access?: boolean
          created_at?: string
          id?: string
          page_slug?: string
          role?: Database["public"]["Enums"]["staff_role"]
          updated_at?: string
        }
        Relationships: []
      }
      scheduled_offer_attempts: {
        Row: {
          broadcast_round: number
          created_at: string
          driver_id: string
          id: string
          responded_at: string | null
          response_time_seconds: number | null
          sent_at: string
          status: string
          trip_id: string
        }
        Insert: {
          broadcast_round?: number
          created_at?: string
          driver_id: string
          id?: string
          responded_at?: string | null
          response_time_seconds?: number | null
          sent_at?: string
          status?: string
          trip_id: string
        }
        Update: {
          broadcast_round?: number
          created_at?: string
          driver_id?: string
          id?: string
          responded_at?: string | null
          response_time_seconds?: number | null
          sent_at?: string
          status?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "scheduled_offer_attempts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_offer_attempts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "scheduled_offer_attempts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "scheduled_offer_attempts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "scheduled_offer_attempts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_offer_attempts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_offer_attempts_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_offer_attempts_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scheduled_offer_attempts_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      service_area_call_masking_config: {
        Row: {
          country_code: string
          created_at: string
          is_active: boolean
          number_pool_id: string
          outbound_caller_id: string
          provider: string
          provider_config_id: string | null
          service_area_id: string
          updated_at: string
        }
        Insert: {
          country_code: string
          created_at?: string
          is_active?: boolean
          number_pool_id: string
          outbound_caller_id: string
          provider: string
          provider_config_id?: string | null
          service_area_id: string
          updated_at?: string
        }
        Update: {
          country_code?: string
          created_at?: string
          is_active?: boolean
          number_pool_id?: string
          outbound_caller_id?: string
          provider?: string
          provider_config_id?: string | null
          service_area_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_area_call_masking_config_provider_config_id_fkey"
            columns: ["provider_config_id"]
            isOneToOne: false
            referencedRelation: "call_masking_provider_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_area_call_masking_config_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: true
            referencedRelation: "service_areas"
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
      service_area_communication_settings: {
        Row: {
          call_masking_enabled: boolean
          created_at: string
          currency: string
          default_method: Database["public"]["Enums"]["communication_default_method"]
          is_enabled: boolean
          masked_call_rate_per_minute_minor: number
          maximum_call_duration_seconds: number
          service_area_id: string
          updated_at: string
          voip_enabled: boolean
          voip_provider: string
          voip_rate_per_minute_minor: number
        }
        Insert: {
          call_masking_enabled?: boolean
          created_at?: string
          currency?: string
          default_method?: Database["public"]["Enums"]["communication_default_method"]
          is_enabled?: boolean
          masked_call_rate_per_minute_minor?: number
          maximum_call_duration_seconds?: number
          service_area_id: string
          updated_at?: string
          voip_enabled?: boolean
          voip_provider?: string
          voip_rate_per_minute_minor?: number
        }
        Update: {
          call_masking_enabled?: boolean
          created_at?: string
          currency?: string
          default_method?: Database["public"]["Enums"]["communication_default_method"]
          is_enabled?: boolean
          masked_call_rate_per_minute_minor?: number
          maximum_call_duration_seconds?: number
          service_area_id?: string
          updated_at?: string
          voip_enabled?: boolean
          voip_provider?: string
          voip_rate_per_minute_minor?: number
        }
        Relationships: [
          {
            foreignKeyName: "service_area_communication_settings_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: true
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      service_area_document_rules: {
        Row: {
          created_at: string
          display_in_driver_app: boolean
          doc_type_id: string
          expiry_required: boolean
          id: string
          is_active: boolean
          mandatory: boolean
          max_age_days: number | null
          service_area_id: string
          sort_order: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_in_driver_app?: boolean
          doc_type_id: string
          expiry_required?: boolean
          id?: string
          is_active?: boolean
          mandatory?: boolean
          max_age_days?: number | null
          service_area_id: string
          sort_order?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_in_driver_app?: boolean
          doc_type_id?: string
          expiry_required?: boolean
          id?: string
          is_active?: boolean
          mandatory?: boolean
          max_age_days?: number | null
          service_area_id?: string
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_area_document_rules_doc_type_id_fkey"
            columns: ["doc_type_id"]
            isOneToOne: false
            referencedRelation: "document_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_area_document_rules_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      service_area_driver_tiers: {
        Row: {
          category_priority: number
          commission_percent: number
          created_at: string
          display_order: number
          id: string
          is_active: boolean
          service_area_id: string
          tier_name: string
          trip_target: number | null
          updated_at: string
        }
        Insert: {
          category_priority?: number
          commission_percent: number
          created_at?: string
          display_order?: number
          id?: string
          is_active?: boolean
          service_area_id: string
          tier_name: string
          trip_target?: number | null
          updated_at?: string
        }
        Update: {
          category_priority?: number
          commission_percent?: number
          created_at?: string
          display_order?: number
          id?: string
          is_active?: boolean
          service_area_id?: string
          tier_name?: string
          trip_target?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_area_driver_tiers_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      service_area_marketplace_settings: {
        Row: {
          created_at: string
          delivery_enabled: boolean
          food_enabled: boolean
          grocery_enabled: boolean
          id: string
          parcel_enabled: boolean
          pharmacy_enabled: boolean
          retail_enabled: boolean
          service_area_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          delivery_enabled?: boolean
          food_enabled?: boolean
          grocery_enabled?: boolean
          id?: string
          parcel_enabled?: boolean
          pharmacy_enabled?: boolean
          retail_enabled?: boolean
          service_area_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          delivery_enabled?: boolean
          food_enabled?: boolean
          grocery_enabled?: boolean
          id?: string
          parcel_enabled?: boolean
          pharmacy_enabled?: boolean
          retail_enabled?: boolean
          service_area_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_area_marketplace_settings_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: true
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      service_area_merchant_settings: {
        Row: {
          category: Database["public"]["Enums"]["merchant_category"]
          delivery_enabled: boolean
          enabled: boolean
          id: string
          service_area_id: string
          updated_at: string
        }
        Insert: {
          category: Database["public"]["Enums"]["merchant_category"]
          delivery_enabled?: boolean
          enabled?: boolean
          id?: string
          service_area_id: string
          updated_at?: string
        }
        Update: {
          category?: Database["public"]["Enums"]["merchant_category"]
          delivery_enabled?: boolean
          enabled?: boolean
          id?: string
          service_area_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_area_merchant_settings_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      service_area_payment_methods: {
        Row: {
          apple_pay_enabled: boolean
          card_enabled: boolean
          created_at: string
          google_pay_enabled: boolean
          id: string
          mobile_wallet_methods: Json | null
          service_area_id: string
          updated_at: string
          wallet_enabled: boolean
        }
        Insert: {
          apple_pay_enabled?: boolean
          card_enabled?: boolean
          created_at?: string
          google_pay_enabled?: boolean
          id?: string
          mobile_wallet_methods?: Json | null
          service_area_id: string
          updated_at?: string
          wallet_enabled?: boolean
        }
        Update: {
          apple_pay_enabled?: boolean
          card_enabled?: boolean
          created_at?: string
          google_pay_enabled?: boolean
          id?: string
          mobile_wallet_methods?: Json | null
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
      service_area_preauth_settings: {
        Row: {
          buffer_type: string
          buffer_value: number
          created_at: string
          enable_preauth_buffer: boolean
          id: string
          max_hold_pence: number | null
          min_hold_pence: number | null
          service_area_id: string
          updated_at: string
        }
        Insert: {
          buffer_type?: string
          buffer_value?: number
          created_at?: string
          enable_preauth_buffer?: boolean
          id?: string
          max_hold_pence?: number | null
          min_hold_pence?: number | null
          service_area_id: string
          updated_at?: string
        }
        Update: {
          buffer_type?: string
          buffer_value?: number
          created_at?: string
          enable_preauth_buffer?: boolean
          id?: string
          max_hold_pence?: number | null
          min_hold_pence?: number | null
          service_area_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_area_preauth_settings_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: true
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      service_area_pricing_settings: {
        Row: {
          airport_charge: number
          created_at: string
          driver_chip_enabled: boolean
          driver_chip_offer_1: number | null
          driver_chip_offer_2: number | null
          driver_chip_offer_3: number | null
          driver_chip_type: string
          id: string
          service_area_id: string
          updated_at: string
        }
        Insert: {
          airport_charge?: number
          created_at?: string
          driver_chip_enabled?: boolean
          driver_chip_offer_1?: number | null
          driver_chip_offer_2?: number | null
          driver_chip_offer_3?: number | null
          driver_chip_type?: string
          id?: string
          service_area_id: string
          updated_at?: string
        }
        Update: {
          airport_charge?: number
          created_at?: string
          driver_chip_enabled?: boolean
          driver_chip_offer_1?: number | null
          driver_chip_offer_2?: number | null
          driver_chip_offer_3?: number | null
          driver_chip_type?: string
          id?: string
          service_area_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_area_pricing_settings_service_area_id_fkey"
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
          airport_charge_pence: number
          base_fare: number
          commission_percentage: number
          created_at: string
          currency_code: string
          distance_pricing: Json
          id: string
          is_enabled: boolean
          minimum_fare: number
          offer_settings: Json
          per_km_rate: number | null
          per_km_rate_pence: number
          per_min_rate_pence: number
          per_minute_rate: number | null
          pickup_waiting_charges: Json
          service_area_id: string
          stops_waiting_charges: Json
          time_pricing: Json
          updated_at: string
          vehicle_type_id: string
        }
        Insert: {
          airport_charge_pence?: number
          base_fare?: number
          commission_percentage?: number
          created_at?: string
          currency_code?: string
          distance_pricing?: Json
          id?: string
          is_enabled?: boolean
          minimum_fare?: number
          offer_settings?: Json
          per_km_rate?: number | null
          per_km_rate_pence?: number
          per_min_rate_pence?: number
          per_minute_rate?: number | null
          pickup_waiting_charges?: Json
          service_area_id: string
          stops_waiting_charges?: Json
          time_pricing?: Json
          updated_at?: string
          vehicle_type_id: string
        }
        Update: {
          airport_charge_pence?: number
          base_fare?: number
          commission_percentage?: number
          created_at?: string
          currency_code?: string
          distance_pricing?: Json
          id?: string
          is_enabled?: boolean
          minimum_fare?: number
          offer_settings?: Json
          per_km_rate?: number | null
          per_km_rate_pence?: number
          per_min_rate_pence?: number
          per_minute_rate?: number | null
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
      service_area_vehicle_types: {
        Row: {
          created_at: string
          display_order: number | null
          id: string
          is_active: boolean
          service_area_id: string
          updated_at: string
          vehicle_type_id: string
        }
        Insert: {
          created_at?: string
          display_order?: number | null
          id?: string
          is_active?: boolean
          service_area_id: string
          updated_at?: string
          vehicle_type_id: string
        }
        Update: {
          created_at?: string
          display_order?: number | null
          id?: string
          is_active?: boolean
          service_area_id?: string
          updated_at?: string
          vehicle_type_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_area_vehicle_types_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_area_vehicle_types_vehicle_type_id_fkey"
            columns: ["vehicle_type_id"]
            isOneToOne: false
            referencedRelation: "vehicle_types"
            referencedColumns: ["id"]
          },
        ]
      }
      service_areas: {
        Row: {
          center_lat: number | null
          center_lng: number | null
          code: string | null
          country: string | null
          created_at: string
          currency_code: string | null
          customer_payment_gateway: string | null
          distance_unit: string | null
          driver_payout_gateway: string | null
          early_cashout_enabled: boolean
          geo_boundary: Json | null
          id: string
          is_active: boolean
          name: string
          payment_provider: string | null
          per_booking_fee_enabled: boolean
          per_booking_fee_pence: number
          pickup_waiting_charges: Json | null
          region_id: string
          stops_waiting_charges: Json | null
          timezone: string | null
          tips_enabled: boolean
          updated_at: string
        }
        Insert: {
          center_lat?: number | null
          center_lng?: number | null
          code?: string | null
          country?: string | null
          created_at?: string
          currency_code?: string | null
          customer_payment_gateway?: string | null
          distance_unit?: string | null
          driver_payout_gateway?: string | null
          early_cashout_enabled?: boolean
          geo_boundary?: Json | null
          id?: string
          is_active?: boolean
          name: string
          payment_provider?: string | null
          per_booking_fee_enabled?: boolean
          per_booking_fee_pence?: number
          pickup_waiting_charges?: Json | null
          region_id: string
          stops_waiting_charges?: Json | null
          timezone?: string | null
          tips_enabled?: boolean
          updated_at?: string
        }
        Update: {
          center_lat?: number | null
          center_lng?: number | null
          code?: string | null
          country?: string | null
          created_at?: string
          currency_code?: string | null
          customer_payment_gateway?: string | null
          distance_unit?: string | null
          driver_payout_gateway?: string | null
          early_cashout_enabled?: boolean
          geo_boundary?: Json | null
          id?: string
          is_active?: boolean
          name?: string
          payment_provider?: string | null
          per_booking_fee_enabled?: boolean
          per_booking_fee_pence?: number
          pickup_waiting_charges?: Json | null
          region_id?: string
          stops_waiting_charges?: Json | null
          timezone?: string | null
          tips_enabled?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "service_areas_customer_payment_gateway_fkey"
            columns: ["customer_payment_gateway"]
            isOneToOne: false
            referencedRelation: "payment_provider_configs"
            referencedColumns: ["provider"]
          },
          {
            foreignKeyName: "service_areas_driver_payout_gateway_fkey"
            columns: ["driver_payout_gateway"]
            isOneToOne: false
            referencedRelation: "payment_provider_configs"
            referencedColumns: ["provider"]
          },
          {
            foreignKeyName: "service_areas_payment_provider_fkey"
            columns: ["payment_provider"]
            isOneToOne: false
            referencedRelation: "payment_provider_configs"
            referencedColumns: ["provider"]
          },
          {
            foreignKeyName: "service_areas_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_coverage_requirements: {
        Row: {
          created_at: string
          day_of_week: number
          end_time: string
          id: string
          is_active: boolean
          region_id: string | null
          required_staff_count: number
          service_area_id: string | null
          shift_name: string
          staff_role: Database["public"]["Enums"]["staff_role"]
          start_time: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          day_of_week: number
          end_time: string
          id?: string
          is_active?: boolean
          region_id?: string | null
          required_staff_count?: number
          service_area_id?: string | null
          shift_name: string
          staff_role: Database["public"]["Enums"]["staff_role"]
          start_time: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          day_of_week?: number
          end_time?: string
          id?: string
          is_active?: boolean
          region_id?: string | null
          required_staff_count?: number
          service_area_id?: string | null
          shift_name?: string
          staff_role?: Database["public"]["Enums"]["staff_role"]
          start_time?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_coverage_requirements_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_coverage_requirements_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_id_sequences: {
        Row: {
          current_value: number
          role_prefix: string
          updated_at: string
        }
        Insert: {
          current_value?: number
          role_prefix: string
          updated_at?: string
        }
        Update: {
          current_value?: number
          role_prefix?: string
          updated_at?: string
        }
        Relationships: []
      }
      staff_leave_exceptions: {
        Row: {
          approved_by: string | null
          created_at: string
          end_time: string | null
          id: string
          leave_date: string
          leave_type: string
          reason: string | null
          staff_id: string
          start_time: string | null
          status: string
          updated_at: string
        }
        Insert: {
          approved_by?: string | null
          created_at?: string
          end_time?: string | null
          id?: string
          leave_date: string
          leave_type: string
          reason?: string | null
          staff_id: string
          start_time?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          approved_by?: string | null
          created_at?: string
          end_time?: string | null
          id?: string
          leave_date?: string
          leave_type?: string
          reason?: string | null
          staff_id?: string
          start_time?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_leave_exceptions_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_pattern_assignments: {
        Row: {
          assigned_at: string
          assigned_by: string | null
          id: string
          is_active: boolean
          pattern_id: string
          staff_id: string
        }
        Insert: {
          assigned_at?: string
          assigned_by?: string | null
          id?: string
          is_active?: boolean
          pattern_id: string
          staff_id: string
        }
        Update: {
          assigned_at?: string
          assigned_by?: string | null
          id?: string
          is_active?: boolean
          pattern_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_pattern_assignments_pattern_id_fkey"
            columns: ["pattern_id"]
            isOneToOne: false
            referencedRelation: "staff_work_patterns"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_pattern_assignments_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_profiles: {
        Row: {
          assigned_pattern_id: string | null
          created_at: string
          created_by: string | null
          full_name: string
          id: string
          is_active: boolean
          role: Database["public"]["Enums"]["staff_role"]
          staff_role_id: string
          updated_at: string
          user_id: string
          username: string | null
        }
        Insert: {
          assigned_pattern_id?: string | null
          created_at?: string
          created_by?: string | null
          full_name: string
          id?: string
          is_active?: boolean
          role?: Database["public"]["Enums"]["staff_role"]
          staff_role_id: string
          updated_at?: string
          user_id: string
          username?: string | null
        }
        Update: {
          assigned_pattern_id?: string | null
          created_at?: string
          created_by?: string | null
          full_name?: string
          id?: string
          is_active?: boolean
          role?: Database["public"]["Enums"]["staff_role"]
          staff_role_id?: string
          updated_at?: string
          user_id?: string
          username?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "staff_profiles_assigned_pattern_id_fkey"
            columns: ["assigned_pattern_id"]
            isOneToOne: false
            referencedRelation: "staff_work_patterns"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_service_areas: {
        Row: {
          created_at: string
          id: string
          service_area_id: string
          staff_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          service_area_id: string
          staff_id: string
        }
        Update: {
          created_at?: string
          id?: string
          service_area_id?: string
          staff_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "staff_service_areas_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_service_areas_staff_id_fkey"
            columns: ["staff_id"]
            isOneToOne: false
            referencedRelation: "staff_profiles"
            referencedColumns: ["id"]
          },
        ]
      }
      staff_work_patterns: {
        Row: {
          archived_at: string | null
          created_at: string
          created_by: string | null
          description: string | null
          effective_from: string | null
          effective_to: string | null
          id: string
          is_active: boolean
          name: string
          pattern_type: Database["public"]["Enums"]["staff_work_pattern_type"]
          region_id: string | null
          schedule: Json
          service_area_id: string | null
          shift_length_preset: Database["public"]["Enums"]["staff_shift_length_preset"]
          staff_role: Database["public"]["Enums"]["staff_role"] | null
          timezone: string
          updated_at: string
          weekly_hours_minutes: number
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          is_active?: boolean
          name: string
          pattern_type?: Database["public"]["Enums"]["staff_work_pattern_type"]
          region_id?: string | null
          schedule?: Json
          service_area_id?: string | null
          shift_length_preset?: Database["public"]["Enums"]["staff_shift_length_preset"]
          staff_role?: Database["public"]["Enums"]["staff_role"] | null
          timezone?: string
          updated_at?: string
          weekly_hours_minutes?: number
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          effective_from?: string | null
          effective_to?: string | null
          id?: string
          is_active?: boolean
          name?: string
          pattern_type?: Database["public"]["Enums"]["staff_work_pattern_type"]
          region_id?: string | null
          schedule?: Json
          service_area_id?: string | null
          shift_length_preset?: Database["public"]["Enums"]["staff_shift_length_preset"]
          staff_role?: Database["public"]["Enums"]["staff_role"] | null
          timezone?: string
          updated_at?: string
          weekly_hours_minutes?: number
        }
        Relationships: [
          {
            foreignKeyName: "staff_work_patterns_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "staff_work_patterns_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      statement_runs: {
        Row: {
          completed_at: string | null
          created_at: string
          created_by: string | null
          currency_code: string
          id: string
          notes: string | null
          period_end: string
          period_start: string
          region_id: string
          schedule_config_id: string | null
          service_area_id: string | null
          status: string
          total_amount_pence: number
          total_invoices: number
          triggered_by: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          currency_code: string
          id?: string
          notes?: string | null
          period_end: string
          period_start: string
          region_id: string
          schedule_config_id?: string | null
          service_area_id?: string | null
          status?: string
          total_amount_pence?: number
          total_invoices?: number
          triggered_by?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          currency_code?: string
          id?: string
          notes?: string | null
          period_end?: string
          period_start?: string
          region_id?: string
          schedule_config_id?: string | null
          service_area_id?: string | null
          status?: string
          total_amount_pence?: number
          total_invoices?: number
          triggered_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "statement_runs_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statement_runs_schedule_config_id_fkey"
            columns: ["schedule_config_id"]
            isOneToOne: false
            referencedRelation: "statement_schedule_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statement_runs_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      statement_schedule_configs: {
        Row: {
          created_at: string
          created_by: string | null
          custom_period_days: number | null
          due_days_after_generation: number
          frequency: string
          generation_day: number
          id: string
          is_auto_generate_enabled: boolean
          is_auto_send_enabled: boolean
          last_run_at: string | null
          last_run_error: string | null
          last_run_invoice_count: number | null
          last_run_status: string | null
          next_run_at: string | null
          scope_region_id: string | null
          scope_service_area_id: string | null
          scope_type: string
          send_day: number | null
          send_hour: number
          send_mode: string
          statement_period_mode: string
          timezone: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          custom_period_days?: number | null
          due_days_after_generation?: number
          frequency?: string
          generation_day?: number
          id?: string
          is_auto_generate_enabled?: boolean
          is_auto_send_enabled?: boolean
          last_run_at?: string | null
          last_run_error?: string | null
          last_run_invoice_count?: number | null
          last_run_status?: string | null
          next_run_at?: string | null
          scope_region_id?: string | null
          scope_service_area_id?: string | null
          scope_type?: string
          send_day?: number | null
          send_hour?: number
          send_mode?: string
          statement_period_mode?: string
          timezone?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          custom_period_days?: number | null
          due_days_after_generation?: number
          frequency?: string
          generation_day?: number
          id?: string
          is_auto_generate_enabled?: boolean
          is_auto_send_enabled?: boolean
          last_run_at?: string | null
          last_run_error?: string | null
          last_run_invoice_count?: number | null
          last_run_status?: string | null
          next_run_at?: string | null
          scope_region_id?: string | null
          scope_service_area_id?: string | null
          scope_type?: string
          send_day?: number | null
          send_hour?: number
          send_mode?: string
          statement_period_mode?: string
          timezone?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "statement_schedule_configs_scope_region_id_fkey"
            columns: ["scope_region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statement_schedule_configs_scope_service_area_id_fkey"
            columns: ["scope_service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      statement_schedule_run_log: {
        Row: {
          completed_at: string | null
          created_at: string
          error_message: string | null
          id: string
          invoice_count: number | null
          period_end: string | null
          period_start: string | null
          region_id: string | null
          schedule_config_id: string
          service_area_id: string | null
          statement_run_id: string | null
          status: string
          triggered_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          invoice_count?: number | null
          period_end?: string | null
          period_start?: string | null
          region_id?: string | null
          schedule_config_id: string
          service_area_id?: string | null
          statement_run_id?: string | null
          status?: string
          triggered_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          error_message?: string | null
          id?: string
          invoice_count?: number | null
          period_end?: string | null
          period_start?: string | null
          region_id?: string | null
          schedule_config_id?: string
          service_area_id?: string | null
          statement_run_id?: string | null
          status?: string
          triggered_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "statement_schedule_run_log_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statement_schedule_run_log_schedule_config_id_fkey"
            columns: ["schedule_config_id"]
            isOneToOne: false
            referencedRelation: "statement_schedule_configs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statement_schedule_run_log_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "statement_schedule_run_log_statement_run_id_fkey"
            columns: ["statement_run_id"]
            isOneToOne: false
            referencedRelation: "statement_runs"
            referencedColumns: ["id"]
          },
        ]
      }
      stop_waiting_settings: {
        Row: {
          created_at: string
          id: string
          service_area_id: string
          stop_radius_enabled: boolean
          stop_radius_meters: number
          stop_waiting_charge_interval_seconds: number
          stop_waiting_grace_period_seconds: number
          stop_waiting_max_minutes: number | null
          stop_waiting_rate_pence_per_minute: number
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          service_area_id: string
          stop_radius_enabled?: boolean
          stop_radius_meters?: number
          stop_waiting_charge_interval_seconds?: number
          stop_waiting_grace_period_seconds?: number
          stop_waiting_max_minutes?: number | null
          stop_waiting_rate_pence_per_minute?: number
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          service_area_id?: string
          stop_radius_enabled?: boolean
          stop_radius_meters?: number
          stop_waiting_charge_interval_seconds?: number
          stop_waiting_grace_period_seconds?: number
          stop_waiting_max_minutes?: number | null
          stop_waiting_rate_pence_per_minute?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stop_waiting_settings_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: true
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_connect_payout_schedule_audit: {
        Row: {
          action: string
          after_delay_days: number | null
          after_interval: string | null
          before_delay_days: number | null
          before_interval: string | null
          connect_available_pence: number | null
          connect_pending_pence: number | null
          created_at: string
          driver_id: string | null
          dry_run: boolean
          error_message: string | null
          id: string
          in_flight_payout_ids: Json | null
          performed_by: string | null
          stripe_account_id: string
        }
        Insert: {
          action: string
          after_delay_days?: number | null
          after_interval?: string | null
          before_delay_days?: number | null
          before_interval?: string | null
          connect_available_pence?: number | null
          connect_pending_pence?: number | null
          created_at?: string
          driver_id?: string | null
          dry_run?: boolean
          error_message?: string | null
          id?: string
          in_flight_payout_ids?: Json | null
          performed_by?: string | null
          stripe_account_id: string
        }
        Update: {
          action?: string
          after_delay_days?: number | null
          after_interval?: string | null
          before_delay_days?: number | null
          before_interval?: string | null
          connect_available_pence?: number | null
          connect_pending_pence?: number | null
          created_at?: string
          driver_id?: string | null
          dry_run?: boolean
          error_message?: string | null
          id?: string
          in_flight_payout_ids?: Json | null
          performed_by?: string | null
          stripe_account_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_connect_payout_schedule_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_connect_payout_schedule_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "stripe_connect_payout_schedule_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "stripe_connect_payout_schedule_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "stripe_connect_payout_schedule_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_connect_payout_schedule_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_connect_payouts: {
        Row: {
          amount_pence: number
          arrival_date: string | null
          balance_transaction_id: string | null
          bank_last4: string | null
          connected_account_id: string
          created_at: string
          currency: string
          driver_id: string | null
          failure_code: string | null
          failure_message: string | null
          id: string
          initiated_at: string | null
          last_synced_at: string
          payout_id: string
          payout_method: string | null
          statement_descriptor: string | null
          status: string
          updated_at: string
        }
        Insert: {
          amount_pence: number
          arrival_date?: string | null
          balance_transaction_id?: string | null
          bank_last4?: string | null
          connected_account_id: string
          created_at?: string
          currency?: string
          driver_id?: string | null
          failure_code?: string | null
          failure_message?: string | null
          id?: string
          initiated_at?: string | null
          last_synced_at?: string
          payout_id: string
          payout_method?: string | null
          statement_descriptor?: string | null
          status: string
          updated_at?: string
        }
        Update: {
          amount_pence?: number
          arrival_date?: string | null
          balance_transaction_id?: string | null
          bank_last4?: string | null
          connected_account_id?: string
          created_at?: string
          currency?: string
          driver_id?: string | null
          failure_code?: string | null
          failure_message?: string | null
          id?: string
          initiated_at?: string | null
          last_synced_at?: string
          payout_id?: string
          payout_method?: string | null
          statement_descriptor?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_connect_payouts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_connect_payouts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "stripe_connect_payouts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "stripe_connect_payouts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "stripe_connect_payouts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_connect_payouts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      support_conversations: {
        Row: {
          assigned_admin_id: string | null
          category: string | null
          channel: string
          created_at: string
          customer_id: string | null
          driver_id: string | null
          id: string
          initiated_by: string
          last_message_at: string | null
          priority: string
          resolved_at: string | null
          status: string
          subject: string
          tags: string[] | null
          trip_id: string | null
          updated_at: string
          user_type: string
        }
        Insert: {
          assigned_admin_id?: string | null
          category?: string | null
          channel?: string
          created_at?: string
          customer_id?: string | null
          driver_id?: string | null
          id?: string
          initiated_by?: string
          last_message_at?: string | null
          priority?: string
          resolved_at?: string | null
          status?: string
          subject: string
          tags?: string[] | null
          trip_id?: string | null
          updated_at?: string
          user_type: string
        }
        Update: {
          assigned_admin_id?: string | null
          category?: string | null
          channel?: string
          created_at?: string
          customer_id?: string | null
          driver_id?: string | null
          id?: string
          initiated_by?: string
          last_message_at?: string | null
          priority?: string
          resolved_at?: string | null
          status?: string
          subject?: string
          tags?: string[] | null
          trip_id?: string | null
          updated_at?: string
          user_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_conversations_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "admin_customer_code_audit"
            referencedColumns: ["customer_id"]
          },
          {
            foreignKeyName: "support_conversations_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "admin_riders_with_trip_stats"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_conversations_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_conversations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_conversations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "support_conversations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "support_conversations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "support_conversations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_conversations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_conversations_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_conversations_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_conversations_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      support_messages: {
        Row: {
          content: string
          content_type: string
          conversation_id: string
          created_at: string
          file_name: string | null
          file_size: number | null
          file_url: string | null
          id: string
          is_read: boolean
          metadata: Json | null
          read_at: string | null
          sender_id: string | null
          sender_type: string
          updated_at: string
        }
        Insert: {
          content: string
          content_type?: string
          conversation_id: string
          created_at?: string
          file_name?: string | null
          file_size?: number | null
          file_url?: string | null
          id?: string
          is_read?: boolean
          metadata?: Json | null
          read_at?: string | null
          sender_id?: string | null
          sender_type: string
          updated_at?: string
        }
        Update: {
          content?: string
          content_type?: string
          conversation_id?: string
          created_at?: string
          file_name?: string | null
          file_size?: number | null
          file_url?: string | null
          id?: string
          is_read?: boolean
          metadata?: Json | null
          read_at?: string | null
          sender_id?: string | null
          sender_type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "support_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "support_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_change_requests: {
        Row: {
          after_route_snapshot: Json
          before_route_snapshot: Json
          change_type: string
          created_at: string
          expires_at: string
          fare_delta_pence: number | null
          id: string
          navigation_impacted: boolean
          new_distance_meters: number | null
          new_duration_seconds: number | null
          new_fare_pence: number | null
          original_distance_meters: number | null
          original_duration_seconds: number | null
          original_fare_pence: number | null
          payment_confirmed_at: string | null
          payment_status: string | null
          rejection_reason: string | null
          requested_by: string
          requester_id: string | null
          requires_approval: boolean
          responded_at: string | null
          response_by: string | null
          status: string
          trip_id: string
          updated_at: string
        }
        Insert: {
          after_route_snapshot: Json
          before_route_snapshot: Json
          change_type: string
          created_at?: string
          expires_at?: string
          fare_delta_pence?: number | null
          id?: string
          navigation_impacted?: boolean
          new_distance_meters?: number | null
          new_duration_seconds?: number | null
          new_fare_pence?: number | null
          original_distance_meters?: number | null
          original_duration_seconds?: number | null
          original_fare_pence?: number | null
          payment_confirmed_at?: string | null
          payment_status?: string | null
          rejection_reason?: string | null
          requested_by?: string
          requester_id?: string | null
          requires_approval?: boolean
          responded_at?: string | null
          response_by?: string | null
          status?: string
          trip_id: string
          updated_at?: string
        }
        Update: {
          after_route_snapshot?: Json
          before_route_snapshot?: Json
          change_type?: string
          created_at?: string
          expires_at?: string
          fare_delta_pence?: number | null
          id?: string
          navigation_impacted?: boolean
          new_distance_meters?: number | null
          new_duration_seconds?: number | null
          new_fare_pence?: number | null
          original_distance_meters?: number | null
          original_duration_seconds?: number | null
          original_fare_pence?: number | null
          payment_confirmed_at?: string | null
          payment_status?: string | null
          rejection_reason?: string | null
          requested_by?: string
          requester_id?: string | null
          requires_approval?: boolean
          responded_at?: string | null
          response_by?: string | null
          status?: string
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_change_requests_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_change_requests_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_change_requests_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_driver_exclusions: {
        Row: {
          created_at: string
          driver_id: string
          offer_id: string | null
          reason: string
          trip_id: string
        }
        Insert: {
          created_at?: string
          driver_id: string
          offer_id?: string | null
          reason: string
          trip_id: string
        }
        Update: {
          created_at?: string
          driver_id?: string
          offer_id?: string | null
          reason?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_driver_exclusions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_driver_exclusions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trip_driver_exclusions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trip_driver_exclusions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trip_driver_exclusions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_driver_exclusions_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_driver_exclusions_offer_id_fkey"
            columns: ["offer_id"]
            isOneToOne: false
            referencedRelation: "ride_offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_driver_exclusions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_driver_exclusions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_driver_exclusions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_finance: {
        Row: {
          base_fare_pence: number
          cash_commission_ledger_id: string | null
          commission_rate_pct: number
          commission_reversal_pence: number
          commissionable_subtotal_pence: number
          created_at: string
          currency_code: string
          debt_recovery_pence: number | null
          destination_change_charge_pence: number
          driver_id: string
          driver_net_before_tip_pence: number
          driver_total_earnings_pence: number
          driver_wallet_reversal_pence: number
          extras_charge_pence: number
          final_driver_payout_pence: number | null
          final_trip_total_pence: number
          financial_status: string
          id: string
          is_financially_countable: boolean
          net_card_revenue_after_refund_pence: number | null
          payment_method: string
          pickup_waiting_charge_pence: number
          platform_commission_pence: number
          refund_amount_pence: number
          refund_status: string | null
          revenue_type: string
          service_area_id: string | null
          settled_at: string | null
          settlement_status: string
          stop_modification_charge_pence: number
          stop_waiting_charge_pence: number
          stripe_application_fee_id: string | null
          stripe_destination_account_id: string | null
          stripe_payment_intent_id: string | null
          stripe_processing_fee_pence: number | null
          tip_amount_pence: number
          trip_id: string
          updated_at: string
          wallet_balance_after_pence: number | null
          wallet_balance_before_pence: number | null
        }
        Insert: {
          base_fare_pence?: number
          cash_commission_ledger_id?: string | null
          commission_rate_pct?: number
          commission_reversal_pence?: number
          commissionable_subtotal_pence?: number
          created_at?: string
          currency_code?: string
          debt_recovery_pence?: number | null
          destination_change_charge_pence?: number
          driver_id: string
          driver_net_before_tip_pence?: number
          driver_total_earnings_pence?: number
          driver_wallet_reversal_pence?: number
          extras_charge_pence?: number
          final_driver_payout_pence?: number | null
          final_trip_total_pence?: number
          financial_status?: string
          id?: string
          is_financially_countable?: boolean
          net_card_revenue_after_refund_pence?: number | null
          payment_method?: string
          pickup_waiting_charge_pence?: number
          platform_commission_pence?: number
          refund_amount_pence?: number
          refund_status?: string | null
          revenue_type?: string
          service_area_id?: string | null
          settled_at?: string | null
          settlement_status?: string
          stop_modification_charge_pence?: number
          stop_waiting_charge_pence?: number
          stripe_application_fee_id?: string | null
          stripe_destination_account_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_processing_fee_pence?: number | null
          tip_amount_pence?: number
          trip_id: string
          updated_at?: string
          wallet_balance_after_pence?: number | null
          wallet_balance_before_pence?: number | null
        }
        Update: {
          base_fare_pence?: number
          cash_commission_ledger_id?: string | null
          commission_rate_pct?: number
          commission_reversal_pence?: number
          commissionable_subtotal_pence?: number
          created_at?: string
          currency_code?: string
          debt_recovery_pence?: number | null
          destination_change_charge_pence?: number
          driver_id?: string
          driver_net_before_tip_pence?: number
          driver_total_earnings_pence?: number
          driver_wallet_reversal_pence?: number
          extras_charge_pence?: number
          final_driver_payout_pence?: number | null
          final_trip_total_pence?: number
          financial_status?: string
          id?: string
          is_financially_countable?: boolean
          net_card_revenue_after_refund_pence?: number | null
          payment_method?: string
          pickup_waiting_charge_pence?: number
          platform_commission_pence?: number
          refund_amount_pence?: number
          refund_status?: string | null
          revenue_type?: string
          service_area_id?: string | null
          settled_at?: string | null
          settlement_status?: string
          stop_modification_charge_pence?: number
          stop_waiting_charge_pence?: number
          stripe_application_fee_id?: string | null
          stripe_destination_account_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_processing_fee_pence?: number | null
          tip_amount_pence?: number
          trip_id?: string
          updated_at?: string
          wallet_balance_after_pence?: number | null
          wallet_balance_before_pence?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trip_finance_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_finance_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: true
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_finance_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: true
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_finance_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: true
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_invoice_daily_sequences: {
        Row: {
          invoice_date: string
          last_seq: number
        }
        Insert: {
          invoice_date: string
          last_seq?: number
        }
        Update: {
          invoice_date?: string
          last_seq?: number
        }
        Relationships: []
      }
      trip_invoice_events: {
        Row: {
          created_at: string
          event_type: string
          id: string
          message: string | null
          metadata: Json | null
          status: string | null
          trip_id: string
        }
        Insert: {
          created_at?: string
          event_type: string
          id?: string
          message?: string | null
          metadata?: Json | null
          status?: string | null
          trip_id: string
        }
        Update: {
          created_at?: string
          event_type?: string
          id?: string
          message?: string | null
          metadata?: Json | null
          status?: string | null
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_invoice_events_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_invoice_events_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_invoice_events_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_messages: {
        Row: {
          created_at: string
          id: string
          is_read: boolean
          message: string
          sender_id: string
          sender_type: string
          trip_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_read?: boolean
          message: string
          sender_id: string
          sender_type: string
          trip_id: string
        }
        Update: {
          created_at?: string
          id?: string
          is_read?: boolean
          message?: string
          sender_id?: string
          sender_type?: string
          trip_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_messages_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_messages_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_messages_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_route_cache: {
        Row: {
          cached_at: string
          created_at: string
          dest_lat: number
          dest_lng: number
          distance_km: number
          duration_min: number
          eta_at: string | null
          expires_at: string
          id: string
          leg: string
          origin_lat: number
          origin_lng: number
          polyline: string | null
          reroute_reason: string | null
          trip_id: string
          updated_at: string
        }
        Insert: {
          cached_at?: string
          created_at?: string
          dest_lat: number
          dest_lng: number
          distance_km: number
          duration_min: number
          eta_at?: string | null
          expires_at: string
          id?: string
          leg: string
          origin_lat: number
          origin_lng: number
          polyline?: string | null
          reroute_reason?: string | null
          trip_id: string
          updated_at?: string
        }
        Update: {
          cached_at?: string
          created_at?: string
          dest_lat?: number
          dest_lng?: number
          distance_km?: number
          duration_min?: number
          eta_at?: string | null
          expires_at?: string
          id?: string
          leg?: string
          origin_lat?: number
          origin_lng?: number
          polyline?: string | null
          reroute_reason?: string | null
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_route_cache_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_route_cache_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_route_cache_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      trip_state_violations: {
        Row: {
          confirmed_driver_id: string | null
          dispatch_status: string | null
          driver_id: string | null
          id: number
          new_status: string | null
          observed_at: string
          old_status: string | null
          op: string | null
          request_path: string | null
          trip_code: string | null
          trip_id: string | null
          txid: number | null
          violation_type: string | null
          writer_application_name: string | null
          writer_role: string | null
        }
        Insert: {
          confirmed_driver_id?: string | null
          dispatch_status?: string | null
          driver_id?: string | null
          id?: never
          new_status?: string | null
          observed_at?: string
          old_status?: string | null
          op?: string | null
          request_path?: string | null
          trip_code?: string | null
          trip_id?: string | null
          txid?: number | null
          violation_type?: string | null
          writer_application_name?: string | null
          writer_role?: string | null
        }
        Update: {
          confirmed_driver_id?: string | null
          dispatch_status?: string | null
          driver_id?: string | null
          id?: never
          new_status?: string | null
          observed_at?: string
          old_status?: string | null
          op?: string | null
          request_path?: string | null
          trip_code?: string | null
          trip_id?: string | null
          txid?: number | null
          violation_type?: string | null
          writer_application_name?: string | null
          writer_role?: string | null
        }
        Relationships: []
      }
      trip_stop_waiting: {
        Row: {
          charge_interval_seconds: number
          created_at: string
          driver_id: string
          ended_at: string | null
          grace_period_seconds: number
          id: string
          last_tick_at: string
          rate_pence_per_minute: number
          started_at: string
          status: string
          stop_id: string
          total_charge_pence: number
          total_waiting_seconds: number
          trip_id: string
          updated_at: string
        }
        Insert: {
          charge_interval_seconds?: number
          created_at?: string
          driver_id: string
          ended_at?: string | null
          grace_period_seconds?: number
          id?: string
          last_tick_at?: string
          rate_pence_per_minute?: number
          started_at?: string
          status?: string
          stop_id: string
          total_charge_pence?: number
          total_waiting_seconds?: number
          trip_id: string
          updated_at?: string
        }
        Update: {
          charge_interval_seconds?: number
          created_at?: string
          driver_id?: string
          ended_at?: string | null
          grace_period_seconds?: number
          id?: string
          last_tick_at?: string
          rate_pence_per_minute?: number
          started_at?: string
          status?: string
          stop_id?: string
          total_charge_pence?: number
          total_waiting_seconds?: number
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "trip_stop_waiting_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_stop_waiting_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trip_stop_waiting_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trip_stop_waiting_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trip_stop_waiting_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_stop_waiting_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_stop_waiting_stop_id_fkey"
            columns: ["stop_id"]
            isOneToOne: false
            referencedRelation: "trip_stops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_stop_waiting_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_stop_waiting_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_stop_waiting_trip_id_fkey"
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
          last_waiting_charge_update_at: string | null
          lat: number | null
          lng: number | null
          status: string
          stop_index: number
          trip_id: string
          type: string
          updated_at: string
          waiting_charge_active: boolean
          waiting_charge_pence: number | null
          waiting_started_at: string | null
          waiting_stopped_at: string | null
          waiting_total_amount_pence: number
          waiting_total_seconds: number
        }
        Insert: {
          address: string
          arrived_at?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          last_waiting_charge_update_at?: string | null
          lat?: number | null
          lng?: number | null
          status?: string
          stop_index: number
          trip_id: string
          type: string
          updated_at?: string
          waiting_charge_active?: boolean
          waiting_charge_pence?: number | null
          waiting_started_at?: string | null
          waiting_stopped_at?: string | null
          waiting_total_amount_pence?: number
          waiting_total_seconds?: number
        }
        Update: {
          address?: string
          arrived_at?: string | null
          completed_at?: string | null
          created_at?: string
          id?: string
          last_waiting_charge_update_at?: string | null
          lat?: number | null
          lng?: number | null
          status?: string
          stop_index?: number
          trip_id?: string
          type?: string
          updated_at?: string
          waiting_charge_active?: boolean
          waiting_charge_pence?: number | null
          waiting_started_at?: string | null
          waiting_stopped_at?: string | null
          waiting_total_amount_pence?: number
          waiting_total_seconds?: number
        }
        Relationships: [
          {
            foreignKeyName: "trip_stops_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trip_stops_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
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
          accepted_driver_offer_fare_pence: number | null
          accepted_preset_offer_fare_pence: number | null
          accepted_ride_offer_id: string | null
          airport_charge_pence: number
          applied_offer_code: string | null
          applied_offer_id: string | null
          applied_personal_voucher_code: string | null
          applied_personal_voucher_id: string | null
          arrival_cancellation_applied: boolean
          arrival_cancellation_applied_at: string | null
          arrival_cancellation_fee: number | null
          arrival_cancellation_reason: string | null
          arrived_at: string | null
          assigned_at: string | null
          authorised_amount_pence: number | null
          authorized_amount_pence: number | null
          base_fare_pence: number | null
          booking_source: string | null
          booking_type: string | null
          broadcast_enabled: boolean
          broadcast_started_at: string | null
          cancel_reason: string | null
          cancellation_fee_pence: number | null
          cancellation_grace_expires_at: string | null
          cancellation_note: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          cancelled_by_role: string | null
          cancelled_driver_ids: string[]
          capture_amount_pence: number | null
          cash_collected_at: string | null
          cash_collected_by_driver_id: string | null
          check_in_reminder_sent_at: string | null
          client_action_id: string | null
          commission_pct: number | null
          commission_pence: number | null
          commissionable_fare_pence: number | null
          commitment_time: string | null
          completed_at: string | null
          confirm_deadline_at: string | null
          confirmed_driver_id: string | null
          corporate_account_id: string | null
          created_at: string
          created_pricing_hash: string | null
          currency: string | null
          currency_code: string | null
          current_broadcast_round: number | null
          current_destination_index: number | null
          current_destination_type: string | null
          current_negotiation_id: string | null
          current_offer_driver_id: string | null
          current_offer_expires_at: string | null
          current_stop_id: string | null
          current_stop_index: number | null
          customer_modification_charge_pence: number | null
          debt_recovery_pence: number | null
          deferred_payment_method_id: string | null
          delivery_metadata: Json | null
          delivery_type: string | null
          destination_change_adjustment_pence: number | null
          discount_pence: number | null
          discount_source: string | null
          dispatch_mode: string | null
          dispatch_status: string | null
          distance_unit: string | null
          driver_confirm_deadline_at: string | null
          driver_id: string | null
          driver_location_lat: number | null
          driver_location_lng: number | null
          driver_net_amount: number | null
          driver_net_before_tip_pence: number | null
          driver_net_pence: number | null
          driver_passenger_compliments: string[] | null
          driver_passenger_feedback: string | null
          driver_passenger_low_rating_reasons: string[] | null
          driver_passenger_rating: number | null
          driver_passenger_rating_at: string | null
          driver_passenger_rating_skipped: boolean | null
          driver_passenger_rating_submitted: boolean | null
          driver_payment_confirmed_at: string | null
          driver_started_journey_to_pickup_at: string | null
          driver_tier_commission_percent: number | null
          driver_total_earnings_pence: number | null
          dropoff_address: string
          dropoff_latitude: number | null
          dropoff_longitude: number | null
          dropoff_zone_id: string | null
          escalation_status: string | null
          estimated_distance_km: number | null
          estimated_duration_minutes: number | null
          estimated_fare: number | null
          estimated_total_pence: number | null
          eta_risk_alert_sent_at: string | null
          excluded_driver_ids: string[] | null
          extras_pence: number | null
          fare: number | null
          fare_amount: number | null
          fare_breakdown: Json | null
          fare_engine_config_id: string | null
          fare_locked: boolean | null
          fare_locked_at: string | null
          fare_revision_number: number
          fare_snapshot_json: Json | null
          final_customer_fare_pence: number | null
          final_fare_pence: number | null
          final_payout_pence: number | null
          financial_outcome: string | null
          free_wait_expires_at: string | null
          grace_period_expired_at: string | null
          gross_fare_pence: number | null
          id: string
          idempotency_key: string | null
          invoice_email_error: string | null
          invoice_email_sent: boolean
          invoice_email_sent_at: string | null
          invoice_email_status: string | null
          invoice_generated_at: string | null
          invoice_no: string | null
          invoice_pdf_error: string | null
          invoice_pdf_path: string | null
          invoice_pdf_url: string | null
          invoice_regenerated_at: string | null
          invoice_total_paid_pence: number | null
          is_scheduled: boolean | null
          job_type: string | null
          last_broadcast_at: string | null
          last_eta_calculated_at: string | null
          last_eta_minutes: number | null
          late_cancel_fee_pence: number | null
          locked_base_fare_pence: number | null
          locked_driver_id: string | null
          locked_offer_type: string | null
          max_broadcast_rounds: number | null
          modification_confirmed_at: string | null
          modification_delta_pence: number | null
          modification_status: string | null
          modified_dropoff_address: string | null
          modified_dropoff_latitude: number | null
          modified_dropoff_longitude: number | null
          moving_away_alert_sent_at: string | null
          negotiation_allowed: boolean
          negotiation_disabled: boolean
          negotiation_locked_until: string | null
          negotiation_owner_driver_id: string | null
          negotiation_status: string | null
          no_driver_admin_alert_sent_at: string | null
          no_driver_customer_alert_sent_at: string | null
          no_show_by: string | null
          no_show_charge_pence: number | null
          not_moving_alert_sent_at: string | null
          offer_currency: string | null
          offer_discount_pence: number
          offer_snapshot: Json | null
          onecab_net_pence: number | null
          original_dropoff_address: string | null
          original_dropoff_latitude: number | null
          original_dropoff_longitude: number | null
          original_payment_method: string | null
          other_pass_through_charges_pence: number
          outstanding_balance_pence: number
          paid_waiting_started_at: string | null
          passenger_id: string
          passenger_name: string | null
          passenger_phone: string | null
          payment_coverage_status:
            | Database["public"]["Enums"]["payment_coverage_status"]
            | null
          payment_deferred: boolean
          payment_intent_id: string | null
          payment_intent_version: number | null
          payment_method: string | null
          payment_provider: string | null
          payment_reauth_at: string | null
          payment_reauth_status: string | null
          payment_state: Database["public"]["Enums"]["trip_payment_state"]
          payment_status: string | null
          payment_type: string | null
          pickup_address: string
          pickup_arrived_at: string | null
          pickup_latitude: number | null
          pickup_longitude: number | null
          pickup_paid_waiting_started_at: string | null
          pickup_waiting_admin_config: Json | null
          pickup_waiting_charge_pence: number
          pickup_waiting_started_at: string | null
          pickup_zone_id: string | null
          platform_commission_amount: number | null
          platform_gross_revenue_pence: number | null
          platform_net_revenue_pence: number | null
          pre_assigned_driver_id: string | null
          preauth_buffer_pence: number
          previous_driver_id: string | null
          pricing_mode: string | null
          pricing_source: string | null
          pricing_version: string | null
          provider_available_on: string | null
          provider_charge_id: string | null
          provider_fee_pence: number | null
          provider_payment_id: string | null
          provider_payout_id: string | null
          provider_status: string | null
          provider_transfer_id: string | null
          provider_webhook_event_id: string | null
          qr_session_id: string | null
          quoted_fare_pence: number | null
          refund_amount_pence: number | null
          refund_reason: string | null
          refunded_at: string | null
          region_id: string | null
          scan_go: boolean
          scheduled_accepted_at: string | null
          scheduled_at: string | null
          scheduled_broadcast_at: string | null
          scheduled_committed_at: string | null
          scheduled_convert_at: string | null
          scheduled_driver_risk: boolean
          scheduled_status: string | null
          searching_expires_at: string | null
          sequence_no: number | null
          service_area_code: string | null
          service_area_id: string | null
          settlement_formula_version: string | null
          special_instructions: string | null
          stack_position: number | null
          stacked_trip_id: string | null
          started_at: string | null
          status: string | null
          stop_arrived_at: string | null
          stop_charge_total_pence: number | null
          stop_waiting_charge_amount: number
          stop_waiting_charge_pence: number
          stop_waiting_finalized_at: string | null
          stop_waiting_free_seconds: number | null
          stop_waiting_paid_started_at: string | null
          stop_waiting_started_at: string | null
          stop_waiting_status: string | null
          stops: Json | null
          stripe_application_fee_amount_pence: number | null
          stripe_application_fee_id: string | null
          stripe_charge_id: string | null
          stripe_destination_account_id: string | null
          stripe_fee_amount: number | null
          stripe_payment_intent_id: string | null
          stripe_processing_fee_pence: number | null
          stripe_settlement_verified: boolean
          stripe_settlement_warning: string | null
          stripe_transfer_amount_pence: number | null
          stripe_transfer_id: string | null
          surge_multiplier: number | null
          tip_amount_pence: number
          tip_pence: number | null
          tip_window_closed_at: string | null
          tip_window_expires_at: string | null
          total_authorized_amount_pence: number | null
          total_stops: number | null
          total_waiting_charge_pence: number
          trip_code: string | null
          trip_number: string | null
          trip_type: string | null
          updated_at: string
          vehicle_type: string | null
          vehicle_type_id: string | null
          voucher_discount_pence: number
          waiting_charge_pence: number | null
          waiting_minutes: number | null
          wallet_applied_pence: number | null
          wallet_balance_after: number | null
          wallet_balance_before: number | null
        }
        Insert: {
          accepted_driver_offer_fare_pence?: number | null
          accepted_preset_offer_fare_pence?: number | null
          accepted_ride_offer_id?: string | null
          airport_charge_pence?: number
          applied_offer_code?: string | null
          applied_offer_id?: string | null
          applied_personal_voucher_code?: string | null
          applied_personal_voucher_id?: string | null
          arrival_cancellation_applied?: boolean
          arrival_cancellation_applied_at?: string | null
          arrival_cancellation_fee?: number | null
          arrival_cancellation_reason?: string | null
          arrived_at?: string | null
          assigned_at?: string | null
          authorised_amount_pence?: number | null
          authorized_amount_pence?: number | null
          base_fare_pence?: number | null
          booking_source?: string | null
          booking_type?: string | null
          broadcast_enabled?: boolean
          broadcast_started_at?: string | null
          cancel_reason?: string | null
          cancellation_fee_pence?: number | null
          cancellation_grace_expires_at?: string | null
          cancellation_note?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          cancelled_by_role?: string | null
          cancelled_driver_ids?: string[]
          capture_amount_pence?: number | null
          cash_collected_at?: string | null
          cash_collected_by_driver_id?: string | null
          check_in_reminder_sent_at?: string | null
          client_action_id?: string | null
          commission_pct?: number | null
          commission_pence?: number | null
          commissionable_fare_pence?: number | null
          commitment_time?: string | null
          completed_at?: string | null
          confirm_deadline_at?: string | null
          confirmed_driver_id?: string | null
          corporate_account_id?: string | null
          created_at?: string
          created_pricing_hash?: string | null
          currency?: string | null
          currency_code?: string | null
          current_broadcast_round?: number | null
          current_destination_index?: number | null
          current_destination_type?: string | null
          current_negotiation_id?: string | null
          current_offer_driver_id?: string | null
          current_offer_expires_at?: string | null
          current_stop_id?: string | null
          current_stop_index?: number | null
          customer_modification_charge_pence?: number | null
          debt_recovery_pence?: number | null
          deferred_payment_method_id?: string | null
          delivery_metadata?: Json | null
          delivery_type?: string | null
          destination_change_adjustment_pence?: number | null
          discount_pence?: number | null
          discount_source?: string | null
          dispatch_mode?: string | null
          dispatch_status?: string | null
          distance_unit?: string | null
          driver_confirm_deadline_at?: string | null
          driver_id?: string | null
          driver_location_lat?: number | null
          driver_location_lng?: number | null
          driver_net_amount?: number | null
          driver_net_before_tip_pence?: number | null
          driver_net_pence?: number | null
          driver_passenger_compliments?: string[] | null
          driver_passenger_feedback?: string | null
          driver_passenger_low_rating_reasons?: string[] | null
          driver_passenger_rating?: number | null
          driver_passenger_rating_at?: string | null
          driver_passenger_rating_skipped?: boolean | null
          driver_passenger_rating_submitted?: boolean | null
          driver_payment_confirmed_at?: string | null
          driver_started_journey_to_pickup_at?: string | null
          driver_tier_commission_percent?: number | null
          driver_total_earnings_pence?: number | null
          dropoff_address: string
          dropoff_latitude?: number | null
          dropoff_longitude?: number | null
          dropoff_zone_id?: string | null
          escalation_status?: string | null
          estimated_distance_km?: number | null
          estimated_duration_minutes?: number | null
          estimated_fare?: number | null
          estimated_total_pence?: number | null
          eta_risk_alert_sent_at?: string | null
          excluded_driver_ids?: string[] | null
          extras_pence?: number | null
          fare?: number | null
          fare_amount?: number | null
          fare_breakdown?: Json | null
          fare_engine_config_id?: string | null
          fare_locked?: boolean | null
          fare_locked_at?: string | null
          fare_revision_number?: number
          fare_snapshot_json?: Json | null
          final_customer_fare_pence?: number | null
          final_fare_pence?: number | null
          final_payout_pence?: number | null
          financial_outcome?: string | null
          free_wait_expires_at?: string | null
          grace_period_expired_at?: string | null
          gross_fare_pence?: number | null
          id?: string
          idempotency_key?: string | null
          invoice_email_error?: string | null
          invoice_email_sent?: boolean
          invoice_email_sent_at?: string | null
          invoice_email_status?: string | null
          invoice_generated_at?: string | null
          invoice_no?: string | null
          invoice_pdf_error?: string | null
          invoice_pdf_path?: string | null
          invoice_pdf_url?: string | null
          invoice_regenerated_at?: string | null
          invoice_total_paid_pence?: number | null
          is_scheduled?: boolean | null
          job_type?: string | null
          last_broadcast_at?: string | null
          last_eta_calculated_at?: string | null
          last_eta_minutes?: number | null
          late_cancel_fee_pence?: number | null
          locked_base_fare_pence?: number | null
          locked_driver_id?: string | null
          locked_offer_type?: string | null
          max_broadcast_rounds?: number | null
          modification_confirmed_at?: string | null
          modification_delta_pence?: number | null
          modification_status?: string | null
          modified_dropoff_address?: string | null
          modified_dropoff_latitude?: number | null
          modified_dropoff_longitude?: number | null
          moving_away_alert_sent_at?: string | null
          negotiation_allowed?: boolean
          negotiation_disabled?: boolean
          negotiation_locked_until?: string | null
          negotiation_owner_driver_id?: string | null
          negotiation_status?: string | null
          no_driver_admin_alert_sent_at?: string | null
          no_driver_customer_alert_sent_at?: string | null
          no_show_by?: string | null
          no_show_charge_pence?: number | null
          not_moving_alert_sent_at?: string | null
          offer_currency?: string | null
          offer_discount_pence?: number
          offer_snapshot?: Json | null
          onecab_net_pence?: number | null
          original_dropoff_address?: string | null
          original_dropoff_latitude?: number | null
          original_dropoff_longitude?: number | null
          original_payment_method?: string | null
          other_pass_through_charges_pence?: number
          outstanding_balance_pence?: number
          paid_waiting_started_at?: string | null
          passenger_id: string
          passenger_name?: string | null
          passenger_phone?: string | null
          payment_coverage_status?:
            | Database["public"]["Enums"]["payment_coverage_status"]
            | null
          payment_deferred?: boolean
          payment_intent_id?: string | null
          payment_intent_version?: number | null
          payment_method?: string | null
          payment_provider?: string | null
          payment_reauth_at?: string | null
          payment_reauth_status?: string | null
          payment_state?: Database["public"]["Enums"]["trip_payment_state"]
          payment_status?: string | null
          payment_type?: string | null
          pickup_address: string
          pickup_arrived_at?: string | null
          pickup_latitude?: number | null
          pickup_longitude?: number | null
          pickup_paid_waiting_started_at?: string | null
          pickup_waiting_admin_config?: Json | null
          pickup_waiting_charge_pence?: number
          pickup_waiting_started_at?: string | null
          pickup_zone_id?: string | null
          platform_commission_amount?: number | null
          platform_gross_revenue_pence?: number | null
          platform_net_revenue_pence?: number | null
          pre_assigned_driver_id?: string | null
          preauth_buffer_pence?: number
          previous_driver_id?: string | null
          pricing_mode?: string | null
          pricing_source?: string | null
          pricing_version?: string | null
          provider_available_on?: string | null
          provider_charge_id?: string | null
          provider_fee_pence?: number | null
          provider_payment_id?: string | null
          provider_payout_id?: string | null
          provider_status?: string | null
          provider_transfer_id?: string | null
          provider_webhook_event_id?: string | null
          qr_session_id?: string | null
          quoted_fare_pence?: number | null
          refund_amount_pence?: number | null
          refund_reason?: string | null
          refunded_at?: string | null
          region_id?: string | null
          scan_go?: boolean
          scheduled_accepted_at?: string | null
          scheduled_at?: string | null
          scheduled_broadcast_at?: string | null
          scheduled_committed_at?: string | null
          scheduled_convert_at?: string | null
          scheduled_driver_risk?: boolean
          scheduled_status?: string | null
          searching_expires_at?: string | null
          sequence_no?: number | null
          service_area_code?: string | null
          service_area_id?: string | null
          settlement_formula_version?: string | null
          special_instructions?: string | null
          stack_position?: number | null
          stacked_trip_id?: string | null
          started_at?: string | null
          status?: string | null
          stop_arrived_at?: string | null
          stop_charge_total_pence?: number | null
          stop_waiting_charge_amount?: number
          stop_waiting_charge_pence?: number
          stop_waiting_finalized_at?: string | null
          stop_waiting_free_seconds?: number | null
          stop_waiting_paid_started_at?: string | null
          stop_waiting_started_at?: string | null
          stop_waiting_status?: string | null
          stops?: Json | null
          stripe_application_fee_amount_pence?: number | null
          stripe_application_fee_id?: string | null
          stripe_charge_id?: string | null
          stripe_destination_account_id?: string | null
          stripe_fee_amount?: number | null
          stripe_payment_intent_id?: string | null
          stripe_processing_fee_pence?: number | null
          stripe_settlement_verified?: boolean
          stripe_settlement_warning?: string | null
          stripe_transfer_amount_pence?: number | null
          stripe_transfer_id?: string | null
          surge_multiplier?: number | null
          tip_amount_pence?: number
          tip_pence?: number | null
          tip_window_closed_at?: string | null
          tip_window_expires_at?: string | null
          total_authorized_amount_pence?: number | null
          total_stops?: number | null
          total_waiting_charge_pence?: number
          trip_code?: string | null
          trip_number?: string | null
          trip_type?: string | null
          updated_at?: string
          vehicle_type?: string | null
          vehicle_type_id?: string | null
          voucher_discount_pence?: number
          waiting_charge_pence?: number | null
          waiting_minutes?: number | null
          wallet_applied_pence?: number | null
          wallet_balance_after?: number | null
          wallet_balance_before?: number | null
        }
        Update: {
          accepted_driver_offer_fare_pence?: number | null
          accepted_preset_offer_fare_pence?: number | null
          accepted_ride_offer_id?: string | null
          airport_charge_pence?: number
          applied_offer_code?: string | null
          applied_offer_id?: string | null
          applied_personal_voucher_code?: string | null
          applied_personal_voucher_id?: string | null
          arrival_cancellation_applied?: boolean
          arrival_cancellation_applied_at?: string | null
          arrival_cancellation_fee?: number | null
          arrival_cancellation_reason?: string | null
          arrived_at?: string | null
          assigned_at?: string | null
          authorised_amount_pence?: number | null
          authorized_amount_pence?: number | null
          base_fare_pence?: number | null
          booking_source?: string | null
          booking_type?: string | null
          broadcast_enabled?: boolean
          broadcast_started_at?: string | null
          cancel_reason?: string | null
          cancellation_fee_pence?: number | null
          cancellation_grace_expires_at?: string | null
          cancellation_note?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          cancelled_by_role?: string | null
          cancelled_driver_ids?: string[]
          capture_amount_pence?: number | null
          cash_collected_at?: string | null
          cash_collected_by_driver_id?: string | null
          check_in_reminder_sent_at?: string | null
          client_action_id?: string | null
          commission_pct?: number | null
          commission_pence?: number | null
          commissionable_fare_pence?: number | null
          commitment_time?: string | null
          completed_at?: string | null
          confirm_deadline_at?: string | null
          confirmed_driver_id?: string | null
          corporate_account_id?: string | null
          created_at?: string
          created_pricing_hash?: string | null
          currency?: string | null
          currency_code?: string | null
          current_broadcast_round?: number | null
          current_destination_index?: number | null
          current_destination_type?: string | null
          current_negotiation_id?: string | null
          current_offer_driver_id?: string | null
          current_offer_expires_at?: string | null
          current_stop_id?: string | null
          current_stop_index?: number | null
          customer_modification_charge_pence?: number | null
          debt_recovery_pence?: number | null
          deferred_payment_method_id?: string | null
          delivery_metadata?: Json | null
          delivery_type?: string | null
          destination_change_adjustment_pence?: number | null
          discount_pence?: number | null
          discount_source?: string | null
          dispatch_mode?: string | null
          dispatch_status?: string | null
          distance_unit?: string | null
          driver_confirm_deadline_at?: string | null
          driver_id?: string | null
          driver_location_lat?: number | null
          driver_location_lng?: number | null
          driver_net_amount?: number | null
          driver_net_before_tip_pence?: number | null
          driver_net_pence?: number | null
          driver_passenger_compliments?: string[] | null
          driver_passenger_feedback?: string | null
          driver_passenger_low_rating_reasons?: string[] | null
          driver_passenger_rating?: number | null
          driver_passenger_rating_at?: string | null
          driver_passenger_rating_skipped?: boolean | null
          driver_passenger_rating_submitted?: boolean | null
          driver_payment_confirmed_at?: string | null
          driver_started_journey_to_pickup_at?: string | null
          driver_tier_commission_percent?: number | null
          driver_total_earnings_pence?: number | null
          dropoff_address?: string
          dropoff_latitude?: number | null
          dropoff_longitude?: number | null
          dropoff_zone_id?: string | null
          escalation_status?: string | null
          estimated_distance_km?: number | null
          estimated_duration_minutes?: number | null
          estimated_fare?: number | null
          estimated_total_pence?: number | null
          eta_risk_alert_sent_at?: string | null
          excluded_driver_ids?: string[] | null
          extras_pence?: number | null
          fare?: number | null
          fare_amount?: number | null
          fare_breakdown?: Json | null
          fare_engine_config_id?: string | null
          fare_locked?: boolean | null
          fare_locked_at?: string | null
          fare_revision_number?: number
          fare_snapshot_json?: Json | null
          final_customer_fare_pence?: number | null
          final_fare_pence?: number | null
          final_payout_pence?: number | null
          financial_outcome?: string | null
          free_wait_expires_at?: string | null
          grace_period_expired_at?: string | null
          gross_fare_pence?: number | null
          id?: string
          idempotency_key?: string | null
          invoice_email_error?: string | null
          invoice_email_sent?: boolean
          invoice_email_sent_at?: string | null
          invoice_email_status?: string | null
          invoice_generated_at?: string | null
          invoice_no?: string | null
          invoice_pdf_error?: string | null
          invoice_pdf_path?: string | null
          invoice_pdf_url?: string | null
          invoice_regenerated_at?: string | null
          invoice_total_paid_pence?: number | null
          is_scheduled?: boolean | null
          job_type?: string | null
          last_broadcast_at?: string | null
          last_eta_calculated_at?: string | null
          last_eta_minutes?: number | null
          late_cancel_fee_pence?: number | null
          locked_base_fare_pence?: number | null
          locked_driver_id?: string | null
          locked_offer_type?: string | null
          max_broadcast_rounds?: number | null
          modification_confirmed_at?: string | null
          modification_delta_pence?: number | null
          modification_status?: string | null
          modified_dropoff_address?: string | null
          modified_dropoff_latitude?: number | null
          modified_dropoff_longitude?: number | null
          moving_away_alert_sent_at?: string | null
          negotiation_allowed?: boolean
          negotiation_disabled?: boolean
          negotiation_locked_until?: string | null
          negotiation_owner_driver_id?: string | null
          negotiation_status?: string | null
          no_driver_admin_alert_sent_at?: string | null
          no_driver_customer_alert_sent_at?: string | null
          no_show_by?: string | null
          no_show_charge_pence?: number | null
          not_moving_alert_sent_at?: string | null
          offer_currency?: string | null
          offer_discount_pence?: number
          offer_snapshot?: Json | null
          onecab_net_pence?: number | null
          original_dropoff_address?: string | null
          original_dropoff_latitude?: number | null
          original_dropoff_longitude?: number | null
          original_payment_method?: string | null
          other_pass_through_charges_pence?: number
          outstanding_balance_pence?: number
          paid_waiting_started_at?: string | null
          passenger_id?: string
          passenger_name?: string | null
          passenger_phone?: string | null
          payment_coverage_status?:
            | Database["public"]["Enums"]["payment_coverage_status"]
            | null
          payment_deferred?: boolean
          payment_intent_id?: string | null
          payment_intent_version?: number | null
          payment_method?: string | null
          payment_provider?: string | null
          payment_reauth_at?: string | null
          payment_reauth_status?: string | null
          payment_state?: Database["public"]["Enums"]["trip_payment_state"]
          payment_status?: string | null
          payment_type?: string | null
          pickup_address?: string
          pickup_arrived_at?: string | null
          pickup_latitude?: number | null
          pickup_longitude?: number | null
          pickup_paid_waiting_started_at?: string | null
          pickup_waiting_admin_config?: Json | null
          pickup_waiting_charge_pence?: number
          pickup_waiting_started_at?: string | null
          pickup_zone_id?: string | null
          platform_commission_amount?: number | null
          platform_gross_revenue_pence?: number | null
          platform_net_revenue_pence?: number | null
          pre_assigned_driver_id?: string | null
          preauth_buffer_pence?: number
          previous_driver_id?: string | null
          pricing_mode?: string | null
          pricing_source?: string | null
          pricing_version?: string | null
          provider_available_on?: string | null
          provider_charge_id?: string | null
          provider_fee_pence?: number | null
          provider_payment_id?: string | null
          provider_payout_id?: string | null
          provider_status?: string | null
          provider_transfer_id?: string | null
          provider_webhook_event_id?: string | null
          qr_session_id?: string | null
          quoted_fare_pence?: number | null
          refund_amount_pence?: number | null
          refund_reason?: string | null
          refunded_at?: string | null
          region_id?: string | null
          scan_go?: boolean
          scheduled_accepted_at?: string | null
          scheduled_at?: string | null
          scheduled_broadcast_at?: string | null
          scheduled_committed_at?: string | null
          scheduled_convert_at?: string | null
          scheduled_driver_risk?: boolean
          scheduled_status?: string | null
          searching_expires_at?: string | null
          sequence_no?: number | null
          service_area_code?: string | null
          service_area_id?: string | null
          settlement_formula_version?: string | null
          special_instructions?: string | null
          stack_position?: number | null
          stacked_trip_id?: string | null
          started_at?: string | null
          status?: string | null
          stop_arrived_at?: string | null
          stop_charge_total_pence?: number | null
          stop_waiting_charge_amount?: number
          stop_waiting_charge_pence?: number
          stop_waiting_finalized_at?: string | null
          stop_waiting_free_seconds?: number | null
          stop_waiting_paid_started_at?: string | null
          stop_waiting_started_at?: string | null
          stop_waiting_status?: string | null
          stops?: Json | null
          stripe_application_fee_amount_pence?: number | null
          stripe_application_fee_id?: string | null
          stripe_charge_id?: string | null
          stripe_destination_account_id?: string | null
          stripe_fee_amount?: number | null
          stripe_payment_intent_id?: string | null
          stripe_processing_fee_pence?: number | null
          stripe_settlement_verified?: boolean
          stripe_settlement_warning?: string | null
          stripe_transfer_amount_pence?: number | null
          stripe_transfer_id?: string | null
          surge_multiplier?: number | null
          tip_amount_pence?: number
          tip_pence?: number | null
          tip_window_closed_at?: string | null
          tip_window_expires_at?: string | null
          total_authorized_amount_pence?: number | null
          total_stops?: number | null
          total_waiting_charge_pence?: number
          trip_code?: string | null
          trip_number?: string | null
          trip_type?: string | null
          updated_at?: string
          vehicle_type?: string | null
          vehicle_type_id?: string | null
          voucher_discount_pence?: number
          waiting_charge_pence?: number | null
          waiting_minutes?: number | null
          wallet_applied_pence?: number | null
          wallet_balance_after?: number | null
          wallet_balance_before?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trips_applied_offer_id_fkey"
            columns: ["applied_offer_id"]
            isOneToOne: false
            referencedRelation: "offers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_applied_personal_voucher_id_fkey"
            columns: ["applied_personal_voucher_id"]
            isOneToOne: false
            referencedRelation: "customer_personal_vouchers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_cash_collected_by_driver_id_fkey"
            columns: ["cash_collected_by_driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_cash_collected_by_driver_id_fkey"
            columns: ["cash_collected_by_driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_cash_collected_by_driver_id_fkey"
            columns: ["cash_collected_by_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_cash_collected_by_driver_id_fkey"
            columns: ["cash_collected_by_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_cash_collected_by_driver_id_fkey"
            columns: ["cash_collected_by_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_cash_collected_by_driver_id_fkey"
            columns: ["cash_collected_by_driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_confirmed_driver_id_fkey"
            columns: ["confirmed_driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_confirmed_driver_id_fkey"
            columns: ["confirmed_driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_confirmed_driver_id_fkey"
            columns: ["confirmed_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_confirmed_driver_id_fkey"
            columns: ["confirmed_driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_corporate_account_id_fkey"
            columns: ["corporate_account_id"]
            isOneToOne: false
            referencedRelation: "corporate_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_current_offer_driver_id_fkey"
            columns: ["current_offer_driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_current_offer_driver_id_fkey"
            columns: ["current_offer_driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_current_offer_driver_id_fkey"
            columns: ["current_offer_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_current_offer_driver_id_fkey"
            columns: ["current_offer_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_current_offer_driver_id_fkey"
            columns: ["current_offer_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_current_offer_driver_id_fkey"
            columns: ["current_offer_driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_current_stop_id_fkey"
            columns: ["current_stop_id"]
            isOneToOne: false
            referencedRelation: "trip_stops"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
            foreignKeyName: "trips_fare_engine_config_id_fkey"
            columns: ["fare_engine_config_id"]
            isOneToOne: false
            referencedRelation: "fare_pricing_settings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_locked_driver_id_fkey"
            columns: ["locked_driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_locked_driver_id_fkey"
            columns: ["locked_driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_locked_driver_id_fkey"
            columns: ["locked_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_locked_driver_id_fkey"
            columns: ["locked_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_locked_driver_id_fkey"
            columns: ["locked_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_locked_driver_id_fkey"
            columns: ["locked_driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
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
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_pre_assigned_driver_id_fkey"
            columns: ["pre_assigned_driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_pre_assigned_driver_id_fkey"
            columns: ["pre_assigned_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_pre_assigned_driver_id_fkey"
            columns: ["pre_assigned_driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_previous_driver_id_fkey"
            columns: ["previous_driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_previous_driver_id_fkey"
            columns: ["previous_driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_previous_driver_id_fkey"
            columns: ["previous_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_previous_driver_id_fkey"
            columns: ["previous_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_previous_driver_id_fkey"
            columns: ["previous_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_previous_driver_id_fkey"
            columns: ["previous_driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_stacked_trip_id_fkey"
            columns: ["stacked_trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_stacked_trip_id_fkey"
            columns: ["stacked_trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_stacked_trip_id_fkey"
            columns: ["stacked_trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_vehicle_type_id_fkey"
            columns: ["vehicle_type_id"]
            isOneToOne: false
            referencedRelation: "vehicle_types"
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
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicle_change_requests_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "vehicle_change_requests_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
          driver_controllable: boolean
          features: string[] | null
          icon: string | null
          id: string
          is_active: boolean
          is_default: boolean
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
          driver_controllable?: boolean
          features?: string[] | null
          icon?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean
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
          driver_controllable?: boolean
          features?: string[] | null
          icon?: string | null
          id?: string
          is_active?: boolean
          is_default?: boolean
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
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "vehicles_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "vehicles_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
      voip_call_logs: {
        Row: {
          created_at: string
          customer_id: string | null
          driver_id: string | null
          duration_seconds: number | null
          end_reason: string | null
          ended_at: string | null
          id: string
          provider: string
          service_area_id: string | null
          started_at: string
          status: string
          trip_id: string | null
        }
        Insert: {
          created_at?: string
          customer_id?: string | null
          driver_id?: string | null
          duration_seconds?: number | null
          end_reason?: string | null
          ended_at?: string | null
          id?: string
          provider?: string
          service_area_id?: string | null
          started_at?: string
          status?: string
          trip_id?: string | null
        }
        Update: {
          created_at?: string
          customer_id?: string | null
          driver_id?: string | null
          duration_seconds?: number | null
          end_reason?: string | null
          ended_at?: string | null
          id?: string
          provider?: string
          service_area_id?: string | null
          started_at?: string
          status?: string
          trip_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "voip_call_logs_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voip_call_logs_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voip_call_logs_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "voip_call_logs_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
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
      zone_route_pricing: {
        Row: {
          airport_charge: number
          airport_dropoff_fee: number | null
          airport_pickup_fee: number | null
          created_at: string
          dropoff_fee: number
          fixed_fare: number
          from_zone_id: string
          id: string
          is_active: boolean
          pickup_fee: number
          priority: number
          service_area_id: string | null
          surcharge_pct: number
          to_zone_id: string
          updated_at: string
          vehicle_type_id: string | null
        }
        Insert: {
          airport_charge?: number
          airport_dropoff_fee?: number | null
          airport_pickup_fee?: number | null
          created_at?: string
          dropoff_fee?: number
          fixed_fare: number
          from_zone_id: string
          id?: string
          is_active?: boolean
          pickup_fee?: number
          priority?: number
          service_area_id?: string | null
          surcharge_pct?: number
          to_zone_id: string
          updated_at?: string
          vehicle_type_id?: string | null
        }
        Update: {
          airport_charge?: number
          airport_dropoff_fee?: number | null
          airport_pickup_fee?: number | null
          created_at?: string
          dropoff_fee?: number
          fixed_fare?: number
          from_zone_id?: string
          id?: string
          is_active?: boolean
          pickup_fee?: number
          priority?: number
          service_area_id?: string | null
          surcharge_pct?: number
          to_zone_id?: string
          updated_at?: string
          vehicle_type_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "zone_route_pricing_from_zone_id_fkey"
            columns: ["from_zone_id"]
            isOneToOne: false
            referencedRelation: "custom_zones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_route_pricing_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_route_pricing_to_zone_id_fkey"
            columns: ["to_zone_id"]
            isOneToOne: false
            referencedRelation: "custom_zones"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "zone_route_pricing_vehicle_type_id_fkey"
            columns: ["vehicle_type_id"]
            isOneToOne: false
            referencedRelation: "vehicle_types"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      active_driver_alerts: {
        Row: {
          active_for_seconds: number | null
          alert_type: string | null
          booking_id: string | null
          context: Json | null
          driver_accuracy_m: number | null
          driver_battery_level: number | null
          driver_id: string | null
          driver_last_heartbeat_at: string | null
          driver_last_location_at: string | null
          driver_lat: number | null
          driver_lng: number | null
          driver_name: string | null
          driver_phone: string | null
          driver_presence_status: string | null
          first_detected_at: string | null
          id: string | null
          last_detected_at: string | null
          message: string | null
          severity: Database["public"]["Enums"]["driver_alert_severity"] | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_alerts_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_alerts_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_alerts_booking_id_fkey"
            columns: ["booking_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_alerts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_alerts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_alerts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_alerts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_alerts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_alerts_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_customer_code_audit: {
        Row: {
          classification: string | null
          created_at: string | null
          customer_code: string | null
          customer_id: string | null
          deleted_at: string | null
          email_confirmed_at: string | null
          email_verified: boolean | null
          first_name: string | null
          last_name: string | null
          likely_origin: string | null
          pending_signup_status: string | null
          phone: string | null
          phone_confirmed_at: string | null
          phone_verified: boolean | null
          rider_status: string | null
          user_id: string | null
        }
        Relationships: []
      }
      admin_driver_online_snapshot: {
        Row: {
          app_state: string | null
          availability_exclusion_reason: string | null
          availability_fleet_state: string | null
          available_for_customer_request: boolean | null
          available_for_dispatch: boolean | null
          current_trip_id: string | null
          customer_visible: boolean | null
          delivery_channel: string | null
          dispatchable: boolean | null
          dispatchable_reason: string | null
          documents_approved: boolean | null
          driver_online_intent: boolean | null
          driver_status: Database["public"]["Enums"]["driver_status"] | null
          effective_online: boolean | null
          effective_online_reason: string | null
          first_name: string | null
          fleet_state: string | null
          freshness_ok: boolean | null
          freshness_reason: string | null
          has_registered_push_token: boolean | null
          heartbeat_age_seconds: number | null
          id: string | null
          is_online: boolean | null
          last_heartbeat_at: string | null
          last_location_at: string | null
          last_name: string | null
          last_offline_at: string | null
          last_seen_at: string | null
          location_age_seconds: number | null
          network_type: string | null
          offline_reason: string | null
          operational_online: boolean | null
          platform: string | null
          presence_health: string | null
          presence_status: string | null
          realtime_age_seconds: number | null
          socket_connected: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "drivers_current_trip_id_fkey"
            columns: ["current_trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drivers_current_trip_id_fkey"
            columns: ["current_trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drivers_current_trip_id_fkey"
            columns: ["current_trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_pending_customer_signups: {
        Row: {
          auth_email_confirmed_at: string | null
          auth_phone_confirmed_at: string | null
          created_at: string | null
          email: string | null
          email_verified_at: string | null
          expires_at: string | null
          first_name: string | null
          id: string | null
          last_name: string | null
          legacy_customer_code: string | null
          phone: string | null
          phone_verified_at: string | null
          record_type: string | null
          signup_source: string | null
          status: string | null
          updated_at: string | null
          user_id: string | null
        }
        Relationships: []
      }
      admin_riders_with_trip_stats: {
        Row: {
          created_at: string | null
          customer_code: string | null
          first_name: string | null
          id: string | null
          last_name: string | null
          last_trip_at: string | null
          phone: string | null
          rider_status: string | null
          trip_count: number | null
          updated_at: string | null
          user_id: string | null
        }
        Relationships: []
      }
      admin_trip_lifecycle_fees: {
        Row: {
          cancelled_at: string | null
          confirmed_driver_id: string | null
          created_at: string | null
          debt_recovery_pence: number | null
          driver_id: string | null
          financial_outcome: string | null
          id: string | null
          late_cancel_fee_pence: number | null
          no_show_charge_pence: number | null
          passenger_id: string | null
          payment_method: string | null
          payment_status: string | null
          payment_status_label: string | null
          pickup_waiting_charge_pence: number | null
          sequence_no: number | null
          status: string | null
          stop_waiting_charge_pence: number | null
          total_waiting_charge_pence: number | null
        }
        Insert: {
          cancelled_at?: string | null
          confirmed_driver_id?: string | null
          created_at?: string | null
          debt_recovery_pence?: number | null
          driver_id?: string | null
          financial_outcome?: string | null
          id?: string | null
          late_cancel_fee_pence?: number | null
          no_show_charge_pence?: number | null
          passenger_id?: string | null
          payment_method?: string | null
          payment_status?: string | null
          payment_status_label?: never
          pickup_waiting_charge_pence?: number | null
          sequence_no?: number | null
          status?: string | null
          stop_waiting_charge_pence?: number | null
          total_waiting_charge_pence?: number | null
        }
        Update: {
          cancelled_at?: string | null
          confirmed_driver_id?: string | null
          created_at?: string | null
          debt_recovery_pence?: number | null
          driver_id?: string | null
          financial_outcome?: string | null
          id?: string | null
          late_cancel_fee_pence?: number | null
          no_show_charge_pence?: number | null
          passenger_id?: string | null
          payment_method?: string | null
          payment_status?: string | null
          payment_status_label?: never
          pickup_waiting_charge_pence?: number | null
          sequence_no?: number | null
          status?: string | null
          stop_waiting_charge_pence?: number | null
          total_waiting_charge_pence?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "trips_confirmed_driver_id_fkey"
            columns: ["confirmed_driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_confirmed_driver_id_fkey"
            columns: ["confirmed_driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_confirmed_driver_id_fkey"
            columns: ["confirmed_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
        ]
      }
      app_health_summary: {
        Row: {
          app_name: string | null
          avg_ms: number | null
          event_count: number | null
          last_event_at: string | null
          max_ms: number | null
          median_ms: number | null
          metric_name: string | null
          min_ms: number | null
          p95_ms: number | null
          p99_ms: number | null
          screen_name: string | null
        }
        Relationships: []
      }
      available_scheduled_jobs: {
        Row: {
          arrived_at: string | null
          broadcast_started_at: string | null
          check_in_reminder_sent_at: string | null
          client_action_id: string | null
          commission_pence: number | null
          completed_at: string | null
          confirm_deadline_at: string | null
          confirmed_driver_id: string | null
          created_at: string | null
          currency: string | null
          currency_code: string | null
          current_broadcast_round: number | null
          current_offer_driver_id: string | null
          current_offer_expires_at: string | null
          current_stop_index: number | null
          declined_count: number | null
          dispatch_mode: string | null
          dispatch_status: string | null
          driver_confirm_deadline_at: string | null
          driver_id: string | null
          driver_location_lat: number | null
          driver_location_lng: number | null
          driver_net_pence: number | null
          dropoff_address: string | null
          dropoff_latitude: number | null
          dropoff_longitude: number | null
          dropoff_zone_id: string | null
          escalation_status: string | null
          estimated_distance_km: number | null
          estimated_duration_minutes: number | null
          estimated_fare: number | null
          fare: number | null
          gross_fare_pence: number | null
          id: string | null
          is_scheduled: boolean | null
          job_type: string | null
          last_broadcast_at: string | null
          max_broadcast_rounds: number | null
          passenger_id: string | null
          passenger_name: string | null
          passenger_phone: string | null
          payment_method: string | null
          payment_status: string | null
          payment_type: string | null
          pickup_address: string | null
          pickup_latitude: number | null
          pickup_longitude: number | null
          pickup_zone_id: string | null
          pre_assigned_driver_id: string | null
          qr_session_id: string | null
          scheduled_accepted_at: string | null
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
          updated_at: string | null
          vehicle_type: string | null
        }
        Insert: {
          arrived_at?: string | null
          broadcast_started_at?: string | null
          check_in_reminder_sent_at?: string | null
          client_action_id?: string | null
          commission_pence?: number | null
          completed_at?: string | null
          confirm_deadline_at?: string | null
          confirmed_driver_id?: string | null
          created_at?: string | null
          currency?: string | null
          currency_code?: string | null
          current_broadcast_round?: number | null
          current_offer_driver_id?: string | null
          current_offer_expires_at?: string | null
          current_stop_index?: number | null
          declined_count?: never
          dispatch_mode?: string | null
          dispatch_status?: string | null
          driver_confirm_deadline_at?: string | null
          driver_id?: string | null
          driver_location_lat?: number | null
          driver_location_lng?: number | null
          driver_net_pence?: number | null
          dropoff_address?: string | null
          dropoff_latitude?: number | null
          dropoff_longitude?: number | null
          dropoff_zone_id?: string | null
          escalation_status?: string | null
          estimated_distance_km?: number | null
          estimated_duration_minutes?: number | null
          estimated_fare?: number | null
          fare?: number | null
          gross_fare_pence?: number | null
          id?: string | null
          is_scheduled?: boolean | null
          job_type?: string | null
          last_broadcast_at?: string | null
          max_broadcast_rounds?: number | null
          passenger_id?: string | null
          passenger_name?: string | null
          passenger_phone?: string | null
          payment_method?: string | null
          payment_status?: string | null
          payment_type?: string | null
          pickup_address?: string | null
          pickup_latitude?: number | null
          pickup_longitude?: number | null
          pickup_zone_id?: string | null
          pre_assigned_driver_id?: string | null
          qr_session_id?: string | null
          scheduled_accepted_at?: string | null
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
          updated_at?: string | null
          vehicle_type?: string | null
        }
        Update: {
          arrived_at?: string | null
          broadcast_started_at?: string | null
          check_in_reminder_sent_at?: string | null
          client_action_id?: string | null
          commission_pence?: number | null
          completed_at?: string | null
          confirm_deadline_at?: string | null
          confirmed_driver_id?: string | null
          created_at?: string | null
          currency?: string | null
          currency_code?: string | null
          current_broadcast_round?: number | null
          current_offer_driver_id?: string | null
          current_offer_expires_at?: string | null
          current_stop_index?: number | null
          declined_count?: never
          dispatch_mode?: string | null
          dispatch_status?: string | null
          driver_confirm_deadline_at?: string | null
          driver_id?: string | null
          driver_location_lat?: number | null
          driver_location_lng?: number | null
          driver_net_pence?: number | null
          dropoff_address?: string | null
          dropoff_latitude?: number | null
          dropoff_longitude?: number | null
          dropoff_zone_id?: string | null
          escalation_status?: string | null
          estimated_distance_km?: number | null
          estimated_duration_minutes?: number | null
          estimated_fare?: number | null
          fare?: number | null
          gross_fare_pence?: number | null
          id?: string | null
          is_scheduled?: boolean | null
          job_type?: string | null
          last_broadcast_at?: string | null
          max_broadcast_rounds?: number | null
          passenger_id?: string | null
          passenger_name?: string | null
          passenger_phone?: string | null
          payment_method?: string | null
          payment_status?: string | null
          payment_type?: string | null
          pickup_address?: string | null
          pickup_latitude?: number | null
          pickup_longitude?: number | null
          pickup_zone_id?: string | null
          pre_assigned_driver_id?: string | null
          qr_session_id?: string | null
          scheduled_accepted_at?: string | null
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
          updated_at?: string | null
          vehicle_type?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "trips_confirmed_driver_id_fkey"
            columns: ["confirmed_driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_confirmed_driver_id_fkey"
            columns: ["confirmed_driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_confirmed_driver_id_fkey"
            columns: ["confirmed_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_confirmed_driver_id_fkey"
            columns: ["confirmed_driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_current_offer_driver_id_fkey"
            columns: ["current_offer_driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_current_offer_driver_id_fkey"
            columns: ["current_offer_driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_current_offer_driver_id_fkey"
            columns: ["current_offer_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_current_offer_driver_id_fkey"
            columns: ["current_offer_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_current_offer_driver_id_fkey"
            columns: ["current_offer_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_current_offer_driver_id_fkey"
            columns: ["current_offer_driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "trips_pre_assigned_driver_id_fkey"
            columns: ["pre_assigned_driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
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
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "trips_pre_assigned_driver_id_fkey"
            columns: ["pre_assigned_driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
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
      dispatchable_drivers: {
        Row: {
          app_state: string | null
          current_trip_id: string | null
          driver_id: string | null
          first_name: string | null
          has_presence_push_token_hint: boolean | null
          heading: number | null
          heartbeat_age_seconds: number | null
          last_heartbeat_at: string | null
          last_location_at: string | null
          last_location_updated_at: string | null
          last_name: string | null
          last_seen_at: string | null
          last_socket_pong_at: string | null
          lat: number | null
          lng: number | null
          platform: string | null
          push_token: string | null
          rating: number | null
          socket_connected: boolean | null
          speed: number | null
          status: string | null
          unresolved_critical_tracking: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "drivers_current_trip_id_fkey"
            columns: ["current_trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drivers_current_trip_id_fkey"
            columns: ["current_trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "drivers_current_trip_id_fkey"
            columns: ["current_trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_assigned_vehicle_types: {
        Row: {
          assigned_at: string | null
          assignment_id: string | null
          capacity: number | null
          categories: string[] | null
          description: string | null
          display_order: number | null
          driver_controllable: boolean | null
          driver_id: string | null
          features: string[] | null
          icon: string | null
          is_active: boolean | null
          is_default: boolean | null
          is_enabled: boolean | null
          name: string | null
          slug: string | null
          vehicle_type_id: string | null
        }
        Relationships: []
      }
      driver_call_masking_view: {
        Row: {
          caller_id: string | null
          created_at: string | null
          expires_at: string | null
          id: string | null
          status: string | null
          trip_id: string | null
        }
        Insert: {
          caller_id?: string | null
          created_at?: string | null
          expires_at?: string | null
          id?: string | null
          status?: string | null
          trip_id?: string | null
        }
        Update: {
          caller_id?: string | null
          created_at?: string | null
          expires_at?: string | null
          id?: string | null
          status?: string | null
          trip_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "call_masking_sessions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_masking_sessions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "call_masking_sessions_trip_id_fkey"
            columns: ["trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_document_status: {
        Row: {
          approval_status: string | null
          approved_docs: number | null
          documents_approved: boolean | null
          driver_id: string | null
          first_name: string | null
          last_name: string | null
          pending_docs: number | null
          rejected_docs: number | null
          total_docs: number | null
        }
        Relationships: []
      }
      driver_financial_summary: {
        Row: {
          adjustments_total: number | null
          amount_owed_to_onecab: number | null
          approval_status: string | null
          available_for_payout: number | null
          card_commission_total: number | null
          card_gross_total: number | null
          card_net_credits: number | null
          card_trip_count: number | null
          cash_commission_debits: number | null
          cash_gross_total: number | null
          cash_net_earnings: number | null
          cash_trip_count: number | null
          company_commission_total: number | null
          completed_trips: number | null
          currency_code: string | null
          driver_id: string | null
          email: string | null
          first_name: string | null
          gross_trip_total: number | null
          is_online: boolean | null
          last_name: string | null
          net_available_for_payout: number | null
          onboarding_complete: boolean | null
          payouts_enabled: boolean | null
          phone: string | null
          rating: number | null
          region_id: string | null
          reserved_cashout_pence: number | null
          stripe_account_id: string | null
          today_card_earnings: number | null
          today_cash_earnings: number | null
          today_gross_earnings: number | null
          today_trip_count: number | null
          total_fees: number | null
          total_payouts_sent: number | null
          wallet_balance: number | null
        }
        Relationships: [
          {
            foreignKeyName: "drivers_region_id_fkey"
            columns: ["region_id"]
            isOneToOne: false
            referencedRelation: "regions"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_passenger_profile: {
        Row: {
          current_lat: number | null
          current_lng: number | null
          display_rating: number | null
          first_name: string | null
          heading: number | null
          id: string | null
          is_pet_friendly: boolean | null
          last_location_updated_at: string | null
          last_name: string | null
          profile_photo_url: string | null
          rating: number | null
          rating_count: number | null
          speed: number | null
          total_trips: number | null
        }
        Insert: {
          current_lat?: number | null
          current_lng?: number | null
          display_rating?: number | null
          first_name?: string | null
          heading?: number | null
          id?: string | null
          is_pet_friendly?: boolean | null
          last_location_updated_at?: string | null
          last_name?: string | null
          profile_photo_url?: string | null
          rating?: number | null
          rating_count?: number | null
          speed?: number | null
          total_trips?: number | null
        }
        Update: {
          current_lat?: number | null
          current_lng?: number | null
          display_rating?: number | null
          first_name?: string | null
          heading?: number | null
          id?: string | null
          is_pet_friendly?: boolean | null
          last_location_updated_at?: string | null
          last_name?: string | null
          profile_photo_url?: string | null
          rating?: number | null
          rating_count?: number | null
          speed?: number | null
          total_trips?: number | null
        }
        Relationships: []
      }
      driver_payout_accounts: {
        Row: {
          account_holder_name: string | null
          archived_at: string | null
          created_at: string | null
          currency_code: string | null
          destination_identifier_encrypted: string | null
          destination_last4: string | null
          destination_type: string | null
          driver_id: string | null
          id: string | null
          is_active: boolean | null
          provider_key: string | null
          service_area_id: string | null
          updated_at: string | null
        }
        Insert: {
          account_holder_name?: string | null
          archived_at?: string | null
          created_at?: string | null
          currency_code?: string | null
          destination_identifier_encrypted?: string | null
          destination_last4?: string | null
          destination_type?: string | null
          driver_id?: string | null
          id?: string | null
          is_active?: boolean | null
          provider_key?: string | null
          service_area_id?: string | null
          updated_at?: string | null
        }
        Update: {
          account_holder_name?: string | null
          archived_at?: string | null
          created_at?: string | null
          currency_code?: string | null
          destination_identifier_encrypted?: string | null
          destination_last4?: string | null
          destination_type?: string | null
          driver_id?: string | null
          id?: string | null
          is_active?: boolean | null
          provider_key?: string | null
          service_area_id?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_payout_destinations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destinations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_payout_destinations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_payout_destinations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_payout_destinations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destinations_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destinations_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      driver_payout_destination_audit_logs: {
        Row: {
          action: string | null
          changed_by: string | null
          changed_by_role: string | null
          created_at: string | null
          destination_type: string | null
          device_id: string | null
          driver_id: string | null
          id: string | null
          ip_address: string | null
          metadata: Json | null
          new_payload: Json | null
          new_payout_account_id: string | null
          old_payout_account_id: string | null
          previous_payload: Json | null
          provider_key: string | null
        }
        Insert: {
          action?: string | null
          changed_by?: string | null
          changed_by_role?: string | null
          created_at?: string | null
          destination_type?: string | null
          device_id?: string | null
          driver_id?: string | null
          id?: string | null
          ip_address?: string | null
          metadata?: Json | null
          new_payload?: Json | null
          new_payout_account_id?: string | null
          old_payout_account_id?: string | null
          previous_payload?: Json | null
          provider_key?: string | null
        }
        Update: {
          action?: string | null
          changed_by?: string | null
          changed_by_role?: string | null
          created_at?: string | null
          destination_type?: string | null
          device_id?: string | null
          driver_id?: string | null
          id?: string | null
          ip_address?: string | null
          metadata?: Json | null
          new_payload?: Json | null
          new_payout_account_id?: string | null
          old_payout_account_id?: string | null
          previous_payload?: Json | null
          provider_key?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_payout_destination_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_new_payout_account_id_fkey"
            columns: ["new_payout_account_id"]
            isOneToOne: false
            referencedRelation: "driver_payout_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_new_payout_account_id_fkey"
            columns: ["new_payout_account_id"]
            isOneToOne: false
            referencedRelation: "driver_payout_destinations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_old_payout_account_id_fkey"
            columns: ["old_payout_account_id"]
            isOneToOne: false
            referencedRelation: "driver_payout_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_payout_destination_audit_old_payout_account_id_fkey"
            columns: ["old_payout_account_id"]
            isOneToOne: false
            referencedRelation: "driver_payout_destinations"
            referencedColumns: ["id"]
          },
        ]
      }
      merchants_public: {
        Row: {
          address: string | null
          banner_url: string | null
          business_name: string | null
          category: Database["public"]["Enums"]["merchant_category"] | null
          city: string | null
          created_at: string | null
          delivery_radius_km: number | null
          description: string | null
          id: string | null
          is_open: boolean | null
          logo_url: string | null
          min_order_amount: number | null
          opening_hours: Json | null
          postcode: string | null
          prep_time_minutes: number | null
          service_area_id: string | null
          status: Database["public"]["Enums"]["merchant_status"] | null
          updated_at: string | null
        }
        Insert: {
          address?: string | null
          banner_url?: string | null
          business_name?: string | null
          category?: Database["public"]["Enums"]["merchant_category"] | null
          city?: string | null
          created_at?: string | null
          delivery_radius_km?: number | null
          description?: string | null
          id?: string | null
          is_open?: boolean | null
          logo_url?: string | null
          min_order_amount?: number | null
          opening_hours?: Json | null
          postcode?: string | null
          prep_time_minutes?: number | null
          service_area_id?: string | null
          status?: Database["public"]["Enums"]["merchant_status"] | null
          updated_at?: string | null
        }
        Update: {
          address?: string | null
          banner_url?: string | null
          business_name?: string | null
          category?: Database["public"]["Enums"]["merchant_category"] | null
          city?: string | null
          created_at?: string | null
          delivery_radius_km?: number | null
          description?: string | null
          id?: string | null
          is_open?: boolean | null
          logo_url?: string | null
          min_order_amount?: number | null
          opening_hours?: Json | null
          postcode?: string | null
          prep_time_minutes?: number | null
          service_area_id?: string | null
          status?: Database["public"]["Enums"]["merchant_status"] | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "merchants_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      ops_health_summary: {
        Row: {
          acknowledged_count: number | null
          category: string | null
          critical_count: number | null
          fatal_count: number | null
          latest_alert_at: string | null
          open_count: number | null
          resolved_count: number | null
        }
        Relationships: []
      }
      push_delivery_metrics_24h: {
        Row: {
          attempts_android: number | null
          attempts_ios: number | null
          push_failed_invalid_token: number | null
          push_failed_platform_mismatch: number | null
          push_failed_provider_error: number | null
          push_failed_rate_limit: number | null
          push_failed_unknown: number | null
          push_failed_unregistered: number | null
          push_success: number | null
          push_success_rate_pct: number | null
          total_attempts: number | null
        }
        Relationships: []
      }
      user_directory: {
        Row: {
          created_at: string | null
          email: string | null
          full_name: string | null
          has_linked_record: boolean | null
          phone: string | null
          status: string | null
          user_id: string | null
          user_type: string | null
        }
        Relationships: []
      }
      v_finance_era_digital: {
        Row: {
          amount_pence: number | null
          created_at: string | null
          currency: string | null
          description: string | null
          driver_id: string | null
          id: string | null
          related_trip_id: string | null
          service_area_id: string | null
          stripe_payout_id: string | null
          stripe_transfer_id: string | null
          type: string | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_related_trip_id_fkey"
            columns: ["related_trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_related_trip_id_fkey"
            columns: ["related_trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_related_trip_id_fkey"
            columns: ["related_trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      v_finance_era_legacy_cash: {
        Row: {
          amount_pence: number | null
          created_at: string | null
          currency: string | null
          description: string | null
          driver_id: string | null
          id: string | null
          related_trip_id: string | null
          service_area_id: string | null
          stripe_payout_id: string | null
          stripe_transfer_id: string | null
          type: string | null
        }
        Relationships: [
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "admin_driver_online_snapshot"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_document_status"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_financial_summary"
            referencedColumns: ["driver_id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "driver_passenger_profile"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_driver_id_fkey"
            columns: ["driver_id"]
            isOneToOne: false
            referencedRelation: "drivers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_related_trip_id_fkey"
            columns: ["related_trip_id"]
            isOneToOne: false
            referencedRelation: "admin_trip_lifecycle_fees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_related_trip_id_fkey"
            columns: ["related_trip_id"]
            isOneToOne: false
            referencedRelation: "available_scheduled_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_related_trip_id_fkey"
            columns: ["related_trip_id"]
            isOneToOne: false
            referencedRelation: "trips"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "driver_wallet_ledger_service_area_id_fkey"
            columns: ["service_area_id"]
            isOneToOne: false
            referencedRelation: "service_areas"
            referencedColumns: ["id"]
          },
        ]
      }
      v_finance_era_marker: {
        Row: {
          era: string | null
          started_at: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      accept_ride_offer: {
        Args: {
          p_allow_customer_counter?: boolean
          p_driver_id: string
          p_offer_id: string
        }
        Returns: Json
      }
      accept_scheduled_ride: {
        Args: { p_driver_id: string; p_trip_id: string }
        Returns: Json
      }
      accept_stacked_ride: {
        Args: {
          p_current_trip_id: string
          p_driver_id: string
          p_offer_id: string
        }
        Returns: Json
      }
      ack_offer_delivery: {
        Args: { p_method: string; p_offer_id: string }
        Returns: Json
      }
      ack_timeout_sweep: { Args: never; Returns: undefined }
      adjust_merchant_credits: {
        Args: { _delta: number; _merchant_id: string; _notes?: string }
        Returns: Json
      }
      admin_cancel_trip_negotiation: {
        Args: { p_reason?: string; p_trip_id: string }
        Returns: Json
      }
      admin_driver_financial_summaries: {
        Args: { p_driver_id?: string; p_region_id?: string }
        Returns: {
          adjustments_total: number | null
          amount_owed_to_onecab: number | null
          approval_status: string | null
          available_for_payout: number | null
          card_commission_total: number | null
          card_gross_total: number | null
          card_net_credits: number | null
          card_trip_count: number | null
          cash_commission_debits: number | null
          cash_gross_total: number | null
          cash_net_earnings: number | null
          cash_trip_count: number | null
          company_commission_total: number | null
          completed_trips: number | null
          currency_code: string | null
          driver_id: string | null
          email: string | null
          first_name: string | null
          gross_trip_total: number | null
          is_online: boolean | null
          last_name: string | null
          net_available_for_payout: number | null
          onboarding_complete: boolean | null
          payouts_enabled: boolean | null
          phone: string | null
          rating: number | null
          region_id: string | null
          reserved_cashout_pence: number | null
          stripe_account_id: string | null
          today_card_earnings: number | null
          today_cash_earnings: number | null
          today_gross_earnings: number | null
          today_trip_count: number | null
          total_fees: number | null
          total_payouts_sent: number | null
          wallet_balance: number | null
        }[]
        SetofOptions: {
          from: "*"
          to: "driver_financial_summary"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      admin_list_drivers: {
        Args: never
        Returns: {
          approval_status: string
          business_website_url: string | null
          category_id: string | null
          charges_enabled: boolean | null
          city: string | null
          country: string | null
          country_code: string | null
          created_at: string
          current_lat: number | null
          current_lng: number | null
          current_trip_id: string | null
          deleted_at: string | null
          display_rating: number
          documents_approved: boolean
          driver_code: string | null
          driver_online_intent: boolean
          driver_status: Database["public"]["Enums"]["driver_status"]
          email: string
          email_verified: boolean
          email_verified_at: string | null
          first_name: string
          heading: number | null
          id: string
          is_online: boolean
          is_pet_friendly: boolean
          last_location_updated_at: string | null
          last_name: string
          last_offer_at: string | null
          last_seen_at: string | null
          last_trip_end_at: string | null
          onboarding_complete: boolean | null
          online_since: string | null
          payouts_enabled: boolean | null
          pending_email_change: string | null
          pending_email_change_expires_at: string | null
          pending_email_change_requested_at: string | null
          pending_email_change_verified_at: string | null
          pending_phone_change: string | null
          pending_phone_change_expires_at: string | null
          pending_phone_change_otp_sent_at: string | null
          pending_phone_change_requested_at: string | null
          pending_phone_change_verified_at: string | null
          phone: string
          phone_verified: boolean
          phone_verified_at: string | null
          postcode: string | null
          profile_photo_url: string | null
          rating: number | null
          rating_count: number
          rating_sum: number
          region_id: string
          residential_address: string | null
          service_area_id: string | null
          speed: number | null
          stripe_account_id: string | null
          total_trips: number | null
          updated_at: string
          user_id: string
          using_platform_business_profile: boolean
          vehicle_edit_request_status: string | null
          vehicle_locked: boolean
        }[]
        SetofOptions: {
          from: "*"
          to: "drivers"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      admin_user_directory: {
        Args: never
        Returns: {
          created_at: string | null
          email: string | null
          full_name: string | null
          has_linked_record: boolean | null
          phone: string | null
          status: string | null
          user_id: string | null
          user_type: string | null
        }[]
        SetofOptions: {
          from: "*"
          to: "user_directory"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      advance_trip_change_after_payment: {
        Args: { p_request_id: string }
        Returns: {
          after_route_snapshot: Json
          before_route_snapshot: Json
          change_type: string
          created_at: string
          expires_at: string
          fare_delta_pence: number | null
          id: string
          navigation_impacted: boolean
          new_distance_meters: number | null
          new_duration_seconds: number | null
          new_fare_pence: number | null
          original_distance_meters: number | null
          original_duration_seconds: number | null
          original_fare_pence: number | null
          payment_confirmed_at: string | null
          payment_status: string | null
          rejection_reason: string | null
          requested_by: string
          requester_id: string | null
          requires_approval: boolean
          responded_at: string | null
          response_by: string | null
          status: string
          trip_id: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "trip_change_requests"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      apply_approved_trip_change_from_request: {
        Args: {
          p_req: Database["public"]["Tables"]["trip_change_requests"]["Row"]
        }
        Returns: undefined
      }
      apply_customer_decline_grace: {
        Args: { p_offer_id: string; p_reason?: string }
        Returns: Json
      }
      apply_terminal_trip_cancellation: {
        Args: { p_cancelled_by?: string; p_reason?: string; p_trip_id: string }
        Returns: Json
      }
      apply_trip_modification_to_trip: {
        Args: {
          p_after_snapshot: Json
          p_before_snapshot: Json
          p_change_type: string
          p_fare_delta_pence: number
          p_fare_preview?: Json
          p_new_distance_meters: number
          p_new_duration_seconds: number
          p_new_fare_pence: number
          p_trip_id: string
        }
        Returns: undefined
      }
      approve_corporate_request: {
        Args: { p_request_id: string; p_reviewed_by?: string }
        Returns: string
      }
      approve_merchant_with_credits: {
        Args: { _admin_notes?: string; _merchant_id: string }
        Returns: Json
      }
      assert_driver_presence_online_eligible: {
        Args: { p_driver_id: string }
        Returns: Json
      }
      assert_payment_authorized: {
        Args: { _trip_id: string }
        Returns: boolean
      }
      assign_trip_number: {
        Args: { p_service_area_id: string; p_trip_id: string }
        Returns: Json
      }
      bearing_deg: {
        Args: { lat1: number; lat2: number; lng1: number; lng2: number }
        Returns: number
      }
      booking_delivery_phase_is_idempotent: {
        Args: { p_phase: string }
        Returns: boolean
      }
      can_corporate_user_view_driver: {
        Args: { p_driver_id: string; p_user_id: string }
        Returns: boolean
      }
      can_driver_edit_vehicle: {
        Args: { p_driver_id: string }
        Returns: boolean
      }
      can_modify_trip: { Args: { p_trip_id: string }; Returns: boolean }
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
      can_write_corporate: {
        Args: { p_corporate_account_id: string; p_user_id: string }
        Returns: boolean
      }
      canonical_trip_terminal_stop_reason: {
        Args: {
          p_cancel_reason: string
          p_cancelled_by: string
          p_trip_status: string
        }
        Returns: string
      }
      capture_expired_tip_windows_sweep: { Args: never; Returns: undefined }
      capture_expired_tip_windows_sweep_has_work: {
        Args: never
        Returns: boolean
      }
      check_driver_documents_approved: {
        Args: { p_driver_id: string }
        Returns: boolean
      }
      check_email_available_for_change: {
        Args: { _email: string; _user_id: string }
        Returns: boolean
      }
      check_identity_exists: {
        Args: { p_email?: string; p_phone?: string }
        Returns: Json
      }
      check_phone_available_for_change: {
        Args: { p_app_type: string; p_phone: string; p_user_id: string }
        Returns: Json
      }
      check_schedule_overlap: {
        Args: { p_driver_id: string; p_trip_id: string }
        Returns: Json
      }
      claim_active_device: {
        Args: {
          p_device_id: string
          p_device_label?: string
          p_platform: string
        }
        Returns: {
          driver_id: string
          is_new_device: boolean
          previous_device_id: string
        }[]
      }
      claim_trip_negotiation: {
        Args: { p_driver_id: string; p_trip_id: string }
        Returns: Json
      }
      cleanup_expired_pending_email_changes: { Args: never; Returns: Json }
      cleanup_expired_pending_phone_changes: { Args: never; Returns: Json }
      cleanup_stale_auth_identities: {
        Args: { _dry_run?: boolean; _user_id?: string }
        Returns: Json
      }
      cleanup_unverified_accounts: {
        Args: { _older_than?: string }
        Returns: Json
      }
      clear_phone_change_pending: {
        Args: { _app_type: string; _user_id: string }
        Returns: undefined
      }
      commit_negotiation_fare: {
        Args: {
          p_committed_fare_pence: number
          p_driver_id?: string
          p_fare_source: string
          p_ride_offer_id?: string
          p_trip_id: string
        }
        Returns: Json
      }
      complete_email_change_customer: {
        Args: { _new_email: string; _user_id: string }
        Returns: undefined
      }
      complete_email_change_driver: {
        Args: { _new_email: string; _user_id: string }
        Returns: undefined
      }
      complete_phone_change_customer: {
        Args: { _user_id: string }
        Returns: undefined
      }
      complete_phone_change_driver: {
        Args: { _user_id: string }
        Returns: undefined
      }
      complete_trip_and_promote_next: {
        Args: {
          p_completed_at?: string
          p_driver_id: string
          p_final_fare_pence: number
          p_trip_id: string
        }
        Returns: Json
      }
      compute_dispatch_score:
        | {
            Args: {
              p_category_priority: number
              p_degraded_penalty?: number
              p_distance_meters: number
              p_idle_minutes: number
              p_settings: Database["public"]["Tables"]["dispatch_settings"]["Row"]
            }
            Returns: number
          }
        | {
            Args: {
              p_category_priority: number
              p_degraded_penalty?: number
              p_distance_meters: number
              p_idle_minutes: number
              p_settings: Database["public"]["Tables"]["dispatch_settings"]["Row"]
            }
            Returns: number
          }
      compute_driver_demand_zones_sweep: { Args: never; Returns: undefined }
      compute_driver_demand_zones_sweep_has_work: {
        Args: never
        Returns: boolean
      }
      compute_driver_net_preview_from_gross: {
        Args: {
          p_airport_charge_pence?: number
          p_driver_id: string
          p_gross_pence: number
          p_service_area_id: string
        }
        Returns: number
      }
      compute_preset_offer_fare_pence: {
        Args: {
          p_base_pence: number
          p_fixed_amount_pence: number
          p_multiplier: number
          p_price_mode: string
        }
        Returns: number
      }
      compute_ride_offer_preset_options: {
        Args: { p_trip: Database["public"]["Tables"]["trips"]["Row"] }
        Returns: Json
      }
      consume_personal_voucher: {
        Args: { p_trip_id: string; p_voucher_id: string }
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
      cron_edge_auth_token: { Args: never; Returns: string }
      current_customer_id: { Args: never; Returns: string }
      current_driver_id: { Args: never; Returns: string }
      current_driver_profile_id: { Args: never; Returns: string }
      customer_counter_ride_offer: {
        Args: { p_offer_id: string; p_selected_fare_pence: number }
        Returns: Json
      }
      decline_ride_offer:
        | { Args: { p_driver_id: string; p_offer_id: string }; Returns: Json }
        | {
            Args: { p_driver_id: string; p_offer_id: string; p_reason?: string }
            Returns: Json
          }
      decline_scheduled_ride: {
        Args: { p_driver_id: string; p_trip_id: string }
        Returns: Json
      }
      detect_driver_commitment_monitoring: { Args: never; Returns: undefined }
      detect_driver_problems: { Args: never; Returns: undefined }
      dispatch_effective_radius_meters: {
        Args: {
          p_round: number
          p_settings: Database["public"]["Tables"]["dispatch_settings"]["Row"]
        }
        Returns: number
      }
      dispatch_max_broadcast_rounds: {
        Args: {
          p_settings: Database["public"]["Tables"]["dispatch_settings"]["Row"]
          p_trip_max_rounds?: number
        }
        Returns: number
      }
      dispatch_max_driver_find_minutes: {
        Args: { p_service_area_id?: string }
        Returns: number
      }
      dispatch_trip_offers:
        | { Args: { p_trip_id: string }; Returns: undefined }
        | {
            Args: { p_internal?: boolean; p_trip_id: string }
            Returns: undefined
          }
        | {
            Args: { p_trigger_reason?: string; p_trip_id: string }
            Returns: Json
          }
      dispatch_wave_cap: {
        Args: {
          p_round: number
          p_settings: Database["public"]["Tables"]["dispatch_settings"]["Row"]
        }
        Returns: number
      }
      dispatch_wave_offer_expiry_seconds: {
        Args: {
          p_round: number
          p_settings: Database["public"]["Tables"]["dispatch_settings"]["Row"]
        }
        Returns: number
      }
      dispatchable_reason: {
        Args: {
          p_driver_id: string
          p_max_heartbeat_age_seconds?: number
          p_max_location_age_seconds?: number
          p_require_push_token?: boolean
        }
        Returns: string
      }
      driver_accept_counter_offer: {
        Args: { p_driver_id: string; p_offer_id: string }
        Returns: Json
      }
      driver_availability_ssot: {
        Args: {
          p_driver_id: string
          p_max_heartbeat_age_seconds?: number
          p_max_location_age_seconds?: number
          p_max_realtime_age_seconds?: number
          p_require_push_token?: boolean
        }
        Returns: {
          available_for_customer_request: boolean
          available_for_dispatch: boolean
          dispatchable_reason: string
          driver_id: string
          effective_online_reason: string
          exclusion_reason: string
          fleet_state: string
          freshness_reason: string
          heartbeat_age_seconds: number
          location_age_seconds: number
        }[]
      }
      driver_can_view_trip_via_offer: {
        Args: { _trip_id: string }
        Returns: boolean
      }
      driver_cancel_negotiation: {
        Args: { p_driver_id: string; p_offer_id: string }
        Returns: Json
      }
      driver_compliance_today_london: { Args: never; Returns: string }
      driver_effective_online_reason: {
        Args: {
          p_driver_id: string
          p_max_heartbeat_age_seconds?: number
          p_max_location_age_seconds?: number
          p_max_realtime_age_seconds?: number
          p_require_push_token?: boolean
        }
        Returns: string
      }
      driver_effective_online_snapshot: {
        Args: {
          p_driver_id: string
          p_max_heartbeat_age_seconds?: number
          p_max_location_age_seconds?: number
          p_max_realtime_age_seconds?: number
          p_require_push_token?: boolean
        }
        Returns: {
          app_state: string
          dispatchable: boolean
          dispatchable_reason: string
          driver_id: string
          effective_online: boolean
          effective_online_reason: string
          freshness_ok: boolean
          freshness_reason: string
          has_registered_push_token: boolean
          heartbeat_age_seconds: number
          location_age_seconds: number
          platform: string
          presence_status: string
          realtime_age_seconds: number
          socket_connected: boolean
        }[]
      }
      driver_freshness_reason: {
        Args: {
          p_driver_id: string
          p_max_heartbeat_age_seconds?: number
          p_max_location_age_seconds?: number
          p_max_realtime_age_seconds?: number
          p_require_push_token?: boolean
        }
        Returns: string
      }
      driver_idle_minutes: {
        Args: {
          p_last_seen_at: string
          p_last_trip_end_at: string
          p_now?: string
          p_online_since: string
        }
        Returns: number
      }
      driver_presence_last_signal_at: {
        Args: { p_driver_id: string }
        Returns: string
      }
      driver_send_preset_offer: {
        Args: {
          p_driver_offer_fare_pence: number
          p_offer_id: string
          p_offer_options?: number[]
        }
        Returns: Json
      }
      enrich_ride_offer_presets: { Args: { p_trip_id: string }; Returns: Json }
      ensure_trip_stops_for_assignment: {
        Args: { p_trip_id: string }
        Returns: undefined
      }
      expire_due_call_masking_sessions: { Args: never; Returns: undefined }
      expire_negotiation_offer: { Args: { p_offer_id: string }; Returns: Json }
      expire_offers_sweep: { Args: never; Returns: undefined }
      expire_offers_sweep_has_work: { Args: never; Returns: boolean }
      expire_stale_drivers: {
        Args: { p_ttl_seconds?: number }
        Returns: number
      }
      expire_stale_modification_requests: { Args: never; Returns: number }
      expire_stale_negotiations: { Args: never; Returns: Json }
      expire_stale_offers: { Args: never; Returns: Json }
      expire_trip_when_search_exhausted: {
        Args: { p_trip_id: string }
        Returns: boolean
      }
      finalize_customer_onboarding: {
        Args: { _user_id: string }
        Returns: string
      }
      finalize_driver_early_cashout_paid: {
        Args: { p_cashout_id: string }
        Returns: Json
      }
      finalize_negotiated_fare: {
        Args: {
          p_driver_id: string
          p_fare_source: string
          p_final_fare_pence: number
          p_ride_offer_id: string
          p_trip_id: string
        }
        Returns: Json
      }
      finalize_negotiation_failure: {
        Args: {
          p_failed_driver_id: string
          p_offer_id?: string
          p_offer_negotiation_status?: string
          p_offer_terminal_status?: string
          p_trip_id: string
        }
        Returns: Json
      }
      find_nearby_drivers: {
        Args: {
          p_lat: number
          p_limit?: number
          p_lng: number
          p_radius_meters: number
          p_stale_seconds?: number
        }
        Returns: {
          distance_meters: number
          driver_id: string
          heading: number
          lat: number
          lng: number
          speed: number
          updated_at: string
        }[]
      }
      find_or_create_customer: {
        Args: {
          p_first_name: string
          p_last_name: string
          p_phone: string
          p_user_id: string
        }
        Returns: string
      }
      find_service_area_by_location: {
        Args: { p_lat: number; p_lng: number }
        Returns: string
      }
      force_driver_offline: {
        Args: { p_driver_id: string; p_reason?: string }
        Returns: undefined
      }
      generate_invoice_number: { Args: never; Returns: string }
      generate_lost_property_case_number: {
        Args: { p_service_area_id: string }
        Returns: string
      }
      get_active_stop_waiting: { Args: { p_driver_id: string }; Returns: Json }
      get_corporate_allowed_payment_methods: {
        Args: { p_account_id: string }
        Returns: string[]
      }
      get_customer_lifecycle_debt_pence: {
        Args: { p_customer_id: string }
        Returns: number
      }
      get_customer_live_for_driver: {
        Args: { p_driver_lat: number; p_driver_lng: number; p_trip_id: string }
        Returns: {
          accuracy: number
          heading: number
          latitude: number
          longitude: number
          speed: number
          updated_at: string
        }[]
      }
      get_customer_trip_stats: {
        Args: { _passenger_id: string }
        Returns: {
          avg_rating: number
          rating_count: number
          total_trips: number
        }[]
      }
      get_dispatch_metrics: {
        Args: {
          p_driver_id?: string
          p_end: string
          p_region_id?: string
          p_service_area_id?: string
          p_start: string
        }
        Returns: Json
      }
      get_dispatch_settings: {
        Args: { p_service_area_id: string }
        Returns: {
          accept_timeout_seconds: number
          auto_reassign_enabled: boolean
          auto_retry_attempts: number
          batch_mode: string
          block_multiple_active_rides: boolean
          cancel_protection: boolean
          cancellation_fee_after_grace_pence: number
          cascade_batch_size: number
          cascade_step_delay_seconds: number
          cooldown_after_reject_seconds: number
          created_at: string
          customer_response_timeout_seconds: number
          distance_penalty_per_km: number
          driver_fare_display: string
          driver_final_response_timeout_seconds: number
          enable_logging: boolean
          enable_stop_waiting_charge: boolean
          fairness_boost_score: number
          fairness_idle_minutes: number
          fare_negotiation_enabled: boolean
          global_timeout_minutes: number
          id: string
          instant_retry_enabled: boolean
          late_cancel_enabled: boolean
          late_cancel_fee_pence: number
          late_cancel_threshold_minutes: number
          manual_emergency_dispatch_only: boolean
          max_advance_days: number
          max_cancel_rate: number
          max_concurrent_offers_per_driver: number
          max_driver_find_time_minutes: number
          max_offer_hops: number
          max_offers_per_request: number
          max_stacked_rides: number
          max_waiting_bonus_minutes: number
          min_advance_time_minutes: number
          minimum_rating: number
          no_show_charge_pence: number
          offer_expiry_seconds: number
          pickup_paid_waiting_enabled: boolean
          pickup_paid_waiting_rate_pence_per_minute: number
          pickup_radius_enabled: boolean
          pickup_radius_meters: number
          pickup_waiting_grace_period_seconds: number
          pickup_waiting_max_minutes: number | null
          priority_order: string
          scheduled_ride_incentives_enabled: boolean
          scheduled_rides_enabled: boolean
          search_radius_expand_km: number
          search_radius_max_km: number
          search_radius_meters: number
          search_radius_start_km: number
          service_area_id: string | null
          shortlist_limit: number
          simulate_mode: boolean
          stacked_allow_rider_opt_out: boolean
          stacked_driver_incentive: number
          stacked_max_detour_minutes: number
          stacked_min_trip_distance_km: number
          stacked_offer_layout: string
          stacked_offer_window_minutes: number
          stacked_priority_mode: string
          stacked_rider_discount: number
          stacked_rides_enabled: boolean
          stacked_search_radius_meters: number
          stacked_show_eta_to_driver: boolean
          stop_radius_enabled: boolean
          stop_radius_meters: number
          stop_waiting_charge_interval_seconds: number
          stop_waiting_grace_period_seconds: number
          stop_waiting_max_minutes: number | null
          stop_waiting_rate_pence_per_minute: number
          suppress_recent_offers_seconds: number
          updated_at: string
          waiting_bonus_per_minute: number
          waiting_time_grace_period_minutes: number
          wave1_offer_expiry_seconds: number
          wave1_size: number
          wave2_offer_expiry_seconds: number
          wave2_size: number
          wave3_offer_expiry_seconds: number
          wave3_size: number
        }
        SetofOptions: {
          from: "*"
          to: "dispatch_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      get_driver_document_eligibility: {
        Args: { p_driver_id: string }
        Returns: Json
      }
      get_driver_feedback_analytics: {
        Args: { p_driver_id: string }
        Returns: Json
      }
      get_driver_ledger_aggregates: {
        Args: { p_driver_id: string }
        Returns: {
          entry_type: string
          total_pence: number
        }[]
      }
      get_driver_own_profile_contact: {
        Args: { p_driver_id?: string }
        Returns: Json
      }
      get_driver_pending_ride_offers: { Args: never; Returns: Json }
      get_driver_standards: {
        Args: { p_driver_id: string; p_period_days?: number }
        Returns: Json
      }
      get_driver_wallet_balance: {
        Args: { p_driver_id: string }
        Returns: {
          available_pence: number
          can_early_cashout: boolean
          can_payout: boolean
        }[]
      }
      get_marketplace_delivery_config: {
        Args: { p_service_area_id: string }
        Returns: Json
      }
      get_p95_action_metrics: {
        Args: {
          p_app_name: string
          p_flow_type?: string
          p_group_by?: string
          p_hours?: number
        }
        Returns: {
          action_name: string
          event_count: number
          failure_count: number
          flow_type: string
          latest_at: string
          p50_ms: number
          p95_ms: number
          p99_ms: number
          platform: string
          regression_count: number
          timeout_count: number
          warning_count: number
        }[]
      }
      get_p95_screen_metrics: {
        Args: { p_app_name: string; p_metric_name: string }
        Returns: {
          event_count: number
          latest_at: string
          p95_ms: number
          screen_name: string
        }[]
      }
      get_performance_baseline_verdicts: {
        Args: { p_app_name?: string }
        Returns: {
          action_name: string
          after_at: string
          after_failure_count: number
          after_notes: string
          after_p50_ms: number
          after_p95_ms: number
          after_p99_ms: number
          after_timeout_count: number
          after_verdict: string
          app_name: string
          before_at: string
          before_failure_count: number
          before_notes: string
          before_p50_ms: number
          before_p95_ms: number
          before_p99_ms: number
          before_timeout_count: number
          before_verdict: string
          final_verdict: string
          improvement_pct: number
          platform: string
          target_ms: number
        }[]
      }
      get_performance_p95: {
        Args: { p_app_name?: string; p_hours?: number }
        Returns: {
          avg_ms: number
          critical_threshold: number
          health_status: string
          max_ms: number
          min_ms: number
          p95_ms: number
          screen_name: string
          total_events: number
          warning_threshold: number
        }[]
      }
      get_region_code: { Args: { p_region_id: string }; Returns: string }
      get_scan_go_driver_public_lookup: {
        Args: { p_driver_id: string; p_service_area_id?: string }
        Returns: Json
      }
      get_service_area_code: {
        Args: { p_service_area_id: string }
        Returns: string
      }
      get_staff_role_prefix: {
        Args: { p_role: Database["public"]["Enums"]["staff_role"] }
        Returns: string
      }
      get_user_corporate_accounts: {
        Args: { p_user_id: string }
        Returns: string[]
      }
      has_corporate_access: {
        Args: { p_corporate_account_id: string; p_user_id: string }
        Returns: boolean
      }
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
      insert_payout_ledger_debit_if_missing: {
        Args: {
          p_amount_pence: number
          p_currency: string
          p_description: string
          p_driver_id: string
          p_ledger_type: string
          p_paid_at?: string
          p_stripe_payout_id: string
          p_stripe_transfer_id: string
        }
        Returns: string
      }
      is_active_driver_cancel_rematch_row: {
        Args: { p_trip: Database["public"]["Tables"]["trips"]["Row"] }
        Returns: boolean
      }
      is_admin: { Args: never; Returns: boolean }
      is_customer: { Args: { _user_id: string }; Returns: boolean }
      is_driver: { Args: { _user_id: string }; Returns: boolean }
      is_driver_dispatchable: {
        Args: {
          p_driver_id: string
          p_max_heartbeat_age_seconds?: number
          p_max_location_age_seconds?: number
          p_require_push_token?: boolean
        }
        Returns: boolean
      }
      is_email_pending_active: {
        Args: {
          p_expires_at: string
          p_pending_email: string
          p_requested_at: string
          p_verified_at: string
        }
        Returns: boolean
      }
      is_explicit_offline_reason: {
        Args: { p_reason: string }
        Returns: boolean
      }
      is_future_scheduled_reservation_trip: {
        Args: {
          p_offer?: Database["public"]["Tables"]["ride_offers"]["Row"]
          p_trip: Database["public"]["Tables"]["trips"]["Row"]
        }
        Returns: boolean
      }
      is_phone_pending_active: {
        Args: {
          p_expires_at: string
          p_pending_phone: string
          p_requested_at: string
          p_verified_at: string
        }
        Returns: boolean
      }
      is_stale_unverified_email_identity: {
        Args: {
          p_auth_email: string
          p_auth_email_confirmed_at: string
          p_identity_email: string
          p_user_id: string
        }
        Returns: boolean
      }
      is_stale_unverified_phone_identity: {
        Args: {
          p_auth_phone: string
          p_auth_phone_confirmed_at: string
          p_identity_phone: string
          p_user_id: string
        }
        Returns: boolean
      }
      is_trip_active_dispatch_status: {
        Args: { p_dispatch: string }
        Returns: boolean
      }
      is_trip_commitment_monitoring_active: {
        Args: { p_trip_id: string }
        Returns: boolean
      }
      is_trip_terminal_cancel_status: {
        Args: { p_status: string }
        Returns: boolean
      }
      is_user_suspended: {
        Args: { p_user_id: string; p_user_type: string }
        Returns: boolean
      }
      list_driver_trip_history: { Args: { p_limit?: number }; Returns: Json }
      lock_driver_vehicle: { Args: { p_driver_id: string }; Returns: undefined }
      log_audit_event: {
        Args: {
          p_details?: Json
          p_driver_id?: string
          p_event_type: string
          p_ip_address?: string
          p_trip_id?: string
          p_user_agent?: string
          p_user_id?: string
        }
        Returns: string
      }
      log_corporate_audit: {
        Args: {
          p_action: string
          p_action_type: string
          p_corporate_account_id: string
          p_metadata?: Json
          p_target_id?: string
          p_target_name?: string
          p_target_type?: string
        }
        Returns: string
      }
      log_dispatch_eligibility: {
        Args: {
          p_context?: Json
          p_driver_id: string
          p_is_eligible: boolean
          p_reject_reason: string
          p_trip_id: string
        }
        Returns: undefined
      }
      log_dispatch_event: {
        Args: {
          p_details?: Json
          p_driver_id?: string
          p_event_type: string
          p_round?: number
          p_trip_id: string
        }
        Returns: undefined
      }
      lost_property_admin_unread_count: { Args: never; Returns: number }
      lost_property_expire_chats: { Args: never; Returns: number }
      lost_property_get_cases_for_photo_cleanup: {
        Args: never
        Returns: {
          case_id: string
          customer_photos: string[]
          found_item_photos: string[]
        }[]
      }
      mark_account_email_verified: {
        Args: { _app_type: string; _user_id: string }
        Returns: undefined
      }
      mark_driver_background_unavailable: {
        Args: { p_driver_id: string }
        Returns: undefined
      }
      maybe_advance_dispatch_after_offer_resolution: {
        Args: { p_resolved_driver_id?: string; p_trip_id: string }
        Returns: undefined
      }
      merge_ride_offer_push_log: {
        Args: { p_json: Json; p_offer_id: string }
        Returns: undefined
      }
      next_trip_invoice_number: { Args: never; Returns: string }
      normalize_driver_offline_reason: {
        Args: { p_reason: string }
        Returns: string
      }
      normalize_phone_digits: { Args: { p_phone: string }; Returns: string }
      notify_drivers_trip_cancelled: {
        Args: { p_reason: string; p_trip_id: string }
        Returns: undefined
      }
      ops_acknowledge_alert: {
        Args: { p_alert_id: string; p_user_id: string }
        Returns: undefined
      }
      ops_auto_resolve_stale_alerts: {
        Args: { max_age_hours?: number }
        Returns: Json
      }
      ops_cleanup_old_data: { Args: never; Returns: Json }
      ops_detect_5xx_spikes: { Args: never; Returns: number }
      ops_detect_admin_panel_issues: { Args: never; Returns: Json }
      ops_detect_api_latency_spikes: { Args: never; Returns: Json }
      ops_detect_commission_gaps: { Args: never; Returns: Json }
      ops_detect_contradictory_trip_state: { Args: never; Returns: Json }
      ops_detect_corporate_booking_issues: { Args: never; Returns: Json }
      ops_detect_corporate_web_issues: { Args: never; Returns: Json }
      ops_detect_customer_app_issues: { Args: never; Returns: Json }
      ops_detect_dispatch_timeout_exceeded: { Args: never; Returns: Json }
      ops_detect_driver_app_issues: { Args: never; Returns: Json }
      ops_detect_duplicate_bookings: { Args: never; Returns: Json }
      ops_detect_duplicate_commissions: { Args: never; Returns: number }
      ops_detect_duplicate_dispatch: { Args: never; Returns: Json }
      ops_detect_duplicate_dispatches: { Args: never; Returns: number }
      ops_detect_duplicate_earnings: { Args: never; Returns: number }
      ops_detect_duplicate_payments: { Args: never; Returns: Json }
      ops_detect_duplicate_payouts: { Args: never; Returns: Json }
      ops_detect_earning_gaps: { Args: never; Returns: Json }
      ops_detect_edge_function_failures: { Args: never; Returns: number }
      ops_detect_error_spikes: { Args: never; Returns: number }
      ops_detect_failed_payments: { Args: never; Returns: number }
      ops_detect_failed_payouts: { Args: never; Returns: number }
      ops_detect_fatal_logs: { Args: never; Returns: number }
      ops_detect_guest_booking_failures: { Args: never; Returns: Json }
      ops_detect_guest_booking_not_confirmed: { Args: never; Returns: number }
      ops_detect_guest_checkout_failures: { Args: never; Returns: number }
      ops_detect_guest_dropoffs: { Args: never; Returns: number }
      ops_detect_guest_latency: { Args: never; Returns: number }
      ops_detect_guest_quote_failures: { Args: never; Returns: number }
      ops_detect_latency_spikes: { Args: never; Returns: number }
      ops_detect_log_anomalies: { Args: never; Returns: Json }
      ops_detect_missing_commissions: { Args: never; Returns: number }
      ops_detect_missing_earnings: { Args: never; Returns: number }
      ops_detect_money_screen_delays: { Args: never; Returns: Json }
      ops_detect_notification_failures: { Args: never; Returns: Json }
      ops_detect_offer_presets_missing: { Args: never; Returns: Json }
      ops_detect_payment_gaps: { Args: never; Returns: Json }
      ops_detect_payout_failures: { Args: never; Returns: Json }
      ops_detect_rematch_assignment_failed: { Args: never; Returns: Json }
      ops_detect_repeated_guest_submissions: { Args: never; Returns: number }
      ops_detect_repeated_webhooks: { Args: never; Returns: number }
      ops_detect_slow_screens: { Args: never; Returns: Json }
      ops_detect_stuck_dispatch: { Args: never; Returns: Json }
      ops_detect_version_issues: { Args: never; Returns: Json }
      ops_detect_webhook_failures: { Args: never; Returns: number }
      ops_detect_workflow_event_spikes: { Args: never; Returns: Json }
      ops_ingest_workflow_event: {
        Args: {
          p_app_name: string
          p_app_version?: string
          p_create_alert?: boolean
          p_customer_id?: string
          p_device_model?: string
          p_driver_id?: string
          p_duration_ms?: number
          p_error_code?: string
          p_event_type: string
          p_message?: string
          p_metadata?: Json
          p_os_version?: string
          p_platform?: string
          p_session_id?: string
          p_severity?: string
          p_trip_id?: string
        }
        Returns: string
      }
      ops_reconciliation_diagnostics: { Args: never; Returns: Json }
      ops_record_event: {
        Args: {
          p_amount_pence?: number
          p_app?: string
          p_category: string
          p_create_alert?: boolean
          p_currency_code?: string
          p_customer_id?: string
          p_description?: string
          p_driver_id?: string
          p_event_type: string
          p_metadata?: Json
          p_payment_id?: string
          p_payout_batch_id?: string
          p_service_area_id?: string
          p_severity?: string
          p_trip_id?: string
        }
        Returns: string
      }
      ops_repair_missing_commission: {
        Args: { p_trip_id: string }
        Returns: Json
      }
      ops_repair_missing_driver_earning: {
        Args: { p_trip_id: string }
        Returns: Json
      }
      ops_repair_missing_financials: {
        Args: { p_trip_id: string }
        Returns: Json
      }
      ops_replay_webhook: { Args: { p_event_id: string }; Returns: Json }
      ops_resolve_alert: {
        Args: { p_alert_id: string; p_user_id: string }
        Returns: undefined
      }
      ops_resolve_alert_if_cleared: {
        Args: { p_alert_id: string }
        Returns: Json
      }
      ops_retry_failed_dispatch: { Args: { p_trip_id: string }; Returns: Json }
      ops_retry_failed_payout: { Args: { p_payout_id: string }; Returns: Json }
      ops_retry_failed_payout_item: {
        Args: { p_payout_item_id: string }
        Returns: Json
      }
      ops_run_all_detections: { Args: never; Returns: Json }
      ops_suppress_alert: {
        Args: { p_alert_id: string; p_until: string }
        Returns: undefined
      }
      ops_upsert_alert: {
        Args: {
          p_app: string
          p_category: string
          p_description?: string
          p_fingerprint: string
          p_metadata?: Json
          p_related_driver_id?: string
          p_related_entity_id?: string
          p_related_entity_type?: string
          p_related_payment_id?: string
          p_related_payout_batch_id?: string
          p_related_trip_id?: string
          p_severity: string
          p_source: string
          p_title: string
        }
        Returns: string
      }
      ops_workflow_event_app: {
        Args: { p_event_type: string }
        Returns: string
      }
      ops_workflow_event_category: {
        Args: { p_event_type: string }
        Returns: string
      }
      passenger_map_nearby_drivers: {
        Args: {
          p_lat: number
          p_limit?: number
          p_lng: number
          p_radius_meters: number
          p_stale_seconds?: number
        }
        Returns: {
          distance_meters: number
          driver_id: string
          heading: number
          lat: number
          lng: number
          speed: number
          updated_at: string
        }[]
      }
      payout_batch_kind_to_ledger_type: {
        Args: { p_kind: string }
        Returns: string
      }
      phone_is_pending_reserved: {
        Args: { p_exclude_user_id?: string; p_phone_digits: string }
        Returns: boolean
      }
      phone_is_verified_protected: {
        Args: { p_exclude_user_id?: string; p_phone_digits: string }
        Returns: boolean
      }
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
      process_ride_offer_ack_timeouts: {
        Args: never
        Returns: {
          driver_id: string
          offer_id: string
          trip_id: string
        }[]
      }
      promote_stacked_trip: {
        Args: { p_completed_trip_id?: string; p_driver_id: string }
        Returns: Json
      }
      purge_dispatch_eligibility_log: { Args: never; Returns: number }
      raise_driver_alert: {
        Args: {
          p_alert_type: string
          p_booking_id?: string
          p_context?: Json
          p_driver_id: string
          p_message?: string
          p_severity?: Database["public"]["Enums"]["driver_alert_severity"]
        }
        Returns: {
          alert_type: string
          booking_id: string | null
          context: Json
          created_at: string
          driver_id: string
          first_detected_at: string
          id: string
          last_detected_at: string
          message: string
          resolved_at: string | null
          severity: Database["public"]["Enums"]["driver_alert_severity"]
          status: Database["public"]["Enums"]["driver_alert_status"]
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "driver_alerts"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reactivate_corporate_account: {
        Args: { p_account_id: string }
        Returns: undefined
      }
      recalculate_driver_display_rating: {
        Args: { p_driver_id: string }
        Returns: undefined
      }
      recalculate_driver_documents_approved: {
        Args: { p_driver_id: string }
        Returns: boolean
      }
      recalculate_driver_wallet: {
        Args: { p_driver_id: string }
        Returns: undefined
      }
      recalculate_drivers_compliance_london_daily: {
        Args: never
        Returns: number
      }
      reconcile_stale_online_drivers: {
        Args: never
        Returns: {
          driver_id: string
          heartbeat_age_seconds: number
        }[]
      }
      record_booking_delivery: {
        Args: {
          p_booking_id: string
          p_detail?: Json
          p_driver_id?: string
          p_offer_id?: string
          p_phase: string
          p_source?: string
        }
        Returns: undefined
      }
      record_cash_trip_completion:
        | {
            Args: {
              p_currency?: string
              p_driver_id: string
              p_trip_id: string
            }
            Returns: Json
          }
        | {
            Args: {
              p_commission_pence: number
              p_currency_code: string
              p_driver_id: string
              p_gross_fare_pence: number
              p_trip_id: string
            }
            Returns: string
          }
      record_dispatch_wave_snapshot: {
        Args: {
          p_dispatch_round: number
          p_driver_id?: string
          p_metadata?: Json
          p_ride_offer_id?: string
          p_source?: string
          p_stage: string
          p_trip_id: string
          p_wave_number?: number
        }
        Returns: undefined
      }
      record_driver_commitment_warning: {
        Args: {
          p_message: string
          p_session_id: string
          p_warning_type: string
        }
        Returns: undefined
      }
      record_push_send_result: {
        Args: {
          p_detail?: Json
          p_error_classification?: string
          p_error_code?: string
          p_success: boolean
          p_token: string
        }
        Returns: {
          app_type: string
          app_version: string | null
          created_at: string
          device_id: string | null
          driver_id: string
          failure_count: number
          id: string
          is_active: boolean
          last_failure_at: string | null
          last_failure_reason: string | null
          last_seen_at: string | null
          last_success_at: string | null
          platform: string
          token: string
          updated_at: string
          user_id: string | null
        }
        SetofOptions: {
          from: "*"
          to: "push_tokens"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      release_trip_negotiation_lock: {
        Args: { p_next_status?: string; p_trip_id: string }
        Returns: undefined
      }
      repair_user_stale_auth_identities: {
        Args: { _user_id: string }
        Returns: Json
      }
      reset_auth_user_email_unconfirmed: {
        Args: { _user_id: string }
        Returns: undefined
      }
      resolve_driver_alert: {
        Args: { p_alert_type: string; p_driver_id: string }
        Returns: number
      }
      resolve_driver_tier_category_priority: {
        Args: { p_driver_id: string; p_service_area_id: string }
        Returns: number
      }
      resolve_driver_tier_commission_percent: {
        Args: { p_driver_id: string; p_service_area_id: string }
        Returns: number
      }
      resolve_driver_tier_name: {
        Args: { p_driver_id: string }
        Returns: string
      }
      resolve_negotiation_rebroadcast_fare: {
        Args: { p_trip_id: string }
        Returns: Json
      }
      resolve_trip_service_area_from_pickup: {
        Args: {
          p_pickup_lat: number
          p_pickup_lng: number
          p_selected_service_area_id?: string
        }
        Returns: Json
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
      return_failed_payout_to_wallet: {
        Args: { p_payout_item_id: string }
        Returns: Json
      }
      ride_offer_build_send_notification_body: {
        Args: { p_offer_id: string }
        Returns: Json
      }
      ride_offer_dispatch_push_delivery: {
        Args: { p_offer_id: string; p_skip_notifications_insert?: boolean }
        Returns: undefined
      }
      ride_offer_enqueue_reminders: {
        Args: { p_offer_id: string }
        Returns: undefined
      }
      ride_offer_retry_unacked_push_deliveries: { Args: never; Returns: number }
      run_digital_finance_migration: { Args: never; Returns: Json }
      scan_go_vehicle_is_blocked: {
        Args: { p_status: string }
        Returns: boolean
      }
      scan_go_vehicle_is_bookable: {
        Args: { p_status: string }
        Returns: boolean
      }
      scan_go_vehicle_status_rank: {
        Args: { p_status: string }
        Returns: number
      }
      search_places: {
        Args: { p_limit?: number; p_service_area_id?: string; q: string }
        Returns: {
          address: string
          category: string
          display_name: string
          icon: string
          id: string
          latitude: number
          longitude: number
          name: string
          postcode: string
          score: number
          service_area_id: string
          tags: string[]
        }[]
      }
      snapshot_driver_tier_commission_on_trip: {
        Args: { p_driver_id: string; p_trip_id: string }
        Returns: number
      }
      stage_email_change: {
        Args: { _app_type: string; _new_email: string; _user_id: string }
        Returns: undefined
      }
      stage_phone_change: {
        Args: { _app_type: string; _new_phone: string; _user_id: string }
        Returns: undefined
      }
      start_driver_commitment_session: {
        Args: { p_driver_id?: string; p_trip_id: string }
        Returns: undefined
      }
      start_stop_waiting: {
        Args: {
          p_charge_interval_seconds?: number
          p_driver_id: string
          p_grace_period_seconds?: number
          p_rate_pence_per_minute?: number
          p_stop_id: string
          p_trip_id: string
        }
        Returns: string
      }
      stop_driver_commitment_session: {
        Args: { p_reason?: string; p_trip_id: string }
        Returns: undefined
      }
      stop_stop_waiting: { Args: { p_waiting_id: string }; Returns: Json }
      suspend_corporate_account: {
        Args: { p_account_id: string }
        Returns: undefined
      }
      suspend_corporate_request: {
        Args: { p_request_id: string; p_reviewed_by?: string }
        Returns: undefined
      }
      sweep_stale_searching_trips: { Args: never; Returns: Json }
      sync_customer_phone_verification: {
        Args: { _user_id: string }
        Returns: undefined
      }
      sync_driver_phone_verification: {
        Args: { _user_id: string }
        Returns: undefined
      }
      sync_payout_item_ledger_debit: {
        Args: { p_payout_item_id: string }
        Returns: Json
      }
      sync_staff_user_role: {
        Args: { _action: string; _target_user_id: string }
        Returns: undefined
      }
      tick_stop_waiting: { Args: { p_waiting_id: string }; Returns: Json }
      timeout_scheduled_offer: {
        Args: { p_driver_id: string; p_trip_id: string }
        Returns: Json
      }
      trip_negotiation_base_fare_pence: {
        Args: { p_trip: Database["public"]["Tables"]["trips"]["Row"] }
        Returns: number
      }
      trip_pickup_coordinates_valid: {
        Args: { p_lat: number; p_lng: number }
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
      upsert_customer_live_location: {
        Args: {
          p_accuracy?: number
          p_heading?: number
          p_latitude: number
          p_longitude: number
          p_speed?: number
          p_trip_id: string
          p_updated_at?: string
        }
        Returns: undefined
      }
      upsert_driver_live_location: {
        Args: {
          p_driver_id: string
          p_geohash6: string
          p_heading?: number
          p_lat: number
          p_lng: number
          p_speed?: number
        }
        Returns: undefined
      }
      upsert_driver_presence: {
        Args: {
          p_accuracy?: number
          p_app_state?: string
          p_battery_level?: number
          p_device_id?: string
          p_driver_id: string
          p_heading?: number
          p_lat?: number
          p_lng?: number
          p_network_type?: string
          p_offline_reason?: string
          p_platform?: string
          p_push_token?: string
          p_socket_connected?: boolean
          p_speed?: number
          p_status?: string
          p_unresolved_critical_tracking?: boolean
        }
        Returns: {
          accuracy_m: number | null
          app_state: string
          battery_level: number | null
          created_at: string
          driver_id: string
          heading: number | null
          last_heartbeat_at: string
          last_location_at: string | null
          last_offline_at: string | null
          last_realtime_seen_at: string | null
          last_significant_move_at: string | null
          last_significant_move_lat: number | null
          last_significant_move_lng: number | null
          last_socket_pong_at: string | null
          lat: number | null
          lng: number | null
          low_accuracy: boolean
          low_accuracy_since: string | null
          network_type: string | null
          offline_reason: string | null
          platform: string | null
          presence_health: string
          push_token: string | null
          socket_connected: boolean | null
          speed: number | null
          status: string
          unresolved_critical_tracking: boolean
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "driver_presence"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      upsert_pending_customer_signup: {
        Args: {
          p_email: string
          p_first_name: string
          p_last_name: string
          p_phone: string
          p_signup_source?: string
          p_user_id: string
        }
        Returns: string
      }
      validate_driver_offer: {
        Args: { p_driver_id: string; p_offer_id: string }
        Returns: Json
      }
      verify_active_device: {
        Args: { p_device_id: string }
        Returns: {
          active_device_id: string
          is_active: boolean
        }[]
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user" | "driver" | "customer"
      app_scope: "customer" | "driver" | "corporate" | "shared" | "legal"
      app_user_role: "admin" | "driver" | "customer" | "corporate"
      communication_default_method: "voip" | "call_masking"
      content_status: "draft" | "published"
      driver_alert_severity: "warning" | "critical" | "recovered"
      driver_alert_status: "active" | "resolved"
      driver_status: "active" | "disabled" | "deleted"
      merchant_category: "food" | "grocery" | "retail" | "pharmacy" | "parcel"
      merchant_image_source: "uploaded" | "ai_generated"
      merchant_status:
        | "pending"
        | "approved"
        | "rejected"
        | "suspended"
        | "closed"
        | "disabled"
      offer_redemption_status: "reserved" | "applied" | "reversed"
      offer_status: "draft" | "active" | "archived"
      offer_type: "percent_discount" | "fixed_amount_discount"
      payment_coverage_status:
        | "not_required"
        | "pending_authorization"
        | "authorized"
        | "authorization_insufficient"
        | "top_up_pending"
        | "fully_covered"
        | "capture_pending"
        | "captured"
        | "under_captured"
        | "capture_failed"
      staff_role:
        | "super_admin"
        | "admin"
        | "operator"
        | "finance_manager"
        | "customer_support"
        | "compliance_officer"
      staff_shift_length_preset: "8h" | "10h" | "12h" | "night_12h" | "custom"
      staff_shift_type: "day" | "late" | "night" | "morning" | "off"
      staff_work_pattern_type: "fixed_weekly" | "rotating" | "custom"
      trip_change_status:
        | "pending_driver_approval"
        | "approved"
        | "rejected"
        | "expired"
        | "cancelled"
      trip_change_type:
        | "add_stop"
        | "remove_stop"
        | "reorder_stops"
        | "change_dropoff"
      trip_payment_state:
        | "draft"
        | "pending_payment_method"
        | "payment_authorizing"
        | "payment_failed"
        | "payment_authorized"
        | "booking_created"
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
      app_role: ["admin", "moderator", "user", "driver", "customer"],
      app_scope: ["customer", "driver", "corporate", "shared", "legal"],
      app_user_role: ["admin", "driver", "customer", "corporate"],
      communication_default_method: ["voip", "call_masking"],
      content_status: ["draft", "published"],
      driver_alert_severity: ["warning", "critical", "recovered"],
      driver_alert_status: ["active", "resolved"],
      driver_status: ["active", "disabled", "deleted"],
      merchant_category: ["food", "grocery", "retail", "pharmacy", "parcel"],
      merchant_image_source: ["uploaded", "ai_generated"],
      merchant_status: [
        "pending",
        "approved",
        "rejected",
        "suspended",
        "closed",
        "disabled",
      ],
      offer_redemption_status: ["reserved", "applied", "reversed"],
      offer_status: ["draft", "active", "archived"],
      offer_type: ["percent_discount", "fixed_amount_discount"],
      payment_coverage_status: [
        "not_required",
        "pending_authorization",
        "authorized",
        "authorization_insufficient",
        "top_up_pending",
        "fully_covered",
        "capture_pending",
        "captured",
        "under_captured",
        "capture_failed",
      ],
      staff_role: [
        "super_admin",
        "admin",
        "operator",
        "finance_manager",
        "customer_support",
        "compliance_officer",
      ],
      staff_shift_length_preset: ["8h", "10h", "12h", "night_12h", "custom"],
      staff_shift_type: ["day", "late", "night", "morning", "off"],
      staff_work_pattern_type: ["fixed_weekly", "rotating", "custom"],
      trip_change_status: [
        "pending_driver_approval",
        "approved",
        "rejected",
        "expired",
        "cancelled",
      ],
      trip_change_type: [
        "add_stop",
        "remove_stop",
        "reorder_stops",
        "change_dropoff",
      ],
      trip_payment_state: [
        "draft",
        "pending_payment_method",
        "payment_authorizing",
        "payment_failed",
        "payment_authorized",
        "booking_created",
      ],
    },
  },
} as const
