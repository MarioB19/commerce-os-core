-- PostgreSQL requires UPDATE privilege on every relation locked by FOR SHARE.
-- The channel worker locks the attempt and its parent cycle together while it
-- revalidates dispatch eligibility, but it must not mutate commercial state.
-- Granting only the immutable primary key preserves that boundary while
-- allowing the joined row lock used by the runtime.
GRANT UPDATE(id) ON commercial_remarketing_cycles TO commerce_channel;
