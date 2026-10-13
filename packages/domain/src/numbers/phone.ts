/** V7 F3 (wireframe D, RF-07.a): the number typed at registration is private.
 * Only its keyed fingerprint and last four digits are kept. Comparison with
 * the identity observed after the QR uses one normalization for both sides:
 * international digits without "+", and Mexico's legacy mobile "1" removed
 * (WhatsApp may report 521XXXXXXXXXX or 52XXXXXXXXXX for the same line). */
export const numberCountries={
 MX:{code:'52',name:'México',national:10},US:{code:'1',name:'Estados Unidos',national:10},CO:{code:'57',name:'Colombia',national:10},
 AR:{code:'54',name:'Argentina',national:[10,11]},CL:{code:'56',name:'Chile',national:9},PE:{code:'51',name:'Perú',national:9},
 EC:{code:'593',name:'Ecuador',national:9},GT:{code:'502',name:'Guatemala',national:8},ES:{code:'34',name:'España',national:9},
} as const;
export type NumberCountry=keyof typeof numberCountries;
export class PhoneError extends Error{constructor(code:string){super(code);this.name='PhoneError';}}

/** Canonical international digits for one line. */
export function canonicalPhoneDigits(digits:string){
 if(!/^\d{8,15}$/.test(digits))throw new PhoneError('PHONE_INVALID');
 return digits.length===13&&digits.startsWith('521')?'52'+digits.slice(3):digits;
}
/** Typed number → canonical digits. Accepts the national form or the full
 * international form with or without "+"; spaces, dashes and parentheses ignored. */
export function normalizePhone(country:NumberCountry,input:string){
 const spec=numberCountries[country];if(!spec)throw new PhoneError('PHONE_COUNTRY_UNSUPPORTED');
 const raw=String(input??'').trim();if(raw.length>32||!/^\+?[\d\s().-]+$/.test(raw))throw new PhoneError('PHONE_INVALID');
 let digits=raw.replace(/\D/g,'');
 const lengths:number[]=Array.isArray(spec.national)?[...spec.national]:[spec.national as number];
 if(!raw.startsWith('+')&&digits.length<Math.min(...lengths))throw new PhoneError('PHONE_INVALID');
 if(raw.startsWith('+')||!lengths.includes(digits.length)){
  if(!digits.startsWith(spec.code))throw new PhoneError('PHONE_COUNTRY_MISMATCH');
  digits=digits.slice(spec.code.length);
  if(country==='MX'&&digits.length===11&&digits.startsWith('1'))digits=digits.slice(1);
 }
 if(!lengths.includes(digits.length))throw new PhoneError('PHONE_INVALID');
 const canonical=canonicalPhoneDigits(spec.code+digits);
 return{digits:canonical,last4:canonical.slice(-4),masked:'•••• '+canonical.slice(-4)};
}
/** Digits of a provider identity already canonicalized as `wa:<digits>`. */
export function observedPhoneDigits(canonicalIdentity:string){
 const match=/^wa:(\d{6,18})$/.exec(canonicalIdentity);if(!match)throw new PhoneError('PHONE_IDENTITY_NOT_A_LINE');
 return canonicalPhoneDigits(match[1]!);
}
