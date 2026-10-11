// Writes reviewable units only; never installs/enables a timer or copies production data.
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
const [output,releaseEnv,offsite,calendar,rpoHours]=process.argv.slice(2);
if(!output||!releaseEnv||!offsite||!calendar||!rpoHours)throw Error('Usage: prepare-backup-schedule.mjs OUTPUT PRIVATE_RELEASE_ENV gs://BUCKET/PREFIX ON_CALENDAR RPO_HOURS');
if(!/^gs:\/\/[a-z0-9][a-z0-9._-]{2,62}\/[a-zA-Z0-9/_-]+$/.test(offsite))throw Error('EXPLICIT_OFFSITE_BUCKET_PREFIX_REQUIRED');
if(!/^\/[a-zA-Z0-9/_-]+\.env$/.test(releaseEnv)||/[\r\n]/.test(calendar)||!/^\d+$/.test(rpoHours)||Number(rpoHours)<1||Number(rpoHours)>168)throw Error('INVALID_REVIEW_CONFIGURATION');
const root=resolve(output);if(existsSync(root))throw Error('OUTPUT_EXISTS_REFUSING_OVERWRITE');mkdirSync(root,{recursive:true,mode:0o700});
const config={release_env:releaseEnv,offsite_uri:offsite,calendar,rpo_hours:Number(rpoHours),retention:'BUCKET_LIFECYCLE_POLICY_REQUIRED',enabled:false};
writeFileSync(join(root,'backup-schedule.json'),JSON.stringify(config,null,2)+'\n',{mode:0o600});
writeFileSync(join(root,'commerce-backup.service'),`[Unit]\nDescription=Commerce OS encrypted backup and approved offsite copy\nAfter=docker.service network-online.target\nRequires=docker.service\n\n[Service]\nType=oneshot\nWorkingDirectory=/opt/commerce-os/current\nExecStart=/usr/bin/flock -n /opt/commerce-os/private/backup-schedule.lock /usr/bin/node scripts/scheduled-backup.mjs /opt/commerce-os/private/backup-schedule.json\nUMask=0077\nTimeoutStartSec=900\nNoNewPrivileges=true\nPrivateTmp=true\n`,{mode:0o600});
writeFileSync(join(root,'commerce-backup.timer'),`[Unit]\nDescription=Commerce OS backup schedule approved by operator\n\n[Timer]\nOnCalendar=${calendar}\nPersistent=true\nRandomizedDelaySec=60\nUnit=commerce-backup.service\n\n[Install]\nWantedBy=timers.target\n`,{mode:0o600});
console.log(JSON.stringify({prepared:true,installed:false,enabled:false,output:root,files:3,external_copies:0}));
