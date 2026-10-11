"""Pure input checks shared with local transport tests; no credentials are loaded."""
import json
import re
AUTH='363c24edb04448cec2f9b041320ae9f24790cb98d1d7d9f3b4d07e4081dbc1cb'
SCOPES={'products:read','products:write','products:publish','offers:read','offers:write','offers:publish','workflows:read','workflows:draft','workflows:publish','simulations:run','assets:read','assets:write','sales:read','sales:propose','channels:read','commands:read','warmup:read','warmup:manage','assignments:read','assignments:write','integrations:read','integrations:write','integrations:verify','assistant:read','assistant:propose','reports:read','intelligence:read','intelligence:write','intelligence:analyze','intelligence:refresh'}
# Only these fixed diagnostic codes may cross the administrative transport.
# Never return child output, arbitrary uppercase strings, exception messages or JSON details.
REMOTE_FAILURE_CODES=frozenset({
    'PRIVATE_INPUT_REQUIRED','PRIVATE_REQUEST_OR_RECIPIENT_DRIFT','ACTION_NOT_ALLOWED',
    'SOURCE_AND_RUN_REQUIRED','V5_AUTHORIZATION_REQUIRED','OPERATION_ID_REQUIRED',
    'OPERATIONAL_GRANT_FORBIDDEN','EXPLICIT_ARGUMENTS_REQUIRED','PUBLIC_KEY_REQUIRED',
    'EXISTING_INSTALLATION_REQUIRED','DEPLOYED_SHA_MISMATCH','SEALED_IMAGE_REQUIRED',
    'SEALED_IMAGE_LAYERS_REQUIRED','INSTALLED_IMAGE_REQUIRED','INSTALLED_IMAGE_INSPECTION_INVALID',
    'INSTALLED_IMAGE_PLATFORM_MISMATCH','INSTALLED_IMAGE_LAYERS_MISMATCH','PRIVATE_DIRECTORY_REQUIRED',
    'V5_IMAGE_INSPECT_FAILED','V5_IMAGE_INSPECT_TIMEOUT',
    'V5_RECIPIENT_VALIDATION_FAILED','V5_RECIPIENT_VALIDATION_TIMEOUT',
    'V5_ISSUER_EXECUTION_FAILED','V5_ISSUER_EXECUTION_TIMEOUT','V5_ISSUER_RESPONSE_INVALID',
    'V5_RECEIPT_ENCRYPTION_FAILED','V5_RECEIPT_ENCRYPTION_TIMEOUT','V5_REMOTE_TASK_FAILED',
    'V5_PRIVATE_FILE_REQUIRED','V5_PRIVATE_DIRECTORY_REQUIRED','V5_LEDGER_CONFLICT',
    'V5_TOKEN_DRIFT','V5_ACTIVE_OWNER_MATCH_REQUIRED','V5_REQUEST_DRIFT',
    'V5_EXPIRY_MAX_SEVEN_DAYS','V5_PRIVATE_LEDGER_REQUIRED','V5_TOKEN_REVOKED',
    'V5_TOKEN_FILE_CONFLICT','V5_READBACK_REQUIRED','V5_TOKEN_NOT_FOUND',
    'V5_ACTION_REQUIRED','V5_EXPLICIT_ARGUMENTS_REQUIRED','V5_CREDENTIAL_OPERATION_FAILED',
    'V5_RSA_PUBLIC_KEY_REQUIRED','V5_RSA_MINIMUM_3072_BITS','V5_ENVELOPE_INVALID',
    'V5_ENVELOPE_ARGUMENTS_REQUIRED','V5_TOKEN_INVALID','V5_ENVELOPE_ACTION_REQUIRED','V5_ENVELOPE_FAILED',
})
REMOTE_FAILURE_STAGES=frozenset({'request','image','validation','issuer','encryption'})
class StagedFailure(RuntimeError):
    def __init__(self,code,stage):
        super().__init__(code);self.stage=stage
def safe_remote_failure(output):
    if not isinstance(output,str) or len(output)>65536:return None
    failures=[]
    for line in output.splitlines():
        if len(line)>1024:continue
        try:value=json.loads(line)
        except (ValueError,TypeError):continue
        if not isinstance(value,dict) or set(value) not in ({'status','code'},{'status','code','stage'}):continue
        if value['status']!='FAILED' or not isinstance(value['code'],str) or value['code'] not in REMOTE_FAILURE_CODES:continue
        if 'stage' in value and (not isinstance(value['stage'],str) or value['stage'] not in REMOTE_FAILURE_STAGES):continue
        failures.append({key:value[key] for key in ['code','stage'] if key in value})
    return failures[0] if len(failures)==1 else None
def validate_transport(env):
    def need(value,code):
        if not value:raise RuntimeError(code)
    need(env.get('GITHUB_EVENT_NAME')=='workflow_dispatch' and env.get('V5_MODE')=='credential','EXPLICIT_CREDENTIAL_DISPATCH_REQUIRED')
    need(env.get('GITHUB_WORKFLOW_REF')=='MarioB19/commerce-os/.github/workflows/ci.yml@refs/heads/main','EXISTING_OIDC_WORKFLOW_REQUIRED')
    need(env.get('GITHUB_REF')=='refs/heads/main' and env.get('GITHUB_REPOSITORY')=='MarioB19/commerce-os','MAIN_REPOSITORY_REQUIRED')
    sha=env.get('V5_EXPECTED_SHA','');need(re.fullmatch('[a-f0-9]{40}',sha) and sha==env.get('GITHUB_SHA'),'EXACT_MAIN_SHA_REQUIRED')
    need((env.get('GCP_PROJECT_ID'),env.get('GCP_INSTANCE'),env.get('GCP_ZONE'))==('vibe-conversa-prod','vibe-conversa-prod','us-east1-d'),'EXISTING_TARGET_REQUIRED')
    action=env.get('V5_ACTION');need(action in ('inspect','issue','readback','revoke'),'FIXED_ACTION_REQUIRED')
    run_id=env.get('GITHUB_RUN_ID','')+'-'+env.get('GITHUB_RUN_ATTEMPT','');need(re.fullmatch('[0-9]+-[0-9]+',run_id),'RUN_REQUIRED')
    data=json.loads(env['V5_INPUT_JSON']);need(data.get('authorization_sha256')==AUTH,'CURRENT_V5_AUTHORIZATION_REQUIRED')
    need(set(data)=={'schema_version','operation_id','workspace_id','owner_email_sha256','authorization_sha256','scopes','allowed_environments','resource_ids','expires_at','reason'},'REVIEWED_INPUT_KEYS_REQUIRED')
    need(re.fullmatch('[a-f0-9]{64}',data.get('owner_email_sha256','')),'OWNER_HASH_REQUIRED')
    need(re.fullmatch('[a-f0-9-]{36}',data.get('operation_id','')),'OPERATION_ID_REQUIRED')
    need(data.get('scopes') and set(data['scopes'])<=SCOPES,'OPERATIONAL_GRANT_FORBIDDEN')
    public=env.get('V5_RETURN_PUBLIC_KEY','');need(public.startswith('-----BEGIN PUBLIC KEY-----') and 'PRIVATE KEY' not in public and len(public)<10000,'PUBLIC_KEY_ONLY')
    return{'sha':sha,'action':action,'run_id':run_id,'input':data,'public_key':public}
