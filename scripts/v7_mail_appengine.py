#!/usr/bin/env python3
"""Stage the V7 App Engine mail service (ADR-V7-13) for `gcloud app deploy`.

  python3 -I scripts/v7_mail_appengine.py stage <empty-out-dir> <config.json>

Pure file staging: copies infra/mail-appengine/{main.py,requirements.txt}, the
two reviewed modules scripts/gcp_mail_{dispatch,native}.py, and renders
app.yaml from a closed config (no secret values; the key is referenced by its
Secret Manager version name). Prints a JSON receipt with file hashes.
"""
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import gcp_mail_dispatch as core  # noqa: E402

FIELDS = {'project', 'region_code', 'service_account', 'dispatcher_email', 'dispatcher_subject', 'web_origin',
          'key_version', 'bucket'}
FILES = {'main.py': ROOT / 'infra/mail-appengine/main.py',
         'requirements.txt': ROOT / 'infra/mail-appengine/requirements.txt',
         'gcp_mail_dispatch.py': ROOT / 'scripts/gcp_mail_dispatch.py',
         'gcp_mail_native.py': ROOT / 'scripts/gcp_mail_native.py'}


def render(config):
    core.need(type(config) is dict and set(config) == FIELDS, 'MAIL_STAGE_CONFIG_FIELDS')
    project = config['project']
    core.need(re.fullmatch(r'[a-z]{2}', config['region_code'] or ''), 'MAIL_STAGE_REGION_CODE')
    core.need(re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]@' + re.escape(project) + r'\.iam\.gserviceaccount\.com',
                           config['service_account'] or ''), 'MAIL_STAGE_SERVICE_ACCOUNT')
    core.need(re.fullmatch(r'projects/[1-9][0-9]*/secrets/commerce-v7-mail-key/versions/[1-9][0-9]*', config['key_version'] or ''),
              'MAIL_STAGE_KEY_VERSION')
    core.need(re.fullmatch(r'commerce-v7-mail-[0-9]{6,20}', config['bucket'] or ''), 'MAIL_STAGE_BUCKET')
    mail = core.validate_config({'schema_version': 1, 'project': project,
                                 'sender': 'invitations@' + project + '.appspotmail.com',
                                 'origin': config['web_origin'],
                                 'audience': 'https://' + project + '.' + config['region_code'] + '.r.appspot.com',
                                 'dispatcher_email': config['dispatcher_email'],
                                 'dispatcher_subject': config['dispatcher_subject']})
    text = (ROOT / 'infra/mail-appengine/app.yaml.template').read_text()
    values = {'SERVICE_ACCOUNT': config['service_account'], 'MAIL_CONFIG': json.dumps(mail, sort_keys=True, separators=(',', ':')),
              'MAIL_KEY_VERSION': config['key_version'], 'MAIL_JOURNAL_BUCKET': config['bucket']}
    for key, value in values.items():
        core.need("'" not in value and '\n' not in value, 'MAIL_STAGE_VALUE_UNSAFE')
        text = text.replace('${' + key + '}', value)
    core.need('${' not in text, 'MAIL_STAGE_TEMPLATE_INCOMPLETE')
    return text, mail


def stage(out, config):
    out = Path(out)
    core.need(out.is_dir() and not any(out.iterdir()), 'MAIL_STAGE_EMPTY_DIRECTORY_REQUIRED')
    text, mail = render(config)
    receipt = {}
    for name, source in FILES.items():
        shutil.copyfile(source, out / name)
        receipt[name] = hashlib.sha256((out / name).read_bytes()).hexdigest()
    (out / 'app.yaml').write_text(text)
    (out / '.gcloudignore').write_text('__pycache__/\n*.pyc\n')
    receipt['app.yaml'] = hashlib.sha256(text.encode()).hexdigest()
    return {'state': 'MAIL_SERVICE_STAGED', 'audience': mail['audience'], 'sender': mail['sender'], 'files': receipt}


if __name__ == '__main__':
    if len(sys.argv) != 4 or sys.argv[1] != 'stage':
        sys.exit('usage: v7_mail_appengine.py stage <empty-out-dir> <config.json>')
    print(json.dumps(stage(sys.argv[2], json.loads(Path(sys.argv[3]).read_text())), sort_keys=True))
