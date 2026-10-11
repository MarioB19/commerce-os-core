import {useEffect,useState} from 'react';
import {api,params,type Environment} from '../lib/api';
import {useWorkspace} from '../lib/workspace';
import {Button} from './ui/button';

type Preview={kind:string;name:string;mime_type?:string;size_bytes?:number;content_url?:string;download_url?:string;url?:string;code?:string;instructions?:string};
const localContent=(url?:string)=>url?.startsWith('/v1/assets/')&&!url.startsWith('//')?url:undefined;
const externalLink=(url?:string)=>{try{const u=new URL(url??'');return u.protocol==='https:'&&!u.username&&!u.password?u.href:undefined;}catch{return undefined;}};
export function AssetPreview({assetId,inline=false,environment:forcedEnvironment}:{assetId:string;inline?:boolean;environment?:Environment}){
 const {environment:workspaceEnvironment}=useWorkspace(),environment=forcedEnvironment??workspaceEnvironment,[open,setOpen]=useState(inline);
 return <div className="asset-preview">{!inline&&<Button type="button" variant="secondary" onClick={()=>setOpen(!open)}>{open?'Cerrar material':'Ver material'}</Button>}{open&&<PreviewContent key={`${environment}:${assetId}`} assetId={assetId} environment={environment}/>}</div>;
}
function PreviewContent({assetId,environment}:{assetId:string;environment:Environment}){
 const[preview,setPreview]=useState<Preview|null>(null),[error,setError]=useState(''),[mediaError,setMediaError]=useState(false);
 useEffect(()=>{const controller=new AbortController();void api<Preview>(`/assets/${assetId}/preview${params(environment)}`,{signal:controller.signal}).then(setPreview).catch((e:unknown)=>{if(!controller.signal.aborted)setError(e instanceof Error?e.message:'No se pudo abrir el material.');});return()=>controller.abort();},[assetId,environment]);
 if(error)return <p role="alert">{error}</p>;
 if(!preview)return <p role="status">Cargando material…</p>;
 const content=localContent(preview.content_url),download=localContent(preview.download_url),link=externalLink(preview.url),mime=preview.mime_type??'';
 return <div style={{display:'grid',gap:8,minWidth:0,maxWidth:'100%'}}>
  <strong>{preview.name}</strong>
  {(preview.mime_type||preview.size_bytes!=null)&&<small>{preview.mime_type??'Recurso protegido'}{preview.size_bytes!=null?` · ${formatBytes(preview.size_bytes)}`:''}</small>}
  {content&&mime.startsWith('audio/')&&<audio aria-label={`Audio: ${preview.name}`} controls preload="metadata" src={content} onError={()=>setMediaError(true)} style={{width:'100%',maxWidth:440}}/>}
  {content&&mime.startsWith('image/')&&<img loading="lazy" src={content} alt={preview.name} onError={()=>setMediaError(true)} style={{maxWidth:'100%',maxHeight:360,objectFit:'contain'}}/>}
  {content&&mime.startsWith('video/')&&<video aria-label={`Video: ${preview.name}`} controls preload="metadata" src={content} onError={()=>setMediaError(true)} style={{maxWidth:'100%',maxHeight:360}}/>}
  {content&&mime==='application/pdf'&&<iframe title={`Documento: ${preview.name}`} src={content} style={{width:'100%',height:420,border:0}}/>}
  {mediaError&&<p role="alert">No se pudo reproducir aquí. Puedes abrir o descargar el archivo.</p>}
  {preview.instructions&&<p style={{whiteSpace:'pre-wrap'}}>{preview.instructions}</p>}
  {link&&<a href={link} target="_blank" rel="noopener noreferrer">Abrir recurso</a>}
  {preview.code&&<p>Código de acceso: <code>{preview.code}</code></p>}
  <div className="button-group">{content&&<a href={content} target="_blank" rel="noopener noreferrer">Abrir archivo</a>}{download&&<a href={download} download>Descargar</a>}</div>
 </div>;
}
function formatBytes(value:number){if(value<1024)return`${value} B`;if(value<1024*1024)return`${(value/1024).toFixed(1)} KiB`;return`${(value/1024/1024).toFixed(1)} MiB`;}
