import { Transform } from 'class-transformer';

/** Treat "" as absent so optional @IsUUID() fields don't fail validation. */
export function EmptyToUndefined() {
  return Transform(({ value }) =>
    value === '' || value === null ? undefined : value,
  );
}
