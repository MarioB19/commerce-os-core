import type {Model} from './contracts.js';

/** V7 F4 (RF-14.a/c/d, D-09): the reviewed model price catalogue installed by
 * migration 0106. Prices are the providers' official standard-tier rates read
 * on 2026-10-13, in integer microUSD per million tokens:
 *  - OpenAI:    https://developers.openai.com/api/docs/pricing (short context <270K)
 *  - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing (Haiku 5.5 ≤100K prompt)
 *  - Google:    https://ai.google.dev/gemini-api/docs/pricing (paid tier)
 * Input ceilings stay below each provider's long-context threshold, so the
 * short-context price is the only one that can apply. Validity ends on
 * 2027-04-01: after that admission refuses with PRICE_EXPIRED until a newer
 * reviewed version is installed (never an inferred price). Business keys are
 * never used to build or test this catalogue. */
export const PRICE_VERSION='official-2026-10-13';
export const MODEL_REVISION='reviewed-2026-10-13';
const validity={version:PRICE_VERSION,validFrom:'2026-10-13T00:00:00.000Z',validUntil:'2027-04-01T00:00:00.000Z',currency:'USD' as const};
const usd=(dollars:number)=>Math.round(dollars*1_000_000);
function model(provider:Model['provider'],name:string,transport:Model['transport'],capabilities:Model['capabilities'],ceilings:[number,number],rates:{input:number;output:number;cacheRead:number;cacheWrite:number;audioInput:number}):Model{
 return{provider,model:name,revision:MODEL_REVISION,transport,capabilities,responseModels:[name,name+'-*'],inputTokenCeiling:ceilings[0],outputTokenCeiling:ceilings[1],
  price:{...validity,input:usd(rates.input),output:usd(rates.output),cacheRead:usd(rates.cacheRead),cacheWrite:usd(rates.cacheWrite),audioInput:usd(rates.audioInput)}};
}
export const reviewedModelCatalog:readonly Model[]=Object.freeze([
 model('openai','gpt-6-luna','responses',['chat','vision'],[64_000,8_000],{input:0.10,output:0.50,cacheRead:0.01,cacheWrite:0.125,audioInput:0}),
 model('openai','gpt-6.1-sol','responses',['chat','vision'],[64_000,8_000],{input:2.00,output:10.00,cacheRead:0.10,cacheWrite:2.50,audioInput:0}),
 model('openai','gpt-4o-mini-transcribe','transcriptions',['audio'],[32_000,4_000],{input:1.25,output:5.00,cacheRead:0,cacheWrite:0,audioInput:1.25}),
 model('anthropic','claude-haiku-5-5','messages',['chat','vision'],[64_000,4_000],{input:0.10,output:0.50,cacheRead:0.01,cacheWrite:0.125,audioInput:0}),
 model('anthropic','claude-sonnet-5-5','messages',['chat','vision'],[64_000,4_000],{input:2.00,output:10.00,cacheRead:0.10,cacheWrite:2.50,audioInput:0}),
 model('google','gemini-2.5-flash-lite','generateContent',['chat','vision','audio'],[64_000,8_000],{input:0.10,output:0.40,cacheRead:0.01,cacheWrite:0,audioInput:0.30}),
 model('google','gemini-2.5-flash','generateContent',['chat','vision','audio'],[64_000,8_000],{input:0.30,output:2.50,cacheRead:0.03,cacheWrite:0,audioInput:1.00}),
]);
/** RF-14.c capability matrix: which task needs which capability, and the
 * explicit fallback order (same provider → complementary key → person). */
export const aiTasks={
 'sales.chat':{capability:'chat',label:'Responder en la conversación'},
 'receipt.document':{capability:'vision',label:'Leer comprobantes de pago'},
 'audio.transcribe':{capability:'audio',label:'Transcribir notas de voz'},
} as const;
export type AiTask=keyof typeof aiTasks;
