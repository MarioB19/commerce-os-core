export function assignmentAuthorizationExpiryAllowed(expiresAt:string,now:number,shortLived:boolean):boolean {
 const expiry=Date.parse(expiresAt);
 return Number.isFinite(expiry)&&expiry>now&&expiry<=now+(shortLived?7:366)*86400000;
}
