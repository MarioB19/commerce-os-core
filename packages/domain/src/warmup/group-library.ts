import corpus from './library-es-v1.json' with {type:'json'};
import {libraryScriptSchema} from '../../../contracts/src/group-warmup.js';
import {validateLibrary} from './group-policy.js';
export const BUNDLED_LIBRARY_VERSION='operacion-interna-es/v1';
export const BUNDLED_LIBRARY_NAME='Coordinación y revisión de materiales';
export const bundledGroupLibrary=Object.freeze(corpus.map(s=>libraryScriptSchema.parse(s)));
export const bundledLibraryManifest=Object.freeze(validateLibrary([...bundledGroupLibrary]));
