import 'server-only';
/** An existing email verified by the owner; independent of future Sales numbers. */
export function supportContact() {
  const email = process.env.MCL_SUPPORT_EMAIL?.trim() || process.env.MCL_PRIVACY_EMAIL?.trim() || '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? {email, href:`mailto:${email}?subject=${encodeURIComponent('Soporte Mi Ciclo Listo')}`} : null;
}
export function privacyResponsible() {
  const name=process.env.MCL_PRIVACY_NAME?.trim(),address=process.env.MCL_PRIVACY_ADDRESS?.trim(),email=process.env.MCL_PRIVACY_EMAIL?.trim();
  return name && address && email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? {name,address,email} : null;
}
