import http from 'node:http';
import {readFile,stat,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(fileURLToPath(new URL('../dist-local/',import.meta.url)));
const marker=process.env.PLANNER_SERVER_MARKER;
if(!marker)throw new Error('请通过启动脚本运行');
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon'};
const server=http.createServer(async(req,res)=>{
  try{
    const pathname=decodeURIComponent(new URL(req.url,'http://127.0.0.1').pathname);
    if(pathname==='/__planner_health'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({app:'personal-content-planner',marker}));return;}
    if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);res.end();return;}
    const candidate=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!candidate.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
    const file=await realpath(candidate);if(!file.startsWith(root+path.sep)||!(await stat(file)).isFile()){res.writeHead(404);res.end();return;}
    const bytes=await readFile(file);
    res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','X-Content-Type-Options':'nosniff','Referrer-Policy':'strict-origin-when-cross-origin','Cache-Control':file.endsWith('index.html')?'no-cache':'public,max-age=86400'});res.end(req.method==='HEAD'?undefined:bytes);
  }catch{res.writeHead(404);res.end('Not found');}
});
server.listen(18765,'127.0.0.1');
server.on('error',e=>{console.error(e.message);process.exit(1);});
