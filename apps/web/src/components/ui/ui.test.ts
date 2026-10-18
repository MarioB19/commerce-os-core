import {describe,expect,it} from 'vitest';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Button,ButtonLink} from './button';
import {Input} from './input';
import {Textarea} from './textarea';
import {NativeSelect,Select} from './select';
import {Checkbox,NativeCheck} from './checkbox';
import {Field,ErrorSummary} from './field';
import {Card,CardHead} from './card';
import {Badge,toneOf} from './badge';
import {Table,TableWrap,SortableTh} from './table';
import {Segmented} from './segmented';
import {LinkTabs} from './tabs';
import {Skeleton} from './skeleton';
import {EmptyState,ErrorState} from './empty-state';
import {PageHeader} from './page-header';
import {Progress} from './progress';
import {Alert} from './alert';
import {Kpi} from './kpi';

/** Minimal render + accessibility contract per primitive (no DOM: static
 * markup). The live accessibility audit (axe, keyboard) runs in tests/e2e. */
const render=(el:Parameters<typeof renderToStaticMarkup>[0])=>renderToStaticMarkup(el);

describe('ui primitives',()=>{
 it('button keeps data-variant (one primary per page) and loading disables it',()=>{
  expect(render(h(Button,null,'Guardar'))).toContain('data-variant="default"');
  expect(render(h(Button,{variant:'secondary'},'Cancelar'))).toContain('data-variant="secondary"');
  const loading=render(h(Button,{loading:true},'Guardando'));
  expect(loading).toContain('disabled');expect(loading).toContain('aria-busy="true"');expect(loading).toContain('class="spinner"');
  expect(render(h(ButtonLink,{href:'/products'},'Abrir'))).toMatch(/<a [^>]*data-variant="default"[^>]*href="\/products"/);
 });
 it('controls carry the token classes and accept aria attributes',()=>{
  expect(render(h(Input,{'aria-label':'Nombre'}))).toContain('class="input"');
  expect(render(h(Textarea,{'aria-label':'Texto'}))).toContain('class="textarea"');
  expect(render(h(NativeSelect,{'aria-label':'Moneda'},h('option',{value:'MXN'},'MXN')))).toContain('class="select-native"');
  expect(render(h(Select,{value:'7',onValueChange:()=>undefined,options:[{value:'7',label:'7 días'}],'aria-label':'Periodo'}))).toContain('aria-label="Periodo"');
 });
 it('checkbox has a permanent label bound to the control',()=>{
  const out=render(h(Checkbox,{id:'c1',checked:true,onCheckedChange:()=>undefined,label:'Activo',description:'Se aplica al publicar'}));
  expect(out).toContain('for="c1"');expect(out).toContain('id="c1"');expect(out).toContain('aria-checked="true"');expect(out).toContain('Se aplica al publicar');
  expect(render(h(NativeCheck,{label:'Enlace',type:'radio'}))).toMatch(/<input type="radio" class="native"/);
 });
 it('field links label, help and error to the control',()=>{
  const out=render(h(Field,{label:'Precio',help:'Se muestra al cliente',error:'Escribe un precio válido.',id:'price',children:h(Input,{inputMode:'decimal'})}));
  expect(out).toContain('for="price"');expect(out).toContain('id="price"');expect(out).toContain('aria-describedby="price-help price-error"');expect(out).toContain('aria-invalid="true"');expect(out).toContain('role="alert"');
  const summary=render(h(ErrorSummary,{errors:[{id:'price',message:'Precio: escribe un número.'}]}));
  expect(summary).toContain('role="alert"');expect(summary).toContain('href="#price"');
 });
 it('badge shows icon + text + colour and maps API codes to tones',()=>{
  const out=render(h(Badge,{tone:'success'},'Vendiendo'));
  expect(out).toContain('data-tone="success"');expect(out).toContain('<svg');expect(out).toContain('Vendiendo');
  expect(toneOf('SELLING')).toBe('success');expect(toneOf('NEEDS_QR')).toBe('warn');expect(toneOf('REJECTED')).toBe('error');expect(toneOf('READY_TO_ASSIGN')).toBe('info');expect(toneOf('X')).toBe('neutral');
 });
 it('table has a scroll region, scoped headers and aria-sort',()=>{
  const out=render(h(TableWrap,{label:'Productos',children:h(Table,null,h('thead',null,h('tr',null,h(SortableTh,{active:true,direction:'asc',onSort:()=>undefined},'Nombre'))),h('tbody',null,h('tr',null,h('td',null,'A'))))}));
  expect(out).toContain('role="region"');expect(out).toContain('aria-label="Productos"');expect(out).toContain('scope="col"');expect(out).toContain('aria-sort="ascending"');expect(out).toContain('class="table stack-mobile"');
 });
 it('segmented and link tabs expose the selected item',()=>{
  const seg=render(h(Segmented,{value:'all',onChange:()=>undefined,label:'Estado',options:[{value:'all',label:'Todos',count:3},{value:'selling',label:'Vendiendo'}]}));
  expect(seg).toContain('role="group"');expect(seg).toContain('aria-pressed="true"');expect(seg).toContain('aria-pressed="false"');
  const tabs=render(h(LinkTabs,{label:'Ventas',current:'/sales/orders',items:[{href:'/sales/inbox',label:'Conversaciones'},{href:'/sales/orders',label:'Pedidos'}]}));
  expect(tabs).toContain('aria-label="Ventas"');expect(tabs).toContain('href="/sales/orders" aria-current="page"');
 });
 it('skeleton, empty and error states announce themselves',()=>{
  expect(render(h(Skeleton,{lines:2}))).toContain('role="status"');
  expect(render(h(EmptyState,{title:'Crea tu primer producto',description:'En 15 minutos.',action:h(Button,null,'Crear producto')}))).toContain('<h2>Crea tu primer producto</h2>');
  const err=render(h(ErrorState,{message:'No pudimos conectar.',onRetry:()=>undefined}));
  expect(err).toContain('role="alert"');expect(err).toContain('Reintentar');
 });
 it('page header, card, progress, alert and kpi render their structure',()=>{
  expect(render(h(PageHeader,{title:'Productos',description:'Un producto, varios mercados.',actions:h(Button,null,'Crear producto')}))).toContain('<h1 id="page-title">Productos</h1>');
  expect(render(h(Card,{'aria-labelledby':'x'},h(CardHead,{title:'Resumen',id:'x'})))).toContain('<section class="card" aria-labelledby="x"><div class="card-head"><div><h2 id="x">Resumen</h2></div></div></section>');
  const bar=render(h(Progress,{value:3,max:10,label:'Meta del mes',valueText:'30 %'}));
  expect(bar).toContain('role="progressbar"');expect(bar).toContain('aria-valuenow="3"');expect(bar).toContain('aria-valuetext="30 %"');expect(bar).toContain('width:30%');
  expect(render(h(Alert,{tone:'error',title:'No se pudo guardar.'},'Revisa el precio.'))).toContain('role="alert"');
  expect(render(h(Alert,{tone:'success'},'Guardado.'))).toContain('role="status"');
  const kpi=render(h(Kpi,{label:'Ingresos',value:'$1,200',delta:{text:'▲ 12 %',tone:'good'},before:'$1,000'}));
  expect(kpi).toContain('kpi-value');expect(kpi).toContain('data-tone="good"');expect(kpi).toContain('antes $1,000');
  expect(render(h(Kpi,{label:'ROAS',value:'Sin gasto de anuncios conectado',missing:true}))).toContain('kpi-value missing');
 });
});
