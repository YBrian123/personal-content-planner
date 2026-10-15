import {spawn,execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdir,open,unlink,access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const root=path.resolve(fileURLToPath(new URL('../',import.meta.url))),runtime=path.join(root,'.runtime'),stateFile=path.join(runtime,'server.json');
const serverFile=path.join(root,'scripts/server.mjs');
await mkdir(runtime,{recursive:true,mode:0o700});
let state;try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch{}
async function health(){try{return await (await fetch('http://127.0.0.1:18765/__planner_health',{signal:AbortSignal.timeout(1000)})).json();}catch{return null;}}
function alive(){try{process.kill(state.pid,0);const command=execFileSync('/bin/ps',['-p',String(state.pid),'-o','command='],{encoding:'utf8'});return command.includes(serverFile);}catch{return false;}}
const action=process.argv[2]||'start';
const active=await health(),owned=state?.marker&&active?.marker===state.marker&&alive();
if(action==='status'){console.log(owned?'本应用正在运行：http://127.0.0.1:18765/':active?'18765 端口有其他服务，未操作。':'本应用未运行。');process.exit(0);}
if(action==='stop'){
  if(owned){process.kill(state.pid,'SIGTERM');await unlink(stateFile).catch(()=>{});console.log('已停止本应用。数据仍保存在在线数据库。');}
  else console.log('未发现可核实身份的本应用进程，未停止其他服务。');
  process.exit(0);
}
if(action!=='start')throw new Error('只支持 start / stop / status');
if(owned){console.log('已在运行：http://127.0.0.1:18765/');process.exit(0);}
// Probe the port before building. Any occupied port is left intact.
const net=await import('node:net');
await new Promise((resolve,reject)=>{const probe=net.createServer();probe.once('error',()=>reject(new Error('18765 端口被占用。请先关闭此前的本应用开发服务；其他服务不会被自动关闭。')));probe.listen(18765,'127.0.0.1',()=>probe.close(resolve));});
await access(path.join(root,'.env')).catch(()=>{throw new Error('缺少 .env 配置，请按 README 配置。');});
await access(path.join(root,'node_modules/vite')).catch(()=>{throw new Error('缺少依赖，请在应用目录先运行 npm ci。');});
execFileSync(process.platform==='win32'?'npm.cmd':'npm',['run','build','--','--outDir','dist-local'],{cwd:root,env:{...process.env,VITE_BASE_PATH:'/'},stdio:'inherit'});
const marker=randomUUID(),log=await open(path.join(runtime,'server.log'),'a',0o600);
const child=spawn(process.execPath,[serverFile],{cwd:root,env:{...process.env,PLANNER_SERVER_MARKER:marker},detached:true,stdio:['ignore',log.fd,log.fd]});child.unref();await log.close();
await writeFile(stateFile,JSON.stringify({pid:child.pid,marker,startedAt:new Date().toISOString()}),{mode:0o600});
for(let n=0;n<40;n++){const h=await health();if(h?.marker===marker){console.log('启动成功：http://127.0.0.1:18765/');process.exit(0);}await new Promise(r=>setTimeout(r,100));}
throw new Error('启动未确认，请查看 .runtime/server.log。');
