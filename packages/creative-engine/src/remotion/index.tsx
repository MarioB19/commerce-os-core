import { Composition, getInputProps, registerRoot } from 'remotion';
import { StudioComposition, type StudioProps } from './Composition.tsx';
registerRoot(()=> <Composition id="CommerceStudioFaceless" component={StudioComposition} defaultProps={getInputProps<StudioProps>()} width={1080} height={1920} fps={30} durationInFrames={900} calculateMetadata={({props})=>({durationInFrames:props.recipe.duration_frames,width:props.recipe.width,height:props.recipe.height,fps:props.recipe.fps})}/>);
