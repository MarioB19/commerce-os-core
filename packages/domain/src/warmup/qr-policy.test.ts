import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {systemQrContents,systemQrProfile,QR_LIBRARY_SHA256} from './qr-policy.js';
import {dailyBudget,warmupContentSchema,warmupPolicy} from './policy.js';
import {stableJson} from '../../../db/src/index.js';

describe('fixed own-number operational policy',()=>{
 it('uses v2 without manual declarations or invented provider metadata',()=>{
  const profile=systemQrProfile('America/Mexico_City');
  expect(profile.policy_version).toBe('standard-15d/v2');expect(warmupPolicy(profile).requires_manual).toBe(false);
  expect(Object.keys(profile)).not.toContain('profile_verified_at');expect(()=>systemQrProfile('not-a-zone')).toThrow();
 });
 it('contains twelve immutable, explicit internal text exchanges',()=>{
  expect(systemQrContents).toHaveLength(12);expect(new Set(systemQrContents.map(c=>c.content_hash)).size).toBe(12);
  for(const content of systemQrContents){expect(warmupContentSchema.parse(content.body)).toEqual(content.body);expect(content.body.turns).toHaveLength(6);
   expect(Object.isFrozen(content)).toBe(true);expect(Object.isFrozen(content.body.turns)).toBe(true);
   expect(content.content_hash).toBe(createHash('sha256').update(stableJson(content.body)).digest('hex'));
   for(const turn of content.body.turns){expect(turn.kind).toBe('text');expect(Object.isFrozen(turn)).toBe(true);}
  }
 });
 it('fits unchanged v2 budgets including weekend and late-stage minimums',()=>{
  const profile=systemQrProfile('UTC');
  for(const day of [1,8,11,14])for(const date of ['2026-10-12T10:00:00Z','2026-10-11T10:00:00Z']){
   const b=dailyBudget(profile,day,new Date(date)),n=Math.max(Math.ceil(b.min_messages/6),b.min_conversations);
   expect(n*6).toBeLessThanOrEqual(b.max_messages);expect(n).toBeLessThanOrEqual(b.max_conversations);expect(n).toBeLessThanOrEqual(12);
  }
 });
 it('pins the SQL system library to the same canonical content',()=>{
  const sql=readFileSync(new URL('../../../db/profile-transition/015_auto_qr_warmup.sql',import.meta.url),'utf8');
  const match=/\$library\$(.*?)\$library\$/s.exec(sql);expect(match).not.toBeNull();
  expect(JSON.parse(match![1])).toEqual(systemQrContents);
  expect(createHash('sha256').update(stableJson(systemQrContents)).digest('hex')).toBe(QR_LIBRARY_SHA256);
  expect(sql).toContain('-- library sha256 '+QR_LIBRARY_SHA256);
 });
});
