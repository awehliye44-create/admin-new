/**
 * Mask email for Admin UI display — never show full personal addresses by default.
 */
export function maskEmailForAdmin(email: string | null | undefined): string {
  if (!email) return '—';
  const normalized = String(email).trim().toLowerCase();
  const at = normalized.lastIndexOf('@');
  if (at < 1) return '***';
  const local = normalized.slice(0, at);
  const domain = normalized.slice(at + 1);
  if (!domain) return '***';
  const visible = local.length <= 2 ? '*' : `${local[0]}***${local[local.length - 1]}`;
  return `${visible}@${domain}`;
}
