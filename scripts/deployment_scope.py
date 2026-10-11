"""Closed publication selection; importing this module performs no I/O."""
from ci_release import require

LEGACY_TARGET = ('vibe-conversa-prod', 'vibe-conversa-prod', 'us-east1-d')
COPY_TARGET = ('project-c6f43813-9ac9-47ab-9fe', 'commerce-os-test', 'us-east1-d')
SCOPES = {'api-web', 'full', 'portal-copy', 'copy-runtime'}
NO_PORTAL = '@not-selected'


def deployment_scope(env):
    target = tuple(env.get(key) for key in ('GCP_PROJECT_ID', 'GCP_INSTANCE', 'GCP_ZONE'))
    require(target in (LEGACY_TARGET, COPY_TARGET), 'UNEXPECTED_DEPLOY_TARGET')
    value = env.get('COMMERCE_DEPLOY_SCOPE', '')
    if not value and target == LEGACY_TARGET:
        value = 'full'
    require(value in SCOPES, 'EXPLICIT_DEPLOYMENT_SCOPE_REQUIRED')
    # A future full transition on the copy needs a separately reviewed receipt
    # and reconciliation. A repository variable cannot authorize that transition.
    require(target != COPY_TARGET or value in {'api-web','portal-copy','copy-runtime'}, 'COPY_FULL_TRANSITION_NOT_APPROVED')
    require(value != 'portal-copy' or target == COPY_TARGET, 'COPY_PORTAL_TARGET_REQUIRED')
    require(value != 'copy-runtime' or target == COPY_TARGET, 'COPY_RUNTIME_TARGET_REQUIRED')
    return value
