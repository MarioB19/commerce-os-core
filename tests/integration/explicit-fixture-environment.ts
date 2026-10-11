import type {InjectOptions} from 'fastify';
/** Legacy synthetic fixtures choose SIMULATION explicitly at their HTTP boundary.
 * REAL/default contract tests intentionally do not import this helper. */
export function explicitFixtureEnvironment(options:InjectOptions):InjectOptions{
 const value=options.url??options.path;if(typeof value!=='string'||!value.startsWith('/v1/')||value.startsWith('/v1/openapi'))return options;
 const url=new URL(value,'http://fixture.invalid');
 const body=options.payload&&typeof options.payload==='object'?options.payload as {environment?:unknown}:undefined;
 if(!url.searchParams.has('environment')&&body?.environment===undefined)url.searchParams.set('environment','SIMULATION');
 return{...options,...(options.url!==undefined?{url:url.pathname+url.search}:{path:url.pathname+url.search})};
}
