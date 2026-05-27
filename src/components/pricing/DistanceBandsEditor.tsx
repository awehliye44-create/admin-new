import { Plus, Trash2, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface DistanceBand {
  from: number;
  to: number | null;
  rate_pence: number;
}

interface Props {
  bands: DistanceBand[];
  unitShort: string;       // 'Mile' | 'Km'
  unitLong: string;        // 'mile' | 'kilometre'
  currencySymbol: string;  // '£' | '€' | '$'
  currencyCode: string;    // 'GBP' | 'EUR' | 'USD'
  onChange: (next: DistanceBand[]) => void;
}

export function DistanceBandsEditor({
  bands, unitShort, unitLong, currencySymbol, currencyCode, onChange,
}: Props) {
  const update = (idx: number, patch: Partial<DistanceBand>) => {
    const next = bands.map((b, i) => (i === idx ? { ...b, ...patch } : b));
    onChange(next);
  };
  const remove = (idx: number) => onChange(bands.filter((_, i) => i !== idx));
  const add = () => {
    const last = bands[bands.length - 1];
    const from = last ? Math.max((last.to ?? last.from) + 1, last.from + 1) : 1;
    onChange([...bands, { from, to: null, rate_pence: 0 }]);
  };

  return (
    <div className="rounded-lg border border-primary/30 p-4 space-y-3 bg-primary/[0.02]">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Label className="text-base font-semibold">Distance Pricing Bands</Label>
            <Info className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Set different rates for different distance ranges. The correct rate is applied based on trip distance. Leave empty to use the flat per-{unitLong} rate.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={add} type="button">
          <Plus className="h-3.5 w-3.5 mr-1" /> Add Band
        </Button>
      </div>

      {bands.length === 0 ? (
        <div className="text-xs text-muted-foreground italic py-3 text-center">
          No bands configured — using the flat Per {unitShort} Rate above.
        </div>
      ) : (
        <div className="space-y-2">
          <div className="grid grid-cols-[1fr_1fr_1fr_90px_90px_40px] gap-2 text-xs text-muted-foreground font-medium px-1">
            <div>From Distance</div>
            <div>To Distance</div>
            <div>Rate per Unit</div>
            <div>Unit</div>
            <div>Currency</div>
            <div></div>
          </div>
          {bands.map((b, idx) => (
            <div key={idx} className="grid grid-cols-[1fr_1fr_1fr_90px_90px_40px] gap-2 items-center">
              <Input
                type="number" min={0} step="0.1" value={b.from}
                onChange={(e) => update(idx, { from: parseFloat(e.target.value) || 0 })}
              />
              <Input
                type="number" min={0} step="0.1"
                placeholder="and above"
                value={b.to ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  update(idx, { to: v === '' ? null : parseFloat(v) || 0 });
                }}
              />
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">{currencySymbol}</span>
                <Input
                  type="number" min={0} step="0.01"
                  className="pl-7"
                  value={(b.rate_pence / 100).toFixed(2)}
                  onChange={(e) => update(idx, { rate_pence: Math.round((parseFloat(e.target.value) || 0) * 100) })}
                />
              </div>
              <div className="h-9 px-3 flex items-center text-sm bg-muted/50 rounded-md border border-input">{unitShort}</div>
              <div className="h-9 px-3 flex items-center text-sm bg-muted/50 rounded-md border border-input">{currencySymbol} ({currencyCode})</div>
              <Button size="icon" variant="ghost" type="button"
                onClick={() => remove(idx)} className="text-destructive">
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      )}

      <div className="text-xs text-muted-foreground bg-muted/40 px-3 py-2 rounded-md border">
        Unit ({unitShort}/{unitShort === 'Mile' ? 'Km' : 'Mile'}) and currency are taken from the selected Service Area's Region.
      </div>
    </div>
  );
}
