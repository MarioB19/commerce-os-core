export interface ClientResponse<T=Record<string,unknown>> {data:T;meta?:Record<string,unknown>;http_status:number;idempotency_key?:string}
export interface FollowResult {status:string;command?:Record<string,unknown>;effects:Record<string,unknown>[];portal_access?:string}
export class CommerceClient {
 constructor(options?:{baseUrl?:string;token?:string;lab?:boolean;timeoutMs?:number});
 environment:'REAL'|'SIMULATION';
 request<T=Record<string,unknown>>(method:string,path:string,options?:{body?:Record<string,unknown>;key?:string;query?:Record<string,string|number>}):Promise<ClientResponse<T>>;
 upload(path:string,options?:{name?:string;mimeType?:string;key?:string}):Promise<ClientResponse>;
 follow(commandId:string,options?:{until?:'SENT'|'DELIVERED'|'READ';timeoutMs?:number;intervalMs?:number}):Promise<FollowResult>;
}
