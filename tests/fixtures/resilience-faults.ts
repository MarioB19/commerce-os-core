export const providerHttpFaults=[
 {name:'terminal provider 400',status:400,expected:'FAILED'},
 {name:'uncertain provider 408',status:408,expected:'UNKNOWN'},
 {name:'rate-limited provider 429',status:429,expected:'UNKNOWN'},
 {name:'uncertain provider 500',status:500,expected:'UNKNOWN'},
 {name:'unavailable provider 503',status:503,expected:'UNKNOWN'},
] as const;

export function staleWorkerHeartbeat(service:'automation-worker'|'channel-worker',now=Date.now()){
 return{service,instance:'synthetic-stopped-worker',status:'OK',observed_at:new Date(now-120_000).toISOString(),expires_at:new Date(now-60_000).toISOString()};
}

export function lowDiskObservation(now=Date.now()){
 return{key:'private_storage_disk',status:'OBSERVED',source:'MOUNTED_PRIVATE_STORAGE_STATFS',available_bytes:512*1024**2,total_bytes:20*1024**3,observed_at:new Date(now).toISOString(),expires_at:new Date(now+180_000).toISOString()};
}

export const unavailableGatewayAccount={name:'Gateway sintético no disponible',provider:'waha',gateway_ref:'waha-01',status:'FAILED',sending_enabled:false};
