import {isAbsolute,relative,resolve} from 'node:path';

/** Vitest owns file selection; this function only partitions that exact set. */
export function integrationTestGroups(root:string,entries:unknown):string[][]{
 if(!Array.isArray(entries)||entries.length===0)throw new Error('INTEGRATION_TEST_SELECTION_EMPTY');
 const files=entries.map(entry=>{
  if(!entry||typeof entry!=='object'||Object.keys(entry).some(k=>k!=='file')||typeof entry.file!=='string')throw new Error('INTEGRATION_TEST_SELECTION_INVALID');
  const name=relative(resolve(root),resolve(root,entry.file)).split('\\').join('/');
  if(isAbsolute(name)||!/^tests\/integration\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.test\.ts$/.test(name))throw new Error('INTEGRATION_TEST_PATH_INVALID');
  return name;
 }).sort();
 if(new Set(files).size!==files.length)throw new Error('INTEGRATION_TEST_DUPLICATE');
 const additiveTransitions=new Set(['tests/integration/continuous-authorization.test.ts','tests/integration/market-variants.test.ts','tests/integration/expired-effects.test.ts']);
 const scoped=files.filter(file=>/^tests\/integration\/profile-[^/]+\.test\.ts$/.test(file)||additiveTransitions.has(file));
 const calendar:string[]=files.filter(file=>file==='tests/integration/numbers-mcp-stdio.test.ts');
 const ordinary=files.filter(file=>!scoped.includes(file)&&!calendar.includes(file));
 const groups=[...(ordinary.length?[ordinary]:[]),...scoped.map(file=>[file]),...calendar.map(file=>[file])];
 const actual=groups.flat().sort();
 if(actual.length!==files.length||actual.some((file,i)=>file!==files[i]))throw new Error('INTEGRATION_TEST_PARTITION_INVALID');
 return groups;
}

/** Keep the caller's native filters; exclude only selected files owned by other
 * groups. Adding group names as filters would accidentally widen selection.
 */
export function integrationGroupArgs(original:readonly string[],groups:readonly string[][],group:readonly string[]):string[]{
 if(!groups.some(entry=>entry.length===group.length&&entry.every((file,i)=>file===group[i])))throw new Error('INTEGRATION_TEST_GROUP_UNKNOWN');
 return[...original,...groups.flat().filter(file=>!group.includes(file)).flatMap(file=>['--exclude',file])];
}
