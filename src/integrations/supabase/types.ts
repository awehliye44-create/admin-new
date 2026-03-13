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
          created_by: string
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
          created_by: string
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
          created_by?: string
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
          sender_id: string
          sender_type: string
          ticket_id: string
        }
        Insert: {
          attachments?: string[] | null
          created_at?: string | null
          id?: string
          message: string
          sender_id: string
          sender_type: string
          ticket_id: string
        }
        Update: {
          attachments?: string[] | null
          created_at?: string | null
          id?: string
          message?: string
          sender_id?: string
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
            referencedRelation: "customers"
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
          stripe_customer_id: string | null
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
          stripe_customer_id?: string | null
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
          stripe_customer_id?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
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
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
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
          customer_response_timeout_seconds: number
          distance_penalty_per_km: number
          driver_fare_display: string
          driver_final_response_timeout_seconds: number
          enable_logging: boolean
          fairness_boost_score: number
          fairness_idle_minutes: number
          fare_max_increase_pence: number
          fare_negotiation_enabled: boolean
          fare_offer_increment_1_pence: number
          fare_offer_increment_2_pence: number
          fare_offer_increment_3_pence: number
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
          max_waiting_bonus_minutes: number
          min_advance_time_minutes: number
          minimum_rating: number
          offer_expiry_seconds: number
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
          stacked_offer_window_minutes: number
          stacked_priority_mode: string
          stacked_rider_discount: number
          stacked_rides_enabled: boolean
          stacked_search_radius_meters: number
          stacked_show_eta_to_driver: boolean
          suppress_recent_offers_seconds: number
          updated_at: string
          waiting_bonus_per_minute: number
          waiting_time_grace_period_minutes: number
          wave1_size: number
          wave2_size: number
          wave3_size: number
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
          customer_response_timeout_seconds?: number
          distance_penalty_per_km?: number
          driver_fare_display?: string
          driver_final_response_timeout_seconds?: number
          enable_logging?: boolean
          fairness_boost_score?: number
          fairness_idle_minutes?: number
          fare_max_increase_pence?: number
          fare_negotiation_enabled?: boolean
          fare_offer_increment_1_pence?: number
          fare_offer_increment_2_pence?: number
          fare_offer_increment_3_pence?: number
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
          max_waiting_bonus_minutes?: number
          min_advance_time_minutes?: number
          minimum_rating?: number
          offer_expiry_seconds?: number
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
          stacked_offer_window_minutes?: number
          stacked_priority_mode?: string
          stacked_rider_discount?: number
          stacked_rides_enabled?: boolean
          stacked_search_radius_meters?: number
          stacked_show_eta_to_driver?: boolean
          suppress_recent_offers_seconds?: number
          updated_at?: string
          waiting_bonus_per_minute?: number
          waiting_time_grace_period_minutes?: number
          wave1_size?: number
          wave2_size?: number
          wave3_size?: number
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
          customer_response_timeout_seconds?: number
          distance_penalty_per_km?: number
          driver_fare_display?: string
          driver_final_response_timeout_seconds?: number
          enable_logging?: boolean
          fairness_boost_score?: number
          fairness_idle_minutes?: number
          fare_max_increase_pence?: number
          fare_negotiation_enabled?: boolean
          fare_offer_increment_1_pence?: number
          fare_offer_increment_2_pence?: number
          fare_offer_increment_3_pence?: number
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
          max_waiting_bonus_minutes?: number
          min_advance_time_minutes?: number
          minimum_rating?: number
          offer_expiry_seconds?: number
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
          stacked_offer_window_minutes?: number
          stacked_priority_mode?: string
          stacked_rider_discount?: number
          stacked_rides_enabled?: boolean
          stacked_search_radius_meters?: number
          stacked_show_eta_to_driver?: boolean
          suppress_recent_offers_seconds?: number
          updated_at?: string
          waiting_bonus_per_minute?: number
          waiting_time_grace_period_minutes?: number
          wave1_size?: number
          wave2_size?: number
          wave3_size?: number
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
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
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
      driver_presence: {
        Row: {
          app_state: string
          created_at: string
          driver_id: string
          heading: number | null
          last_heartbeat_at: string
          last_location_at: string | null
          lat: number | null
          lng: number | null
          platform: string | null
          push_token: string | null
          speed: number | null
          status: string
          updated_at: string
        }
        Insert: {
          app_state?: string
          created_at?: string
          driver_id: string
          heading?: number | null
          last_heartbeat_at?: string
          last_location_at?: string | null
          lat?: number | null
          lng?: number | null
          platform?: string | null
          push_token?: string | null
          speed?: number | null
          status?: string
          updated_at?: string
        }
        Update: {
          app_state?: string
          created_at?: string
          driver_id?: string
          heading?: number | null
          last_heartbeat_at?: string
          last_location_at?: string | null
          lat?: number | null
          lng?: number | null
          platform?: string | null
          push_token?: string | null
          speed?: number | null
          status?: string
          updated_at?: string
        }
        Relationships: [
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
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
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
          auto_accept?: boolean
          created_at?: string
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
          auto_accept?: boolean
          created_at?: string
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
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
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
      driver_wallet_ledger: {
        Row: {
          amount_pence: number
          created_at: string
          currency: string
          description: string | null
          driver_id: string
          id: string
          related_trip_id: string | null
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
          stripe_payout_id?: string | null
          stripe_transfer_id?: string | null
          type?: string
        }
        Relationships: [
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
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
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
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
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
          category_id: string | null
          charges_enabled: boolean | null
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
          last_offer_at: string | null
          last_trip_end_at: string | null
          onboarding_complete: boolean | null
          online_since: string | null
          payouts_enabled: boolean | null
          phone: string
          profile_photo_url: string | null
          rating: number | null
          region_id: string
          speed: number | null
          stripe_account_id: string | null
          total_trips: number | null
          updated_at: string
          user_id: string
          vehicle_edit_request_status: string | null
          vehicle_locked: boolean
        }
        Insert: {
          approval_status?: string
          category_id?: string | null
          charges_enabled?: boolean | null
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
          last_offer_at?: string | null
          last_trip_end_at?: string | null
          onboarding_complete?: boolean | null
          online_since?: string | null
          payouts_enabled?: boolean | null
          phone: string
          profile_photo_url?: string | null
          rating?: number | null
          region_id: string
          speed?: number | null
          stripe_account_id?: string | null
          total_trips?: number | null
          updated_at?: string
          user_id: string
          vehicle_edit_request_status?: string | null
          vehicle_locked?: boolean
        }
        Update: {
          approval_status?: string
          category_id?: string | null
          charges_enabled?: boolean | null
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
          last_offer_at?: string | null
          last_trip_end_at?: string | null
          onboarding_complete?: boolean | null
          online_since?: string | null
          payouts_enabled?: boolean | null
          phone?: string
          profile_photo_url?: string | null
          rating?: number | null
          region_id?: string
          speed?: number | null
          stripe_account_id?: string | null
          total_trips?: number | null
          updated_at?: string
          user_id?: string
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
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
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
            referencedRelation: "customers"
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
      payments: {
        Row: {
          amount_pence: number
          capture_method: string | null
          created_at: string
          currency: string
          id: string
          last_error: string | null
          metadata: Json | null
          status: string
          stripe_payment_intent_id: string
          trip_id: string
          updated_at: string
        }
        Insert: {
          amount_pence: number
          capture_method?: string | null
          created_at?: string
          currency?: string
          id?: string
          last_error?: string | null
          metadata?: Json | null
          status?: string
          stripe_payment_intent_id: string
          trip_id: string
          updated_at?: string
        }
        Update: {
          amount_pence?: number
          capture_method?: string | null
          created_at?: string
          currency?: string
          id?: string
          last_error?: string | null
          metadata?: Json | null
          status?: string
          stripe_payment_intent_id?: string
          trip_id?: string
          updated_at?: string
        }
        Relationships: [
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
      payout_batches: {
        Row: {
          completed_at: string | null
          created_at: string
          created_by: string | null
          failed_payouts: number | null
          id: string
          kind: string
          notes: string | null
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
          failed_payouts?: number | null
          id?: string
          kind: string
          notes?: string | null
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
          failed_payouts?: number | null
          id?: string
          kind?: string
          notes?: string | null
          run_date?: string
          status?: string
          successful_payouts?: number | null
          total_amount_pence?: number | null
          total_drivers?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      payout_items: {
        Row: {
          amount_pence: number
          batch_id: string | null
          completed_at: string | null
          created_at: string
          driver_id: string
          error_message: string | null
          id: string
          ledger_entry_id: string | null
          status: string
          stripe_payout_id: string | null
          stripe_transfer_id: string | null
          updated_at: string
        }
        Insert: {
          amount_pence: number
          batch_id?: string | null
          completed_at?: string | null
          created_at?: string
          driver_id: string
          error_message?: string | null
          id?: string
          ledger_entry_id?: string | null
          status?: string
          stripe_payout_id?: string | null
          stripe_transfer_id?: string | null
          updated_at?: string
        }
        Update: {
          amount_pence?: number
          batch_id?: string | null
          completed_at?: string | null
          created_at?: string
          driver_id?: string
          error_message?: string | null
          id?: string
          ledger_entry_id?: string | null
          status?: string
          stripe_payout_id?: string | null
          stripe_transfer_id?: string | null
          updated_at?: string
        }
        Relationships: [
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
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
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
            referencedRelation: "driver_ledger"
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
          counter_fare: number | null
          created_at: string
          customer_counter_fare: number | null
          customer_respond_by: string | null
          decline_reason: string | null
          distance_meters: number | null
          driver_id: string
          driver_offer_fare: number | null
          driver_respond_by: string | null
          eta_seconds: number | null
          expires_at: string
          grace_window_expires_at: string | null
          id: string
          is_stacked: boolean
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
          broadcast_round?: number
          counter_fare?: number | null
          created_at?: string
          customer_counter_fare?: number | null
          customer_respond_by?: string | null
          decline_reason?: string | null
          distance_meters?: number | null
          driver_id: string
          driver_offer_fare?: number | null
          driver_respond_by?: string | null
          eta_seconds?: number | null
          expires_at: string
          grace_window_expires_at?: string | null
          id?: string
          is_stacked?: boolean
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
          broadcast_round?: number
          counter_fare?: number | null
          created_at?: string
          customer_counter_fare?: number | null
          customer_respond_by?: string | null
          decline_reason?: string | null
          distance_meters?: number | null
          driver_id?: string
          driver_offer_fare?: number | null
          driver_respond_by?: string | null
          eta_seconds?: number | null
          expires_at?: string
          grace_window_expires_at?: string | null
          id?: string
          is_stacked?: boolean
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
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
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
          offer_settings: Json
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
          offer_settings?: Json
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
          offer_settings?: Json
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
          center_lat: number | null
          center_lng: number | null
          code: string | null
          country: string | null
          created_at: string
          currency_code: string | null
          distance_unit: string | null
          geo_boundary: Json | null
          id: string
          is_active: boolean
          name: string
          per_booking_fee_enabled: boolean
          per_booking_fee_pence: number
          pickup_waiting_charges: Json | null
          region_id: string
          stops_waiting_charges: Json | null
          timezone: string | null
          updated_at: string
        }
        Insert: {
          center_lat?: number | null
          center_lng?: number | null
          code?: string | null
          country?: string | null
          created_at?: string
          currency_code?: string | null
          distance_unit?: string | null
          geo_boundary?: Json | null
          id?: string
          is_active?: boolean
          name: string
          per_booking_fee_enabled?: boolean
          per_booking_fee_pence?: number
          pickup_waiting_charges?: Json | null
          region_id: string
          stops_waiting_charges?: Json | null
          timezone?: string | null
          updated_at?: string
        }
        Update: {
          center_lat?: number | null
          center_lng?: number | null
          code?: string | null
          country?: string | null
          created_at?: string
          currency_code?: string | null
          distance_unit?: string | null
          geo_boundary?: Json | null
          id?: string
          is_active?: boolean
          name?: string
          per_booking_fee_enabled?: boolean
          per_booking_fee_pence?: number
          pickup_waiting_charges?: Json | null
          region_id?: string
          stops_waiting_charges?: Json | null
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
      staff_profiles: {
        Row: {
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
        Relationships: []
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
            referencedRelation: "customers"
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
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
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
          new_distance_meters: number | null
          new_duration_seconds: number | null
          new_fare_pence: number | null
          original_distance_meters: number | null
          original_duration_seconds: number | null
          original_fare_pence: number | null
          rejection_reason: string | null
          requested_by: string
          requester_id: string | null
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
          new_distance_meters?: number | null
          new_duration_seconds?: number | null
          new_fare_pence?: number | null
          original_distance_meters?: number | null
          original_duration_seconds?: number | null
          original_fare_pence?: number | null
          rejection_reason?: string | null
          requested_by?: string
          requester_id?: string | null
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
          new_distance_meters?: number | null
          new_duration_seconds?: number | null
          new_fare_pence?: number | null
          original_distance_meters?: number | null
          original_duration_seconds?: number | null
          original_fare_pence?: number | null
          rejection_reason?: string | null
          requested_by?: string
          requester_id?: string | null
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
      trip_finance: {
        Row: {
          base_fare_pence: number
          cash_commission_ledger_id: string | null
          commission_rate_pct: number
          commissionable_subtotal_pence: number
          created_at: string
          currency_code: string
          debt_recovery_pence: number | null
          destination_change_charge_pence: number
          driver_id: string
          driver_net_before_tip_pence: number
          driver_total_earnings_pence: number
          extras_charge_pence: number
          final_driver_payout_pence: number | null
          final_trip_total_pence: number
          id: string
          payment_method: string
          pickup_waiting_charge_pence: number
          platform_commission_pence: number
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
          commissionable_subtotal_pence?: number
          created_at?: string
          currency_code?: string
          debt_recovery_pence?: number | null
          destination_change_charge_pence?: number
          driver_id: string
          driver_net_before_tip_pence?: number
          driver_total_earnings_pence?: number
          extras_charge_pence?: number
          final_driver_payout_pence?: number | null
          final_trip_total_pence?: number
          id?: string
          payment_method?: string
          pickup_waiting_charge_pence?: number
          platform_commission_pence?: number
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
          commissionable_subtotal_pence?: number
          created_at?: string
          currency_code?: string
          debt_recovery_pence?: number | null
          destination_change_charge_pence?: number
          driver_id?: string
          driver_net_before_tip_pence?: number
          driver_total_earnings_pence?: number
          extras_charge_pence?: number
          final_driver_payout_pence?: number | null
          final_trip_total_pence?: number
          id?: string
          payment_method?: string
          pickup_waiting_charge_pence?: number
          platform_commission_pence?: number
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
            referencedRelation: "dispatchable_drivers"
            referencedColumns: ["driver_id"]
          },
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
            referencedRelation: "available_scheduled_jobs"
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
          arrived_at: string | null
          authorised_amount_pence: number | null
          base_fare_pence: number | null
          booking_source: string | null
          broadcast_started_at: string | null
          cancellation_fee_pence: number | null
          cancellation_note: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          capture_amount_pence: number | null
          check_in_reminder_sent_at: string | null
          client_action_id: string | null
          commission_pence: number | null
          completed_at: string | null
          confirm_deadline_at: string | null
          confirmed_driver_id: string | null
          corporate_account_id: string | null
          created_at: string
          currency: string | null
          currency_code: string | null
          current_broadcast_round: number | null
          current_offer_driver_id: string | null
          current_offer_expires_at: string | null
          current_stop_index: number | null
          debt_recovery_pence: number | null
          dispatch_mode: string | null
          dispatch_status: string | null
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
          excluded_driver_ids: string[] | null
          extras_pence: number | null
          fare: number | null
          fare_amount: number | null
          final_fare_pence: number | null
          final_payout_pence: number | null
          gross_fare_pence: number | null
          id: string
          is_scheduled: boolean | null
          job_type: string | null
          last_broadcast_at: string | null
          max_broadcast_rounds: number | null
          negotiation_locked_until: string | null
          offer_snapshot: Json | null
          passenger_id: string
          passenger_name: string | null
          passenger_phone: string | null
          payment_intent_version: number | null
          payment_method: string | null
          payment_status: string | null
          payment_type: string | null
          pickup_address: string
          pickup_latitude: number | null
          pickup_longitude: number | null
          pickup_zone_id: string | null
          platform_commission_amount: number | null
          pre_assigned_driver_id: string | null
          pricing_version: string | null
          qr_session_id: string | null
          refund_amount_pence: number | null
          refund_reason: string | null
          refunded_at: string | null
          scheduled_accepted_at: string | null
          scheduled_at: string | null
          scheduled_broadcast_at: string | null
          scheduled_convert_at: string | null
          scheduled_status: string | null
          sequence_no: number | null
          service_area_code: string | null
          service_area_id: string | null
          special_instructions: string | null
          stacked_trip_id: string | null
          started_at: string | null
          status: string | null
          stops: Json | null
          stripe_charge_id: string | null
          stripe_fee_amount: number | null
          stripe_payment_intent_id: string | null
          stripe_processing_fee_pence: number | null
          stripe_transfer_id: string | null
          surge_multiplier: number | null
          tip_amount_pence: number
          tip_pence: number | null
          total_stops: number | null
          trip_code: string | null
          trip_number: string | null
          trip_type: string | null
          updated_at: string
          vehicle_type: string | null
          vehicle_type_id: string | null
          wallet_applied_pence: number | null
          wallet_balance_after: number | null
          wallet_balance_before: number | null
        }
        Insert: {
          arrived_at?: string | null
          authorised_amount_pence?: number | null
          base_fare_pence?: number | null
          booking_source?: string | null
          broadcast_started_at?: string | null
          cancellation_fee_pence?: number | null
          cancellation_note?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          capture_amount_pence?: number | null
          check_in_reminder_sent_at?: string | null
          client_action_id?: string | null
          commission_pence?: number | null
          completed_at?: string | null
          confirm_deadline_at?: string | null
          confirmed_driver_id?: string | null
          corporate_account_id?: string | null
          created_at?: string
          currency?: string | null
          currency_code?: string | null
          current_broadcast_round?: number | null
          current_offer_driver_id?: string | null
          current_offer_expires_at?: string | null
          current_stop_index?: number | null
          debt_recovery_pence?: number | null
          dispatch_mode?: string | null
          dispatch_status?: string | null
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
          excluded_driver_ids?: string[] | null
          extras_pence?: number | null
          fare?: number | null
          fare_amount?: number | null
          final_fare_pence?: number | null
          final_payout_pence?: number | null
          gross_fare_pence?: number | null
          id?: string
          is_scheduled?: boolean | null
          job_type?: string | null
          last_broadcast_at?: string | null
          max_broadcast_rounds?: number | null
          negotiation_locked_until?: string | null
          offer_snapshot?: Json | null
          passenger_id: string
          passenger_name?: string | null
          passenger_phone?: string | null
          payment_intent_version?: number | null
          payment_method?: string | null
          payment_status?: string | null
          payment_type?: string | null
          pickup_address: string
          pickup_latitude?: number | null
          pickup_longitude?: number | null
          pickup_zone_id?: string | null
          platform_commission_amount?: number | null
          pre_assigned_driver_id?: string | null
          pricing_version?: string | null
          qr_session_id?: string | null
          refund_amount_pence?: number | null
          refund_reason?: string | null
          refunded_at?: string | null
          scheduled_accepted_at?: string | null
          scheduled_at?: string | null
          scheduled_broadcast_at?: string | null
          scheduled_convert_at?: string | null
          scheduled_status?: string | null
          sequence_no?: number | null
          service_area_code?: string | null
          service_area_id?: string | null
          special_instructions?: string | null
          stacked_trip_id?: string | null
          started_at?: string | null
          status?: string | null
          stops?: Json | null
          stripe_charge_id?: string | null
          stripe_fee_amount?: number | null
          stripe_payment_intent_id?: string | null
          stripe_processing_fee_pence?: number | null
          stripe_transfer_id?: string | null
          surge_multiplier?: number | null
          tip_amount_pence?: number
          tip_pence?: number | null
          total_stops?: number | null
          trip_code?: string | null
          trip_number?: string | null
          trip_type?: string | null
          updated_at?: string
          vehicle_type?: string | null
          vehicle_type_id?: string | null
          wallet_applied_pence?: number | null
          wallet_balance_after?: number | null
          wallet_balance_before?: number | null
        }
        Update: {
          arrived_at?: string | null
          authorised_amount_pence?: number | null
          base_fare_pence?: number | null
          booking_source?: string | null
          broadcast_started_at?: string | null
          cancellation_fee_pence?: number | null
          cancellation_note?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          capture_amount_pence?: number | null
          check_in_reminder_sent_at?: string | null
          client_action_id?: string | null
          commission_pence?: number | null
          completed_at?: string | null
          confirm_deadline_at?: string | null
          confirmed_driver_id?: string | null
          corporate_account_id?: string | null
          created_at?: string
          currency?: string | null
          currency_code?: string | null
          current_broadcast_round?: number | null
          current_offer_driver_id?: string | null
          current_offer_expires_at?: string | null
          current_stop_index?: number | null
          debt_recovery_pence?: number | null
          dispatch_mode?: string | null
          dispatch_status?: string | null
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
          excluded_driver_ids?: string[] | null
          extras_pence?: number | null
          fare?: number | null
          fare_amount?: number | null
          final_fare_pence?: number | null
          final_payout_pence?: number | null
          gross_fare_pence?: number | null
          id?: string
          is_scheduled?: boolean | null
          job_type?: string | null
          last_broadcast_at?: string | null
          max_broadcast_rounds?: number | null
          negotiation_locked_until?: string | null
          offer_snapshot?: Json | null
          passenger_id?: string
          passenger_name?: string | null
          passenger_phone?: string | null
          payment_intent_version?: number | null
          payment_method?: string | null
          payment_status?: string | null
          payment_type?: string | null
          pickup_address?: string
          pickup_latitude?: number | null
          pickup_longitude?: number | null
          pickup_zone_id?: string | null
          platform_commission_amount?: number | null
          pre_assigned_driver_id?: string | null
          pricing_version?: string | null
          qr_session_id?: string | null
          refund_amount_pence?: number | null
          refund_reason?: string | null
          refunded_at?: string | null
          scheduled_accepted_at?: string | null
          scheduled_at?: string | null
          scheduled_broadcast_at?: string | null
          scheduled_convert_at?: string | null
          scheduled_status?: string | null
          sequence_no?: number | null
          service_area_code?: string | null
          service_area_id?: string | null
          special_instructions?: string | null
          stacked_trip_id?: string | null
          started_at?: string | null
          status?: string | null
          stops?: Json | null
          stripe_charge_id?: string | null
          stripe_fee_amount?: number | null
          stripe_payment_intent_id?: string | null
          stripe_processing_fee_pence?: number | null
          stripe_transfer_id?: string | null
          surge_multiplier?: number | null
          tip_amount_pence?: number
          tip_pence?: number | null
          total_stops?: number | null
          trip_code?: string | null
          trip_number?: string | null
          trip_type?: string | null
          updated_at?: string
          vehicle_type?: string | null
          vehicle_type_id?: string | null
          wallet_applied_pence?: number | null
          wallet_balance_after?: number | null
          wallet_balance_before?: number | null
        }
        Relationships: [
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
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
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
      zone_route_pricing: {
        Row: {
          created_at: string
          dropoff_fee: number
          fixed_fare: number
          from_zone_id: string
          id: string
          is_active: boolean
          pickup_fee: number
          priority: number
          service_area_id: string | null
          to_zone_id: string
          updated_at: string
          vehicle_type_id: string | null
        }
        Insert: {
          created_at?: string
          dropoff_fee?: number
          fixed_fare: number
          from_zone_id: string
          id?: string
          is_active?: boolean
          pickup_fee?: number
          priority?: number
          service_area_id?: string | null
          to_zone_id: string
          updated_at?: string
          vehicle_type_id?: string | null
        }
        Update: {
          created_at?: string
          dropoff_fee?: number
          fixed_fare?: number
          from_zone_id?: string
          id?: string
          is_active?: boolean
          pickup_fee?: number
          priority?: number
          service_area_id?: string | null
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
            referencedRelation: "driver_wallet_balance"
            referencedColumns: ["driver_id"]
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
      dispatchable_drivers: {
        Row: {
          app_state: string | null
          current_trip_id: string | null
          driver_id: string | null
          first_name: string | null
          heading: number | null
          heartbeat_age_seconds: number | null
          last_heartbeat_at: string | null
          last_location_at: string | null
          last_name: string | null
          lat: number | null
          lng: number | null
          platform: string | null
          push_token: string | null
          rating: number | null
          speed: number | null
          status: string | null
        }
        Relationships: [
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
      accept_scheduled_ride: {
        Args: { p_driver_id: string; p_trip_id: string }
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
      current_customer_id: { Args: never; Returns: string }
      current_driver_id: { Args: never; Returns: string }
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
      dispatch_trip_offers: { Args: { p_trip_id: string }; Returns: undefined }
      expire_stale_drivers: {
        Args: { p_ttl_seconds?: number }
        Returns: number
      }
      expire_stale_modification_requests: { Args: never; Returns: number }
      expire_stale_offers: { Args: never; Returns: Json }
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
          p_first_name?: string
          p_last_name?: string
          p_phone?: string
          p_user_id?: string
        }
        Returns: string
      }
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
      is_admin: { Args: never; Returns: boolean }
      is_driver_dispatchable: {
        Args: {
          p_driver_id: string
          p_max_heartbeat_age_seconds?: number
          p_max_location_age_seconds?: number
          p_require_push_token?: boolean
        }
        Returns: boolean
      }
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
      recalculate_driver_wallet: {
        Args: { p_driver_id: string }
        Returns: undefined
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
      timeout_scheduled_offer: {
        Args: { p_driver_id: string; p_trip_id: string }
        Returns: Json
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
          p_app_state?: string
          p_driver_id: string
          p_heading?: number
          p_lat?: number
          p_lng?: number
          p_platform?: string
          p_push_token?: string
          p_speed?: number
          p_status?: string
        }
        Returns: {
          app_state: string
          created_at: string
          driver_id: string
          heading: number | null
          last_heartbeat_at: string
          last_location_at: string | null
          lat: number | null
          lng: number | null
          platform: string | null
          push_token: string | null
          speed: number | null
          status: string
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "driver_presence"
          isOneToOne: true
          isSetofReturn: false
        }
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
      app_scope: "customer" | "driver" | "corporate" | "shared"
      content_status: "draft" | "published"
      staff_role:
        | "super_admin"
        | "admin"
        | "operator"
        | "finance_manager"
        | "customer_support"
        | "compliance_officer"
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
      app_scope: ["customer", "driver", "corporate", "shared"],
      content_status: ["draft", "published"],
      staff_role: [
        "super_admin",
        "admin",
        "operator",
        "finance_manager",
        "customer_support",
        "compliance_officer",
      ],
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
    },
  },
} as const
