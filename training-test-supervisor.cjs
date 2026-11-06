'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const personalWorker='src/fitpp-personal/notification-worker.js';
const personalDirectoryName='fitpp-personal-notifications';
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
if(env.FITPP_NOTIFICATION_SUPERVISED==='true')
  throw Error('legacy_supervisor_enabled');  const {directory}=require('./'+personalWorker).settings(env);
  const relative=path.relative(dataRoot,directory);
  if(!path.isAbsolute(directory)||!relative||directory!==path.join(dataRoot,relative)||
     relative==='..'||relative.startsWith('..'+path.sep))throw Error('invalid_directory_path');
  const uid=process.geteuid();
  function checkParent(parent){
   const state=fs.lstatSync(parent);
if (!state.isDirectory()) throw Error('parent_not_directory');
if (state.uid !== 0 && state.uid !== uid) throw Error('parent_wrong_owner');
if ((state.mode & 0o022) !== 0)
  throw Error(parent === dataRoot
    ? 'data_root_unsafe_permissions'
    : 'nested_parent_unsafe_permissions');  }
  checkParent(dataRoot);
  let parent=dataRoot;
  for(const component of relative.split(path.sep).slice(0,-1)){
   parent=path.join(parent,component);
   checkParent(parent);
  }
  if(relative===personalDirectoryName){
   try{fs.mkdirSync(directory,{mode:0o700})}
   catch(error){if(error.code!=='EEXIST')throw error}
  }
  const state=fs.lstatSync(directory);
if (!state.isDirectory()) throw Error('directory_not_directory');
if (state.uid !== uid) throw Error('directory_wrong_owner');
if ((state.mode & 0o7777) !== 0o700) throw Error('directory_wrong_permissions');  fs.accessSync(directory,fs.constants.R_OK|fs.constants.W_OK|fs.constants.X_OK);
  return true;
}catch(error){
  const reason = error.code || error.message || 'unknown';
  log(`FITPP_PERSONAL_NOTIFICATION_SUPERVISOR_REFUSED check_settings_and_data_directory ${reason}`);
  return false;
}
}
async function preparePersonalNotifications(env,{acquire=require('./src/fitpp-notification-lock.cjs').acquire,
 scan=manualWatchers,dataRoot='/data',log=console.error}={}){
 if(env.FITPP_PERSONAL_NOTIFICATIONS_ENABLED===undefined||
    env.FITPP_PERSONAL_NOTIFICATIONS_ENABLED==='false'||env.FITPP_NOTIFICATION_SUPERVISED==='true')return;
 let lock;
 try{
  lock=await acquire();
  if(scan().length)throw Error();
  if(personalNotificationsEnabled(env,{dataRoot,log}))return lock;
 }catch{
  log('FITPP_PERSONAL_NOTIFICATION_SUPERVISOR_REFUSED check_existing_watchers');
 }
 lock?.close();
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
 let lock,personalLock;try{
  const flag=process.env.FITPP_NOTIFICATION_SUPERVISED;
  if(flag!==undefined&&!['true','false'].includes(flag))throw Error('FLAG_REFUSED');
  if(flag==='true')lock=await require('./src/fitpp-notification-lock.cjs').acquire('supervisor');
  if(flag==='true'&&manualWatchers().length)throw Error('EXISTING_WATCHER');
  personalLock=await preparePersonalNotifications(process.env);
  const runtime=supervise({enabled:flag==='true',personalEnabled:Boolean(personalLock)});
  process.once('SIGTERM',()=>runtime.stop());process.once('SIGINT',()=>runtime.stop());
 }catch{personalLock?.close();lock?.close();console.error('FITPP_SUPERVISOR_START_REFUSED check_flag_and_existing_watchers');process.exitCode=1}
})();
module.exports={supervise,manualWatchers,personalNotificationsEnabled,preparePersonalNotifications};
