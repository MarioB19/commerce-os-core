import {z} from 'zod';

// No defaults on individual fields: partial updates must preserve omitted fields.
export const operationalSettingsSchema=z.object({
  dispatch_frozen:z.boolean(),
  real_sends_enabled:z.boolean(),
  allow_real_operations:z.boolean(),
  allow_channel_onboarding:z.boolean(),
  contact_messages_per_minute:z.number().int().min(1).max(60),
  channel_account_concurrency:z.number().int().min(1).max(10),
}).strict();
export type OperationalSettings=z.infer<typeof operationalSettingsSchema>;
export const defaultOperationalSettings:Readonly<OperationalSettings>=Object.freeze({
  dispatch_frozen:true,real_sends_enabled:false,allow_real_operations:false,
  allow_channel_onboarding:false,contact_messages_per_minute:10,channel_account_concurrency:5,
});
export const operationalSettingsPatchSchema=z.object({
  expected_version:z.number().int().min(0),reason:z.string().trim().min(3).max(2000),
  changes:operationalSettingsSchema.partial().refine(value=>Object.keys(value).length>0,'At least one setting is required'),
}).strict();
