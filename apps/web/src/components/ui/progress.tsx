/** Determinate progress with a visible label (never colour alone). */
export function Progress({value,max=100,label,tone,valueText}:{value:number;max?:number;label:string;tone?:'success'|'warn';valueText?:string}){
 const ratio=max>0?Math.max(0,Math.min(1,value/max)):0;
 return <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={Math.max(0,Math.min(max,value))} aria-valuetext={valueText} className="progress" data-tone={tone}><span style={{width:`${ratio*100}%`}}/></div>;
}
