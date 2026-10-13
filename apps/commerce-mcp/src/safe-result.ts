/** Results returned to an MCP client never carry secrets, ciphertext, storage
 * keys or temporary signed links (kept from the retired service-token server). */
export function safeResult(value:unknown,access=false):any{
 if(Array.isArray(value))return value.map(v=>safeResult(v,access));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!/(?:ciphertext|token_hash|password|api_key|access_token|refresh_token|secret_access|storage_key|local_path|bytes_base64|^token$)/i.test(k)&& (access||k!=='signed_url')).map(([k,v])=>[k,safeResult(v,access)]));
 if(typeof value==='string'&&!access&&/^https?:/i.test(value)&&/[?&](?:x-amz-|signature|token|credential)/i.test(value))return '[temporary access omitted; request asset access explicitly]';
 return value;
}
