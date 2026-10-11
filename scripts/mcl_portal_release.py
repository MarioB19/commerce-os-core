"""Narrow portal deployment contracts; pure validation is exercised without a VPS."""
import importlib.util
import re
from pathlib import Path
from ci_release import require

spec=importlib.util.spec_from_file_location('identity_proxy',Path(__file__).with_name('update-identity-proxy.py'))
proxy=importlib.util.module_from_spec(spec);spec.loader.exec_module(proxy)
HOST=b'ciclo.inovaris.online'
LEGACY_PROXY_NETWORK='vibe-conversa_default'
MIGRATION_MAINTENANCE_BLOCK=('ciclo.inovaris.online {\n'
    '  # managed-mi-ciclo-listo-maintenance-20261006\n'
    '  header {\n'
    '    Retry-After "300"\n'
    '    Cache-Control "no-store"\n'
    '    Content-Type "text/plain; charset=utf-8"\n'
    '    X-Robots-Tag "noindex"\n'
    '    -Server\n'
    '  }\n'
    '  respond "Mi Ciclo Listo está temporalmente en mantenimiento. Inténtalo más tarde." 503\n'
    '}').encode('utf-8')


def portal_network_name(name,*,allow_migration_maintenance=False):
    require(type(allow_migration_maintenance) is bool,'PORTAL_MIGRATION_OPTION_INVALID')
    require(isinstance(name,str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,127}',name)
            and name not in {'host','none','bridge'},'PORTAL_PROXY_NETWORK_INVALID')
    require(name==LEGACY_PROXY_NETWORK or allow_migration_maintenance,
            'PORTAL_NETWORK_MIGRATION_REQUIRED')
    return name


def verify_portal_network(name,network_rows,caddy_networks,*,allow_migration_maintenance=False):
    """Validate existing wiring only; never create or attach a network."""
    portal_network_name(name,allow_migration_maintenance=allow_migration_maintenance)
    require(isinstance(network_rows,list) and len(network_rows)==1
            and isinstance(network_rows[0],dict)
            and network_rows[0].get('Name')==name
            and network_rows[0].get('Driver')=='bridge','PORTAL_PROXY_NETWORK_MISMATCH')
    require(isinstance(caddy_networks,dict) and isinstance(caddy_networks.get(name),dict),
            'PORTAL_PROXY_NOT_ON_SELECTED_NETWORK')
    if name!=LEGACY_PROXY_NETWORK:
        require(network_rows[0].get('Internal') is True
                and network_rows[0].get('EnableIPv6') is False,
                'PORTAL_COPY_PROXY_ISOLATION_REQUIRED')
    return name


def portal_env(raw,sha,*,require_legal_fields=False):
    require(type(require_legal_fields) is bool,'PORTAL_MIGRATION_OPTION_INVALID')
    require(re.fullmatch(r'[a-f0-9]{40}',sha),'PORTAL_SOURCE_SHA_INVALID')
    rows=raw.splitlines(); data={}
    allowed={'MCL_SESSION_SECRET','MCL_CORE_CODES_SHA256','MCL_KIT_CODES_SHA256','MCL_SUPPORT_EMAIL','MCL_PRIVACY_NAME','MCL_PRIVACY_ADDRESS','MCL_PRIVACY_EMAIL','NEXT_PUBLIC_SITE_URL'}
    for row in rows:
        if not row or row.startswith('#'):continue
        key,separator,value=row.partition('=')
        require(separator and key in allowed and key not in data and not any(c in value for c in '\x00\r\n'),'PORTAL_ENV_INVALID')
        data[key]=value
    require(re.fullmatch(r'[a-f0-9]{64}',data.get('MCL_SESSION_SECRET','')),'PORTAL_SESSION_SECRET_INVALID')
    for key in ['MCL_CORE_CODES_SHA256','MCL_KIT_CODES_SHA256']:
        require(re.fullmatch(r'[a-f0-9]{64}(,[a-f0-9]{64})*',data.get(key,'')),'PORTAL_CODE_HASH_INVALID')
    require(not set(data['MCL_CORE_CODES_SHA256'].split(','))&set(data['MCL_KIT_CODES_SHA256'].split(',')),'PORTAL_SCOPES_OVERLAP')
    require(data.get('NEXT_PUBLIC_SITE_URL')=='https://ciclo.inovaris.online','PORTAL_ORIGIN_INVALID')
    if require_legal_fields:
        for key in ('MCL_SUPPORT_EMAIL','MCL_PRIVACY_NAME','MCL_PRIVACY_ADDRESS','MCL_PRIVACY_EMAIL'):
            value=data.get(key,'').strip()
            require(bool(value) and value.upper() not in {'TODO','TBD','PENDING','REPLACE_ME'}
                    and not any(c in value for c in '<>'),'PORTAL_LEGAL_FIELDS_REQUIRED')
    data.update(MCL_ACCESS_DB='/data/access-attempts.sqlite',MCL_RELEASE_SHA=sha)
    return ''.join(k+'='+v+'\n' for k,v in sorted(data.items()))


def rewrite_portal(source,container,*,allow_migration_maintenance=False):
    require(type(allow_migration_maintenance) is bool,'PORTAL_MIGRATION_OPTION_INVALID')
    require(re.fullmatch(r'mcl-portal-[0-9]+-[0-9]+',container),'PORTAL_CONTAINER_INVALID')
    items=proxy.tokens(source);stack=[];blocks=[];start=0
    for i,item in enumerate(items):
        if item.kind=='bare' and item.raw==b'{':stack.append(i)
        elif item.kind=='bare' and item.raw==b'}':
            require(stack,'PORTAL_PROXY_UNBALANCED');opening=stack.pop()
            if not stack:blocks.append((items[start:opening],opening,i));start=i+1
    require(not stack and start==len(items),'PORTAL_PROXY_SYNTAX_UNSUPPORTED')
    matches=[]
    for header,opening,closing in blocks:
        if any(HOST in item.value for item in header):
            require(len(header)==1 and header[0].raw==HOST,'PORTAL_SITE_AMBIGUOUS')
            matches.append((header[0].start,items[closing].end))
    require(len(matches)<=1,'PORTAL_SITE_NOT_UNIQUE')
    block=(HOST+b' {\n  # managed-mi-ciclo-listo-portal\n  encode zstd gzip\n  request_body {\n    max_size 16KB\n  }\n  reverse_proxy '+container.encode()+b':3000 {\n    header_up X-Forwarded-For {remote_host}\n    header_up X-Forwarded-Host ciclo.inovaris.online\n    header_up X-Forwarded-Proto {scheme}\n  }\n}\n')
    if not matches:return source+b'\n'+block
    first,last=matches[0]
    old=source[first:last]
    owned_portal=(b'# managed-mi-ciclo-listo-portal' in old and
                  re.search(rb'reverse_proxy mcl-portal-[0-9]+-[0-9]+:3000',old))
    migration_maintenance=(allow_migration_maintenance and old==MIGRATION_MAINTENANCE_BLOCK)
    require(owned_portal or migration_maintenance,'PORTAL_EXISTING_SITE_NOT_OWNED')
    return source[:first]+block.rstrip(b'\n')+source[last:]
