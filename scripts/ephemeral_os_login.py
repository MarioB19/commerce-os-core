"""Remove only the observed OS Login resource matching this runner's key."""
import base64
import binascii
import json
import re


def need(value, code):
    if not value:
        raise RuntimeError(code)


def key_material(public):
    need(isinstance(public, str) and 0 < len(public) <= 8192, 'EPHEMERAL_PUBLIC_KEY_INVALID')
    parts = public.split()
    need(len(parts) >= 2 and parts[0] in {'ssh-ed25519', 'ssh-rsa',
         'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521'},
         'EPHEMERAL_PUBLIC_KEY_INVALID')
    try:
        need(bool(base64.b64decode(parts[1], validate=True)), 'EPHEMERAL_PUBLIC_KEY_INVALID')
    except (ValueError, binascii.Error):
        raise RuntimeError('EPHEMERAL_PUBLIC_KEY_INVALID') from None
    return parts[:2]


def read_profile(runner):
    response = runner(['gcloud', 'compute', 'os-login', 'describe-profile', '--format=json'])
    need(response.returncode == 0 and isinstance(response.stdout, str)
         and 0 < len(response.stdout.encode()) <= 1024 * 1024,
         'EPHEMERAL_OS_LOGIN_PROFILE_READ_FAILED')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            need(key not in result, 'EPHEMERAL_OS_LOGIN_PROFILE_INVALID')
            result[key] = value
        return result
    try:
        profile = json.loads(response.stdout, object_pairs_hook=unique)
    except (TypeError, ValueError):
        raise RuntimeError('EPHEMERAL_OS_LOGIN_PROFILE_INVALID') from None
    need(isinstance(profile, dict), 'EPHEMERAL_OS_LOGIN_PROFILE_INVALID')
    need(isinstance(profile.get('name'), str) and 0 < len(profile['name']) <= 320,
         'EPHEMERAL_OS_LOGIN_PROFILE_INVALID')
    keys = profile.get('sshPublicKeys', {})
    need(isinstance(keys, dict) and len(keys) <= 1000
         and all(isinstance(identifier, str) and isinstance(entry, dict)
                 and isinstance(entry.get('key'), str) and len(entry['key']) <= 8192
                 for identifier, entry in keys.items()), 'EPHEMERAL_OS_LOGIN_PROFILE_INVALID')
    return profile, keys


def remove_ephemeral_key(public, runner):
    material = key_material(public)
    before, keys = read_profile(runner)
    matching = [identifier for identifier, entry in keys.items()
                if entry['key'].split()[:2] == material]
    need(len(matching) <= 1, 'EPHEMERAL_OS_LOGIN_KEY_AMBIGUOUS')
    if not matching:
        return {'key_absent_verified': True, 'remove_calls': 0, 'profile_reads': 1}
    identifier = matching[0]
    entry = keys[identifier]
    need(re.fullmatch('[a-f0-9]{64}', identifier) is not None
         and ('fingerprint' not in entry or entry['fingerprint'] == identifier),
         'EPHEMERAL_OS_LOGIN_RESOURCE_INVALID')
    # Use Google's resource ID. Recomputing it from the original file/comment
    # can select a different resource from the one stored in the profile.
    removed = runner(['gcloud', 'compute', 'os-login', 'ssh-keys', 'remove',
                      '--key=' + identifier, '--quiet'])
    need(removed.returncode == 0, 'EPHEMERAL_OS_LOGIN_KEY_REMOVAL_FAILED')
    after, remaining = read_profile(runner)
    need(after.get('name') == before.get('name'), 'EPHEMERAL_OS_LOGIN_PROFILE_IDENTITY_CHANGED')
    need(identifier not in remaining and not any(entry['key'].split()[:2] == material
         for entry in remaining.values()), 'EPHEMERAL_OS_LOGIN_KEY_STILL_REGISTERED')
    need(all(remaining.get(other) == entry for other, entry in keys.items() if other != identifier),
         'EPHEMERAL_OS_LOGIN_OTHER_KEYS_CHANGED')
    return {'key_absent_verified': True, 'remove_calls': 1, 'profile_reads': 2}
