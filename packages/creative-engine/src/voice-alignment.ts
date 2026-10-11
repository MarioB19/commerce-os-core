import type {TimedWord} from '../../creative-contracts/src/index.js';

export interface CharacterAlignment {characters:string[];character_start_times_seconds:number[];character_end_times_seconds:number[]}
const invalid=()=>Object.assign(new Error('La alineación del proveedor no corresponde al texto cotizado.'),{code:'VOICE_ALIGNMENT_INVALID',statusCode:409});
/** Uses provider character times only. Quantization never estimates speech or edits the transcript. */
export function characterAlignmentToWords(alignment:CharacterAlignment,transcript:string,fps=30,maxDurationSeconds=60,wordsPerChunk=5):TimedWord[]{
 if(!Number.isInteger(fps)||fps<1||fps>60||!alignment||!Array.isArray(alignment.characters)||!Array.isArray(alignment.character_start_times_seconds)||!Array.isArray(alignment.character_end_times_seconds))throw invalid();
 const {characters,character_start_times_seconds:starts,character_end_times_seconds:ends}=alignment;
 if(!characters.length||characters.length>10000||starts.length!==characters.length||ends.length!==characters.length||characters.some(c=>typeof c!=='string'||[...c].length!==1)||characters.join('')!==transcript)throw invalid();
 const words:TimedWord[]=[];let first=-1;
 const flush=(last:number)=>{if(first<0)return;const text=characters.slice(first,last+1).join('');if(text.length>80)throw invalid();const startFrame=Math.floor(starts[first]*fps),endFrame=Math.max(startFrame,Math.ceil(ends[last]*fps)-1),previous=words.at(-1);if(previous&&startFrame<previous.endFrame)throw invalid();words.push({text,startFrame,endFrame,chunkId:`voice-chunk-${Math.floor(words.length/wordsPerChunk)}`});first=-1;};
 for(let i=0;i<characters.length;i++){if(!Number.isFinite(starts[i])||!Number.isFinite(ends[i])||starts[i]<0||ends[i]<starts[i]||ends[i]>maxDurationSeconds+.5||(i>0&&(starts[i]<starts[i-1]||ends[i]<ends[i-1])))throw invalid();if(/\s/u.test(characters[i]))flush(i-1);else if(first<0)first=i;}
 flush(characters.length-1);if(!words.length)throw invalid();return words;
}

/** Only explicit SSML break tags are non-spoken; punctuation and words remain exact. */
export const spokenVoiceText=(text:string)=>text.replace(/<break\s+time=["'](?:[0-2](?:\.\d{1,3})?|3(?:\.0{1,3})?)s["']\s*\/>/gu,' ').replace(/\s+/gu,' ').trim();
export function alignmentForTranscript(result:any,transcript:string,allowBreakTags=false):CharacterAlignment{
 for(const alignment of [result?.alignment,result?.normalized_alignment])if(Array.isArray(alignment?.characters)&&(alignment.characters.join('')===transcript||allowBreakTags&&spokenVoiceText(alignment.characters.join(''))===spokenVoiceText(transcript)))return alignment;
 throw invalid();
}
