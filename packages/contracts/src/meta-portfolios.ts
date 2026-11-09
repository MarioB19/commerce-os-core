import {z} from 'zod';
export const metaPortfolioLimit=5;
export const metaBusinessId=z.string().regex(/^\d{1,40}$/);
export const metaAccountId=z.string().regex(/^act_\d{1,40}$/);
export const metaDay=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s,'Fecha no válida');
export const metaReadFilter=z.object({portfolio_id:metaBusinessId.optional(),meta_ad_account_id:metaAccountId.optional()}).strict();
export const metaSyncInput=metaReadFilter.extend({operationId:z.uuid(),from:metaDay.optional(),to:metaDay.optional()}).strict()
 .refine(x=>Boolean(x.from)===Boolean(x.to),'Indica ambas fechas').refine(x=>!x.from||x.from<=x.to!,'Periodo no válido')
 .refine(x=>!x.from||(Date.parse(x.to!)-Date.parse(x.from))/86400000<90,'Máximo 90 días por solicitud');
export type MetaSyncInput=z.infer<typeof metaSyncInput>;
export interface MetaConnectionView{id:string;alias:string;revision:number;enabled:boolean;state:string;hint:string|null;reason:string|null;checkedAt:string|null;grantedScopes:string[];legacy:boolean}
export interface MetaPortfolioView{id:string;name:string;selected:boolean;version:number;observedAt:string;accounts:number;accessibleAccounts:number}
export interface MetaAccountView{id:string;name:string;portfolioId:string|null;portfolioName:string|null;currency:string;timezone:string;accessible:boolean;included:boolean;status:string;lastSuccessAt:string|null;coveredDays:number;historyDays:number;pendingTasks:number;failedTasks:number;ownerBasis:string|null}
export interface MetaOperationView{id:string;status:string;createdAt:string;updatedAt:string;total:number;completed:number;failed:number;pending:number;issues:string[]}
export interface MetaInventoryView{connections:MetaConnectionView[];portfolios:MetaPortfolioView[];accounts:MetaAccountView[];operations:MetaOperationView[];limit:number;counts:{discoveredPortfolios:number;selectedPortfolios:number;storedAccounts:number;accessibleAccounts:number;includedAccounts:number;syncedAccounts:number}}
