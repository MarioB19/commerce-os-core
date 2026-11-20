export function publicWebOrigin(){
 const value=process.env.PUBLIC_WEB_ORIGIN??process.env.CLIENT_ORIGIN?.split(',')[0]??process.env.BETTER_AUTH_URL??'http://localhost:5173';
 const url=new URL(value);
 if(url.username||url.password||url.pathname!=='/'||url.search||url.hash||!['http:','https:'].includes(url.protocol)||
  (url.protocol!=='https:'&&(process.env.NODE_ENV==='production'||!['localhost','127.0.0.1'].includes(url.hostname))))throw new Error('PUBLIC_WEB_ORIGIN_INVALID');
 return url.origin;
}
