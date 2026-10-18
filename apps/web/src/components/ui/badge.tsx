import * as React from 'react';
import {CircleCheck,CircleAlert,CircleX,Info,Circle,CircleDashed} from 'lucide-react';
import {cn} from '../../lib/utils';
export type Tone='success'|'warn'|'error'|'info'|'neutral'|'accent';
const icons:Record<Tone,React.ComponentType<{'aria-hidden'?:boolean|'true'}>>={success:CircleCheck,warn:CircleAlert,error:CircleX,info:Info,neutral:Circle,accent:CircleDashed};
/** State = icon + text + colour, never colour alone (RF-17.k). */
export function Badge({tone='neutral',children,className,icon=true,...props}:React.ComponentProps<'span'>&{tone?:Tone;icon?:boolean}){
 const Icon=icons[tone];
 return <span className={cn('badge',className)} data-tone={tone} {...props}>{icon&&<Icon aria-hidden="true"/>}{children}</span>;
}
/** Maps the operational tones used by the API labels to a badge tone. */
export const toneOf=(code:string):Tone=>{
 if(['SELLING','CONNECTED','READY','VERIFIED','APPROVED','DONE','ACTIVE','PASSED','COMPLETED','SYNCED','ok','success'].includes(code))return 'success';
 if(['READY_TO_ASSIGN','WARMING','PENDING','RUNNING','QUEUED','ready','info','PARTIAL'].includes(code))return 'info';
 if(['NEEDS_SETUP','NEEDS_QR','DISCONNECTED','PAUSED','PAUSED_BY_YOU','REVIEW','HUMAN_REVIEW','NEEDS_OWNER','HUMAN_REQUIRED','UNCERTAIN','attention','warn','WARNING','SKIPPED'].includes(code))return 'warn';
 if(['REJECTED','FAILED','PHONE_MISMATCH','NUMBER_UNAVAILABLE','PREPARATION_FAILED','INVALID','FALSE','BLOCKING','bad','error','EXPIRED','CANCELLED','REMOVED'].includes(code))return 'error';
 return 'neutral';
};
