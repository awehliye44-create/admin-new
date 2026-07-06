import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Shield, Loader2, Save, Info } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  useServiceAreaPreauthBuffer,
  type PreauthBufferConfig as PreauthCfg,
} from "@/hooks/useServiceAreaPreauthBuffer";
import { getCurrencySymbol } from "@/lib/regionSettings";

interface Props {
  serviceAreaId: string;
  serviceAreaName?: string;
  /** Currency from Region (single source of truth). */
  regionCurrencyCode: string;
}

/**
 * Pre-Authorization Buffer config card.
 *
 * IMPORTANT (do not violate):
 * - This is a PAYMENT-layer setting. It only inflates the Provider AUTH HOLD.
 * - It is NEVER added to the fare, driver earnings, commission or final capture.
 * - Customer always sees Estimated Fare and Pre-auth Hold separately on checkout.
 */
export function PreauthBufferConfig({ serviceAreaId, serviceAreaName, regionCurrencyCode }: Props) {
  const { config, save, isLoading, isSaving } = useServiceAreaPreauthBuffer(serviceAreaId);
  const [draft, setDraft] = useState<PreauthCfg | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    setDraft(config);
    setDirty(false);
  }, [config]);

  const symbol = getCurrencySymbol(regionCurrencyCode);

  const update = <K extends keyof PreauthCfg>(key: K, value: PreauthCfg[K]) => {
    if (!draft) return;
    setDraft({ ...draft, [key]: value });
    setDirty(true);
  };

  const handleSave = async () => {
    if (!draft) return;
    if (draft.buffer_value < 0) {
      toast.error("Buffer value must be 0 or greater");
      return;
    }
    if (
      draft.min_hold_pence != null &&
      draft.max_hold_pence != null &&
      draft.max_hold_pence < draft.min_hold_pence
    ) {
      toast.error("Max hold cannot be less than min hold");
      return;
    }
    try {
      await save(draft);
      setDirty(false);
      toast.success("Pre-authorization buffer saved");
    } catch (e) {
      console.error(e);
      toast.error("Failed to save pre-authorization buffer");
    }
  };

  if (isLoading || !draft) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </CardContent>
      </Card>
    );
  }

  // Preview math
  const sampleFare = 1500; // £15.00
  const safe = Math.max(0, draft.buffer_value || 0);
  let buffer =
    draft.buffer_type === "fixed"
      ? Math.round(safe * 100)
      : Math.round((sampleFare * safe) / 100);
  let hold = sampleFare + buffer;
  if (draft.min_hold_pence != null && hold < draft.min_hold_pence) hold = draft.min_hold_pence;
  if (draft.max_hold_pence != null && hold > draft.max_hold_pence) hold = Math.max(sampleFare, draft.max_hold_pence);
  if (hold < sampleFare) hold = sampleFare;
  buffer = hold - sampleFare;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 text-primary" />
              Pre-Authorization Buffer
            </CardTitle>
            <CardDescription>
              Inflates the temporary card hold above the estimated fare for{" "}
              {serviceAreaName || "this service area"}. <strong>This is not part of the fare</strong>{" "}
              — it&apos;s only a payment safety hold. Provider releases the unused amount when the
              final fare is captured.
            </CardDescription>
          </div>
          <Switch
            checked={draft.enable_preauth_buffer}
            onCheckedChange={(v) => update("enable_preauth_buffer", v)}
            disabled={isSaving}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-sm">Buffer Type</Label>
            <Select
              value={draft.buffer_type}
              onValueChange={(v) => update("buffer_type", v as "fixed" | "percentage")}
              disabled={!draft.enable_preauth_buffer}
            >
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="percentage">Percentage (%)</SelectItem>
                <SelectItem value="fixed">Fixed amount ({symbol})</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label className="text-sm">
              Buffer Value {draft.buffer_type === "fixed" ? `(${symbol})` : "(%)"}
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                {draft.buffer_type === "fixed" ? symbol : "%"}
              </span>
              <Input
                type="number"
                step={draft.buffer_type === "fixed" ? "0.01" : "0.1"}
                min="0"
                value={draft.buffer_value}
                onChange={(e) => update("buffer_value", parseFloat(e.target.value) || 0)}
                disabled={!draft.enable_preauth_buffer}
                className="pl-7"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {draft.buffer_type === "fixed"
                ? `Hold an extra ${symbol}${(draft.buffer_value || 0).toFixed(2)} above the estimated fare`
                : `Hold an extra ${(draft.buffer_value || 0).toFixed(1)}% above the estimated fare`}
            </p>
          </div>

          <div className="space-y-1">
            <Label className="text-sm">Minimum Hold ({symbol}) <span className="text-muted-foreground">— optional</span></Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">{symbol}</span>
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="No minimum"
                value={draft.min_hold_pence != null ? (draft.min_hold_pence / 100).toFixed(2) : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  update("min_hold_pence", v === "" ? null : Math.round(parseFloat(v) * 100));
                }}
                disabled={!draft.enable_preauth_buffer}
                className="pl-7"
              />
            </div>
            <p className="text-xs text-muted-foreground">Floor for tiny fares (e.g. {symbol}2.00).</p>
          </div>

          <div className="space-y-1">
            <Label className="text-sm">Maximum Hold ({symbol}) <span className="text-muted-foreground">— optional</span></Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">{symbol}</span>
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="No maximum"
                value={draft.max_hold_pence != null ? (draft.max_hold_pence / 100).toFixed(2) : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  update("max_hold_pence", v === "" ? null : Math.round(parseFloat(v) * 100));
                }}
                disabled={!draft.enable_preauth_buffer}
                className="pl-7"
              />
            </div>
            <p className="text-xs text-muted-foreground">Ceiling so large fares aren&apos;t over-held.</p>
          </div>
        </div>

        {/* Preview */}
        <div className="rounded-md border bg-muted/30 p-3 space-y-1.5">
          <div className="flex items-center gap-2 text-xs font-medium text-foreground">
            <Info className="h-3.5 w-3.5" /> Preview on a {symbol}15.00 estimated fare
          </div>
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <div className="text-xs text-muted-foreground">Estimated fare</div>
              <div className="font-medium">{symbol}15.00</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Buffer</div>
              <div className="font-medium">{symbol}{(buffer / 100).toFixed(2)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Pre-auth hold</div>
              <div className="font-semibold text-primary">{symbol}{(hold / 100).toFixed(2)}</div>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground pt-1">
            Final amount captured = real trip fare. Buffer is <strong>not</strong> charged — Provider releases it.
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!dirty || isSaving}>
            {isSaving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Save className="h-4 w-4 mr-2" />}
            Save Pre-Auth Buffer
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
