/**
 * Normalizes what people type into an amount field: "1,5" (decimal comma)
 * becomes "1.5"; "1,000.5" (thousands separators) becomes "1000.5".
 */
export function normalizeAmountInput(value: string): string {
  const trimmed = value.replace(/\s/g, '');
  if (trimmed.includes('.')) return trimmed.replace(/,/g, '');
  const commas = trimmed.split(',').length - 1;
  return commas === 1 ? trimmed.replace(',', '.') : trimmed.replace(/,/g, '');
}
