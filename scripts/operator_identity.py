"""Private operator identities; never a target, credential or approval override.

The trusted local publisher reads one fixed custody file, outside source. The
Root adapter uses its existing Root-protected reader and this same parser.
No candidate file, environment variable or default account supplies identity.
"""
import json
import os
from pathlib import Path
import re
import stat

ROOT = Path(__file__).resolve().parent.parent
CUSTODY_ROOT = Path.home() / '.local/share/commerce-os-release-custody'
ROLES = {'cloud_build', 'legacy_billing'}
MAX_BYTES = 4096


class OperatorIdentityError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise OperatorIdentityError(code)


def account(value):
    require(type(value) is str and len(value) <= 254
            and re.fullmatch(r'[A-Za-z0-9._+%-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}', value),
            'OPERATOR_ACCOUNT_INVALID')
    return value


def configured_account(raw, role):
    require(type(raw) is bytes and 0 < len(raw) <= MAX_BYTES and role in ROLES,
            'OPERATOR_IDENTITY_INPUT_INVALID')
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'OPERATOR_IDENTITY_DUPLICATE_FIELD')
            result[key] = value
        return result
    try:
        value = json.loads(raw, object_pairs_hook=pairs)
    except (UnicodeError, json.JSONDecodeError):
        raise OperatorIdentityError('OPERATOR_IDENTITY_JSON_INVALID') from None
    require(type(value) is dict and set(value) == {'schema_version', 'accounts'}
            and type(value['schema_version']) is int and value['schema_version'] == 1
            and type(value['accounts']) is dict and set(value['accounts']) == ROLES,
            'OPERATOR_IDENTITY_FIELDS_INVALID')
    for candidate in value['accounts'].values():
        account(candidate)
    return value['accounts'][role]


def local_account(role):
    path = CUSTODY_ROOT / 'operator-identity.json'
    require(path.is_absolute() and not path.is_relative_to(ROOT), 'OPERATOR_IDENTITY_OUTSIDE_SOURCE_REQUIRED')
    owners = {0, os.geteuid()}
    for parent in path.parents:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid in owners and not info.st_mode & 0o022,
                'OPERATOR_IDENTITY_PARENT_UNSAFE')
    before = path.lstat()
    require(stat.S_ISREG(before.st_mode) and before.st_uid in owners
            and stat.S_IMODE(before.st_mode) == 0o600 and before.st_nlink == 1,
            'OPERATOR_IDENTITY_FILE_UNSAFE')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        opened = os.fstat(fd)
        raw = os.read(fd, MAX_BYTES + 1)
        fields = ('st_dev', 'st_ino', 'st_uid', 'st_mode', 'st_nlink', 'st_size', 'st_mtime_ns', 'st_ctime_ns')
        require(len(raw) == before.st_size and 0 < len(raw) <= MAX_BYTES
                and all(getattr(before, key) == getattr(opened, key) == getattr(os.fstat(fd), key)
                        == getattr(path.lstat(), key) for key in fields), 'OPERATOR_IDENTITY_CHANGED')
    finally:
        os.close(fd)
    return configured_account(raw, role)
