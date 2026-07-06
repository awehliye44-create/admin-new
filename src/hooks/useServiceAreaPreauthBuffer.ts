import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Pre-Authorization Buffer (PAYMENT layer)
 *
 * Per service area. Used ONLY by `create-payment-intent` to inflate the
 * Provider auth hold above the estimated fare. Never touches fare math,
 * driver earnings, commission, or final captured amount.
 */
export interface PreauthBufferConfig {
  service_area_id: string;
  enable_preauth_buffer: boolean;
  buffer_type: "fixed" | "percentage";
  /** fixed: currency units (e.g. 1.50). percentage: percent (e.g. 20). */
  buffer_value: number;
  /** Optional absolute MIN hold (pence). null = no min. */
  min_hold_pence: number | null;
  /** Optional absolute MAX hold (pence). null = no max. */
  max_hold_pence: number | null;
}

const DEFAULT: Omit<PreauthBufferConfig, "service_area_id"> = {
  enable_preauth_buffer: false,
  buffer_type: "percentage",
  buffer_value: 20,
  min_hold_pence: null,
  max_hold_pence: null,
};

export function useServiceAreaPreauthBuffer(serviceAreaId?: string) {
  const [config, setConfig] = useState<PreauthBufferConfig | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!serviceAreaId) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setIsLoading(true);
      const { data, error } = await supabase
        .from("service_area_preauth_settings")
        .select("*")
        .eq("service_area_id", serviceAreaId)
        .maybeSingle();
      if (cancelled) return;
      if (error) console.error("[useServiceAreaPreauthBuffer]", error);
      setConfig(
        (data as PreauthBufferConfig | null) ?? {
          service_area_id: serviceAreaId,
          ...DEFAULT,
        }
      );
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [serviceAreaId]);

  const save = async (next: PreauthBufferConfig) => {
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from("service_area_preauth_settings")
        .upsert(
          {
            service_area_id: next.service_area_id,
            enable_preauth_buffer: next.enable_preauth_buffer,
            buffer_type: next.buffer_type,
            buffer_value: next.buffer_value,
            min_hold_pence: next.min_hold_pence,
            max_hold_pence: next.max_hold_pence,
          },
          { onConflict: "service_area_id" }
        );
      if (error) throw error;
      setConfig(next);
    } finally {
      setIsSaving(false);
    }
  };

  return { config, setConfig, save, isLoading, isSaving };
}
