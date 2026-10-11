const invoke=window.__TAURI__.core.invoke;
const $=id=>document.getElementById(id);
async function run(fn){$('error').textContent='';try{return await fn();}catch(error){$('error').textContent=String(error);return null;}}
const command=(operation,input={})=>invoke('worker_command',{operation,input});
async function refresh(){const r=await command('status');$('state').textContent=({READY:'Disponible para producir',RENDERING:'Produciendo creativo',PAUSED:'Pausado',WAITING:'Esperando conexión o recuperación',STOPPED:'Detenido'})[r.state]||r.state;if(r.reason)$('state').textContent+=' · '+r.reason;}
$('configure').addEventListener('submit',e=>{e.preventDefault();const f=new FormData(e.target);run(async()=>{await command('configure',{apiOrigin:f.get('apiOrigin'),dataRoot:f.get('dataRoot')||undefined});$('state').textContent='Configurado. Conecta y aprueba este equipo.';});});
$('start').onclick=()=>run(async()=>{await command('resume');await invoke('start_worker');await refresh();});
$('pause').onclick=()=>run(async()=>{await command('pause');await refresh();});
$('stop').onclick=()=>run(async()=>{await invoke('stop_worker');$('state').textContent='Se detendrá al terminar el trabajo activo.';});
$('web').onclick=()=>run(()=>invoke('open_commerce'));
$('pair').onclick=()=>run(async()=>{const r=await command('pair',{name:$('name').value});$('pairing').textContent=`Código: ${r.userCode}. Vence: ${new Date(r.expiresAt).toLocaleTimeString()}. Apruébalo en Preparación → Equipos.`;});
$('poll').onclick=()=>run(async()=>{const r=await command('pair-poll');$('pairing').textContent=r.status==='APPROVED'?'Equipo aprobado. Ya puedes iniciarlo.':`Estado: ${r.status}`;});
$('doctor').onclick=()=>run(async()=>{$('diagnostics').textContent=JSON.stringify(await command('doctor'),null,2);});
$('resources').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);run(()=>command('resources',{requireAc:f.has('requireAc'),cacheGiB:Number(f.get('cacheGiB')),reserveGiB:Number(f.get('reserveGiB'))}));};
$('autostart').onchange=e=>run(()=>invoke('set_autostart',{enabled:e.target.checked}));
run(async()=>{try{const c=await command('configuration');const form=$('configure');form.elements.apiOrigin.value=c.apiOrigin;form.elements.dataRoot.value=c.dataRoot;const resources=$('resources');resources.elements.requireAc.checked=c.requireAc;resources.elements.cacheGiB.value=c.cacheGiB;resources.elements.reserveGiB.value=c.reserveGiB;}catch{/* First connection. */}$('autostart').checked=await invoke('autostart_enabled');await refresh();});setInterval(()=>run(refresh),15000);
