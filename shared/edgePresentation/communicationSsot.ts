/** Admin presentation-only helpers; not part of Edge uploads. */
import { CommunicationDefaultMethod } from "../../supabase/functions/_shared/communicationSsot.ts";


export interface ServiceAreaCommunicationConfig {
  service_area_id: string;
  communication_enabled: boolean;
  voip_enabled: boolean;
  call_masking_enabled: boolean;
  default_method: CommunicationDefaultMethod;
  max_call_duration_seconds: number;
  voip_provider: string;
  call_masking_provider_config_id: string | null;
  outbound_caller_id: string | null;
  voip_rate_per_minute: number;
  call_masking_rate_per_minute: number;
  config_version: number;
  updated_at: string | null;
}


export const COMMUNICATION_LOG_EVENTS = {
  CONFIG_SAVED: 'COMMUNICATION_CONFIG_SAVED',
  CONFIG_LOADED: 'COMMUNICATION_CONFIG_LOADED',
  CONFIG_MISSING: 'COMMUNICATION_CONFIG_MISSING',
  ACTION_RENDERED: 'COMMUNICATION_ACTION_RENDERED',
  ACTION_HIDDEN: 'COMMUNICATION_ACTION_HIDDEN',
  VOIP_TOKEN_REQUESTED: 'VOIP_TOKEN_REQUESTED',
  VOIP_CALL_STARTED: 'VOIP_CALL_STARTED',
  VOIP_CALL_ENDED: 'VOIP_CALL_ENDED',
  MASKED_CALL_REQUESTED: 'MASKED_CALL_REQUESTED',
  MASKED_CALL_STARTED: 'MASKED_CALL_STARTED',
  MASKED_CALL_FAILED: 'MASKED_CALL_FAILED',
  OUTBOUND_CALLER_ID_INVALID: 'OUTBOUND_CALLER_ID_INVALID',
} as const;
