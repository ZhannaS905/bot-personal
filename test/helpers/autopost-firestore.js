'use strict';
const {createFirestoreStore}=require('../../src/training-test-firestore');
function database(projectId='fitpp-test'){
 const data=new Map(),versions=new Map(),paths=[],commits=[];let fail=null;
 const raw={app:{options:{projectId}}};
 const snapshot=value=>({exists:()=>value!==undefined,data:()=>structuredClone(value)});
 const sdk={doc(database,path){if(database!==raw)throw Error('WRONG_DATABASE');paths.push(path);return {path}},async getDocFromServer(ref){if(fail==='read')throw Error('READ_DENIED');return snapshot(data.get(ref.path))},async runTransaction(database,fn,{maxAttempts=5}={}){
  for(let attempt=0;attempt<maxAttempts;attempt++){
   const reads=new Map(),writes=new Map();
   const result=await fn({async get(ref){reads.set(ref.path,versions.get(ref.path)||0);return snapshot(data.get(ref.path))},set(ref,value){writes.set(ref.path,structuredClone(value))},update(ref,patch){if(!reads.has(ref.path)||!data.has(ref.path))throw Error('UPDATE_REQUIRES_DOCUMENT');writes.set(ref.path,{...data.get(ref.path),...structuredClone(patch)})}});
   await new Promise(r=>setImmediate(r));
   if([...reads].some(([key,version])=>(versions.get(key)||0)!==version))continue;
   if(fail==='write'&&writes.size)throw Error('WRITE_DENIED');
   for(const [key,value]of writes){data.set(key,value);versions.set(key,(versions.get(key)||0)+1);commits.push(key)}
   if(fail==='ack'&&writes.size){fail=null;throw Error('LOST_COMMIT_ACK')}
   return result;
  }
  throw Error('ABORTED');
 }};
 return {data,paths,commits,sdk,raw,setFail:v=>fail=v,store:(options={})=>createFirestoreStore({sdk,raw,botId:'123',validateAuth:async()=>{},writeEnabled:()=>true,...options})};
}
module.exports={database};
