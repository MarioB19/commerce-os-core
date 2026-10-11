# Portal installation on the recovered proxy network

The portal installer used `vibe-conversa_default` for discovery and its container.
The isolated recovered copy preserves a separate internal proxy and an external
edge. Creating the old network or attaching Caddy to it would change that boundary.

Keep the legacy network as the default. An explicit `proxy_network` override
requires the migration boolean, a bridge network with `Internal=true` and
`EnableIPv6=false`, and an actual Caddy membership read before the portal is
created. Reject malformed/reserved network names before private input or Docker
commands. The caller must supply the network from the guarded recovered release;
the installer never creates a network or changes Caddy's membership.

Use the selected network in discovery and container startup, and include its name
in the portal receipt. Preserve PDF hashes, access scopes, environment validation,
other containers, guarded proxy update and rollback.

This option is a prerequisite for the compatible portal transition. The current
API/web adoption still requires four containers and unchanged proxy configuration.
Do not install a fifth container manually, select full, or remove adoption state
with this patch. Extend and verify the runtime/B02 contract before initial portal
installation; HTTPS, historical code access and physical delivery remain separate
checks. Public contacts can remain explicitly deferred under the previous ADR.
