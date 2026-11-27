'use client';
import { useEffect } from 'react';
import { Field, Select } from '@/components/ui';
import type { Brand } from '@/lib/types';

/** Brand selector; remembers the last choice per browser tab. */
export function BrandPicker({
  brands,
  value,
  onChange,
}: {
  brands: Brand[];
  value: string;
  onChange: (id: string) => void;
}) {
  useEffect(() => {
    if (!value && brands.length) {
      let saved: string | null = null;
      try {
        saved = sessionStorage.getItem('crm.brand');
      } catch {
        /* storage unavailable */
      }
      onChange(brands.find((b) => b.id === saved)?.id ?? brands[0].id);
    }
  }, [brands, value, onChange]);
  return (
    <div className="w-72">
      <Field label="Brand">
        <Select
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            try {
              sessionStorage.setItem('crm.brand', e.target.value);
            } catch {
              /* storage unavailable */
            }
          }}
        >
          {brands.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name} ({b.currency})
            </option>
          ))}
        </Select>
      </Field>
    </div>
  );
}
