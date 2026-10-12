import {z} from 'zod';
import type {ProfileScope} from './profiles.js';

export const profileCatalogResources={
 categories:{kind:'category',scope:'collections:read'},
 products:{kind:'product',scope:'products:read'},
 offers:{kind:'offer',scope:'offers:read'},
 materials:{kind:'asset',scope:'materials:read'},
 flows:{kind:'workflow',scope:'flows:read'},
 sellers:{kind:'agent',scope:'sellers:read'},
} as const satisfies Record<string,{kind:string;scope:ProfileScope}>;
export type ProfileCatalogKind=typeof profileCatalogResources[keyof typeof profileCatalogResources]['kind'];
const environment=z.enum(['REAL','SIMULATION']).default('REAL');
const page=z.coerce.number().int().min(1).max(100).default(50);
export const profileCatalogListSchema=z.object({environment,limit:page,
 offset:z.coerce.number().int().min(0).max(10000).default(0),
 q:z.string().trim().min(1).max(160).optional(),
 include_archived:z.enum(['true','false']).default('false'),
 status:z.string().min(1).max(80).optional(),
}).strict();
export const profileCatalogDetailQuerySchema=z.object({environment}).strict();
export const profileCatalogVersionsQuerySchema=z.object({environment,limit:page,
 before:z.coerce.number().int().positive().max(2147483647).optional(),
}).strict();
export const profileCatalogIdSchema=z.object({id:z.uuid()}).strict();
export type ProfileCatalogList=z.infer<typeof profileCatalogListSchema>;
export type ProfileCatalogVersions=z.infer<typeof profileCatalogVersionsQuerySchema>;
