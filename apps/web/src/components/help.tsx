import {Fragment,useState,type ReactNode} from 'react';
import {helpSections,helpMarkdown,HELP_VERSION} from '../../../../packages/contracts/src/help.js';
import {Button,PageHeader} from './ui';
import {Download} from 'lucide-react';

/** V7 F7 Ayuda (RF-16.a/c/d/e): the same text as `/v2/help` and MCP
 * `help_read`, rendered without HTML injection, and downloadable. */
function inline(text:string):ReactNode[]{
 const out:ReactNode[]=[];const pattern=/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;let last=0,m:RegExpExecArray|null,k=0;
 while((m=pattern.exec(text))){if(m.index>last)out.push(text.slice(last,m.index));const t=m[0];
  if(t.startsWith('**'))out.push(<strong key={k++}>{t.slice(2,-2)}</strong>);
  else if(t.startsWith('`'))out.push(<code key={k++}>{t.slice(1,-1)}</code>);
  else if(t.startsWith('['))(()=>{const label=t.slice(1,t.indexOf(']')),href=t.slice(t.indexOf('(')+1,-1);out.push(/^(\/|https:\/\/)/.test(href)?<a key={k++} href={href} {...(href.startsWith('/downloads/')?{download:true}:{})}>{label}</a>:label);})();
  else out.push(<em key={k++}>{t.slice(1,-1)}</em>);
  last=m.index+t.length;}
 if(last<text.length)out.push(text.slice(last));return out;
}
function Markdown({text}:{text:string}){
 const lines=text.split('\n'),blocks:ReactNode[]=[];let i=0,k=0;
 while(i<lines.length){const line=lines[i]!;
  if(line.startsWith('```')){const code:string[]=[];i++;while(i<lines.length&&!lines[i]!.startsWith('```'))code.push(lines[i++]!);i++;blocks.push(<pre key={k++} className="help-code"><code>{code.join('\n')}</code></pre>);continue;}
  if(/^\s*\|/.test(line)){const rows:string[][]=[];while(i<lines.length&&/^\s*\|/.test(lines[i]!)){const cells=lines[i]!.trim().slice(1,-1).split('|').map(c=>c.trim());if(!cells.every(c=>/^-+$/.test(c)))rows.push(cells);i++;}
   blocks.push(<table key={k++} className="help-table"><thead><tr>{rows[0]!.map((c,j)=><th key={j}>{inline(c)}</th>)}</tr></thead><tbody>{rows.slice(1).map((r,j)=><tr key={j}>{r.map((c,x)=><td key={x}>{inline(c)}</td>)}</tr>)}</tbody></table>);continue;}
  const item=/^(\s*)(\d+\.|-)\s+(.*)$/.exec(line);
  if(item){const ordered=item[2]!.endsWith('.'),items:{text:string;children:string[]}[]=[];
   while(i<lines.length){const m=/^(\s*)(\d+\.|-)\s+(.*)$/.exec(lines[i]!);
    if(m&&m[1]!.length===0&&(m[2]!.endsWith('.'))===ordered){items.push({text:m[3]!,children:[]});i++;continue;}
    if(items.length&&(/^\s{2,}\S/.test(lines[i]!)||lines[i]===''&&/^\s{2,}\S/.test(lines[i+1]??''))){items.at(-1)!.children.push(lines[i]!.replace(/^\s{2,3}/,''));i++;continue;}
    break;}
   const List=ordered?'ol':'ul';
   blocks.push(<List key={k++}>{items.map((it,j)=><li key={j}>{inline(it.text)}{it.children.length>0&&<Markdown text={it.children.join('\n')}/>}</li>)}</List>);continue;}
  if(line.trim()===''){i++;continue;}
  const para:string[]=[];while(i<lines.length&&lines[i]!.trim()!==''&&!/^(\s*)(\d+\.|-)\s+/.test(lines[i]!)&&!lines[i]!.startsWith('```')&&!/^\s*\|/.test(lines[i]!))para.push(lines[i++]!);
  blocks.push(<p key={k++}>{para.map((p,j)=><Fragment key={j}>{j>0&&<br/>}{inline(p)}</Fragment>)}</p>);
 }
 return <>{blocks}</>;
}
export function Help(){
 const [open,setOpen]=useState<string>(()=>{try{const h=window.location.hash.slice(1);return helpSections.some(s=>s.id===h)?h:'empezar';}catch{return 'empezar';}});
 function download(){const url=URL.createObjectURL(new Blob([helpMarkdown()],{type:'text/markdown;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`ayuda-commerce-os-${HELP_VERSION}.md`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
 return <>
  <PageHeader title="Ayuda" description={`Versión ${HELP_VERSION}. La misma guía está disponible por la API y por el conector MCP.`} actions={<Button variant="secondary" onClick={download}><Download aria-hidden="true"/>Descargar guía</Button>}/>
  <div className="layout-side">
   <nav aria-label="Temas de ayuda" className="help-nav"><ul>{helpSections.map(s=><li key={s.id}><a href={`#${s.id}`} aria-current={open===s.id?'true':undefined} onClick={()=>setOpen(s.id)}>{s.title}</a></li>)}</ul></nav>
   <div className="stack">{helpSections.map(s=><details key={s.id} id={s.id} className="disclosure" open={open===s.id} onToggle={e=>{if((e.target as HTMLDetailsElement).open)setOpen(s.id);}}>
    <summary><span className="help-summary"><strong>{s.title}</strong><span className="muted text-sm">{s.summary}</span></span></summary><div className="disclosure-body help-body"><Markdown text={s.body}/></div></details>)}</div>
  </div>
 </>;
}
