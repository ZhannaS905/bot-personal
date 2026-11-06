'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const personalWorker='src/fitpp-personal/notification-worker.js';
// Linux /proc is mandatory: refuse startup if the old terminal watcher is alive.
function manualWatchers(root='/proc') {
 return fs.readdirSync(root).filter(p=>/^\d+$/.test(p)).filter(p=>{
  let argv;try{argv=fs.readFileSync(path.join(root,p,'cmdline'),'utf8').split('\0')}catch(e){if(e.code==='ENOENT'||e.code==='ESRCH')return false;throw e}
  return argv.some(a=>/\/(fitpp-notification-test|fitpp-notification-preview)\.cjs$/.test(a)||/^(fitpp-notification-test|fitpp-notification-preview)\.cjs$/.test(a)) && argv.includes('--send') && argv.includes('--watch');
 });
}
function personalNotificationsEnabled(env,{dataRoot='/data',log=console.error}={}) {
 const flag=env.FITPP_PERSONAL_NOTIFICATIONS_ENABLED;
 if(flag===undefined||flag==='false')return false;
 try {
  if(env.FITPP_NOTIFICATION_SUPERVISED==='true')throw Error();
  const {directory}=require('./'+personalWorker).settings(env);
  if(!path.isAbsolute(directory)||!path.resolve(directory).startsWith(dataRoot+path.sep))throw Error();
  const resolved=fs.realpathSync(directory);
  if(!resolved.startsWith(fs.realpathSync(dataRoot)+path.sep))throw Error();
  const state=fs.statSync(resolved);
  if(!state.isDirectory()||(state.mode&0o777)!==0o700)throw Error();
  fs.accessSync(resolved,fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK);
  return true;
 }catch{
  log('FITPP_PERSONAL_NOTIFICATION_SUPERVISOR_REFUSED check_settings_and_data_directory');
  return false;
 }
}
function supervise({enabled=false,personalEnabled=false,launch=(file,args)=>spawn(process.execPath,[path.join(__dirname,file),...args],{stdio:'inherit'}),schedule=setTimeout,cancel=clearTimeout,log=console.log,finish=code=>process.exit(code)}={}) {
 let stopping=false,timer,killTimer,failures=0;
 const children=new Set();
 function stop(code=0){
  if(stopping)return;stopping=true;if(timer)cancel(timer);
  for(const child of children)child.kill('SIGTERM');
  if(!children.size)return finish(code);
  killTimer=schedule(()=>{for(const child of children)child.kill('SIGKILL')},10000);
  exitCode=code;
 }
 let exitCode=0;
 function start(file,args,retryLabel){
  function retry(){
   const delay=Math.min(300000,5000*2**Math.min(failures++,6));
   log('FITPP_SUPERVISOR '+retryLabel+' retry_ms='+delay);
   timer=schedule(()=>{timer=null;if(!stopping)start(file,args,retryLabel)},delay);
  }
  let child;
  try{child=launch(file,args)}catch{
   if(file===personalWorker)retry();
   else stop(1);
   return;
  }
  children.add(child);let done=false;
  function ended(){
   if(done)return;done=true;children.delete(child);
   if(stopping){if(!children.size){if(killTimer)cancel(killTimer);finish(exitCode)}return}
   if(!retryLabel){stop(1);return}
   retry();
  }
  child.once('exit',ended);child.once('error',ended);
 }
 start('direct-training-test.cjs',[]);
 if(enabled&&!stopping)start('fitpp-notification-test.cjs',['--send','--watch'],'watcher_stopped');
 if(personalEnabled&&!enabled&&!stopping)start(personalWorker,[],'personal_worker_stopped');
 return {stop};
}
if(require.main===module)(async()=>{
 let lock;try{
  const flag=process.env.FITPP_NOTIFICATION_SUPERVISED;
  if(flag!==undefined&&!['true','false'].includes(flag))throw Error('FLAG_REFUSED');
  if(flag==='true')lock=await require('./src/fitpp-notification-lock.cjs').acquire('supervisor');
  if(flag==='true'&&manualWatchers().length)throw Error('EXISTING_WATCHER');
  const runtime=supervise({enabled:flag==='true',personalEnabled:personalNotificationsEnabled(process.env)});
  process.once('SIGTERM',()=>runtime.stop());process.once('SIGINT',()=>runtime.stop());
 }catch{lock?.close();console.error('FITPP_SUPERVISOR_START_REFUSED check_flag_and_existing_watchers');process.exitCode=1}
})();
module.exports={supervise,manualWatchers,personalNotificationsEnabled};
