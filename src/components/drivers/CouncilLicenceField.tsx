import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  COUNCIL_LICENCE_DATALIST_ID,
  COUNCIL_LICENCE_SUGGESTIONS,
} from '@/lib/driverCouncilLicence';

type CouncilLicenceFieldProps = {
  id: string;
  value: string;
  onChange: (value: string) => void;
};

/**
 * Admin-only editable field for the licensing council that issued the
 * driver's private hire driver licence. Searchable suggestions with free text.
 */
export function CouncilLicenceField({ id, value, onChange }: CouncilLicenceFieldProps) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Council Licence</Label>
      <Input
        id={id}
        list={COUNCIL_LICENCE_DATALIST_ID}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="e.g. Wolverhampton Council"
        autoComplete="off"
      />
      <datalist id={COUNCIL_LICENCE_DATALIST_ID}>
        {COUNCIL_LICENCE_SUGGESTIONS.map((council) => (
          <option key={council} value={council} />
        ))}
      </datalist>
      <p className="text-xs text-muted-foreground">
        Licensing authority that issued the driver licence. Internal only — not the assigned
        service area.
      </p>
    </div>
  );
}
