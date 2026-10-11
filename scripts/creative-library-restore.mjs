import {restoreLibrary} from './creative-library-backup.mjs';
const [source,destination]=process.argv.slice(2);if(!source||!destination)throw Error('Usage: creative-library-restore.mjs <verified-backup-folder> <new-archive-folder>');
try{console.log(JSON.stringify(await restoreLibrary(source,destination)));}catch(error){console.error(JSON.stringify({error:/^[A-Z0-9_]+$/.test(error.message)?error.message:'RESTORE_FAILED',restored:false}));process.exitCode=1;}
