/** V7.1.1 (27-oct-2026): the closed error code of a dispatch the mail service refused
 * (`{"error":{"code":"MAIL_…"}}`, scripts/gcp_mail_dispatch.py), or a fixed placeholder.
 * The service never puts a recipient, link or token in it; anything else is not echoed. */
export async function mailServiceCode(response:{json():Promise<unknown>}):Promise<string>{
 try{
  const value=await response.json() as {error?:{code?:unknown}}|null;const code=value?.error?.code;
  return typeof code==='string'&&/^MAIL_[A-Z0-9_]{1,76}$/.test(code)?code:'MAIL_CODE_UNREADABLE';
 }catch{return 'MAIL_CODE_UNREADABLE';}
}
