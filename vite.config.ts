import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig(({command,mode})=>{
  if(command==='build'&&mode==='qa')throw new Error('验收环境不允许构建发布');
  return { plugins: [react()], base: process.env.VITE_BASE_PATH || '/',
    resolve:{alias:command==='serve'&&mode==='qa'?[{find:'./data',replacement:fileURLToPath(new URL('./qa/adapter.ts',import.meta.url))}]:[]},
    optimizeDeps:{exclude:['@electric-sql/pglite']},
    server:{fs:{strict:true,allow:[fileURLToPath(new URL('.',import.meta.url))]}},
    test: { testTimeout: 30000, hookTimeout: 60000, fileParallelism: false } };
});
