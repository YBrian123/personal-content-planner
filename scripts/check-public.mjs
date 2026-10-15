import {readdir,readFile} from 'node:fs/promises';
import path from 'node:path';
const blocked=[/\/Users\/[^\s"'<>]+/,/sb_secret_[A-Za-z0-9_-]{20,}/,/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,/V[1-6]-[0-9]{2}/];
async function scan(directory){
  for(const e of await readdir(directory,{withFileTypes:true})){
    if(['node_modules','.git','.runtime'].includes(e.name)||e.name.startsWith('.env')&&e.name!=='.env.example')continue;
    const p=path.join(directory,e.name);if(e.isDirectory()){await scan(p);continue;}
    if(!/\.(ts|tsx|js|mjs|css|html|sql|json|md|ya?ml|map|command)$/.test(e.name))continue;
    const text=await readFile(p,'utf8');if(blocked.some(r=>r.test(text))){throw new Error('公开文件检查失败：'+p);}
  }
}
await scan('.');console.log('源码和构建产物检查通过；私人导入不在应用目录。发布前还需检查实际 Git 历史与流水线。');
