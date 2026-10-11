const stages = new Set(['cold','escala','prospectar','prospeccion','retargeting','rtg','scale','test','validacion','ventas','warm']);
export const normalizeProductLabel = (value:string) => value.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().replace(/\s+/g,' ').toLowerCase();

/** A display label from the WA convention, never evidence of catalog identity or sale origin. */
export function extractCampaignProduct(name:string):string|null {
  const parts=name.split('|').map(s=>s.trim());
  if(normalizeProductLabel(parts[0]??'')!=='wa'||parts.length<2)return null;
  const index=stages.has(normalizeProductLabel(parts[1]??''))?2:1;
  const label=parts[index];
  return label&&label.length<=160&&!stages.has(normalizeProductLabel(label))?label:null;
}

// Reviewed legacy display alias; do not generalize prefix matching to catalog identity.
const explicitAliases:Record<string,string>={'costura':'costura que vende'};
export function campaignProductLabels(names:string[]) {
  const labels=new Map<string,string>();
  for(const name of names){const label=extractCampaignProduct(name);if(label){const key=normalizeProductLabel(label),old=labels.get(key);if(!old||label.localeCompare(old,'es')<0)labels.set(key,label);}}
  const aliases=new Map<string,{key:string;label:string;source:'CAMPAIGN_NAME'}>();
  for(const[key,label]of labels){const extensions=[...labels.keys()].filter(other=>other.startsWith(key+' '));const target=explicitAliases[key],canonical=target&&labels.has(target)&&extensions.length===1&&extensions[0]===target?target:key;aliases.set(key,{key:canonical,label:labels.get(canonical)??label,source:'CAMPAIGN_NAME'});}
  return names.map(name=>{const raw=extractCampaignProduct(name);return raw?aliases.get(normalizeProductLabel(raw))??null:null;});
}

export function exactCatalogCandidate(label:string|null,products:{id:string;name:string|null}[]) {
  const matches=label?products.filter(p=>p.name&&normalizeProductLabel(p.name)===normalizeProductLabel(label)):[];
  return {status:matches.length===1?'EXACT_NAME_CANDIDATE':matches.length>1?'AMBIGUOUS':'UNASSIGNED',candidate_product_id:matches.length===1?matches[0]!.id:null} as const;
}
