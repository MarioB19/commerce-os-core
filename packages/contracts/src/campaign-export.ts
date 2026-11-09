/** Export the report projection unchanged. All surfaces use this formatter;
 * amounts remain integer minor units, unknowns remain empty cells. */
export function campaignCsv(report:{filters:{currency:string;from:string;to:string};groups:Record<string,Record<string,any>[]>}){
 const fields=['level','id','name','portfolio_id','meta_ad_account_id','currency','timezone','from','to','spend_minor','net_spend_observed_minor','impressions','clicks_all','conversations','ctr','cpc_minor','cpm_minor','cost_per_meta_conversation_minor','attributed_sales','attributed_revenue_minor','roas','cpa_minor','quality','spend_source','revenue_source'];
 const groups=[['portfolio','portfolios'],['account','accounts'],['campaign','campaigns'],['ad','ads']] as const;
 const cell=(value:unknown)=>{const text=String(value??'');return '"'+(/^[\s]*[=+@-]/.test(text)?"'"+text:text).replaceAll('"','""')+'"';};
 const rows=groups.flatMap(([level,key])=>(report.groups[key]??[]).map(row=>({level,...row,clicks_all:row.clicks,currency:report.filters.currency,from:report.filters.from,to:report.filters.to,quality:row.quality?.status??'',spend_source:'META_API',revenue_source:'COMMERCE_APPROVED_PAYMENTS'})));
 return [fields.join(','),...rows.map(row=>fields.map(field=>cell((row as Record<string,unknown>)[field])).join(','))].join('\r\n');
}
