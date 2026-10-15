export {errorText} from './errors';
import {recordClock} from './commands';
export {mutation} from './commands';
import { createClient } from '@supabase/supabase-js';
import type { Session } from '@supabase/supabase-js';
import type { Backup, Context, Filter, ListResult, Mutation, Row } from './domain';
const url=import.meta.env.VITE_SUPABASE_URL||'';
const key=import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY||'';
const project=import.meta.env.VITE_SUPABASE_PROJECT_ID||'';
export const configurationError=(()=>{try{
  if(!url||!key||!project||url.includes('YOUR_PROJECT')||key.includes('YOUR_'))return '网站还没有连接你的数据服务';
  if(new URL(url).hostname!==project+'.supabase.co'||!url.startsWith('https://'))return '数据服务地址与项目标识不一致';
  if(key.startsWith('sb_secret_'))return '配置中使用了后台密钥，请改用公开连接配置';
  if(!key.startsWith('sb_publishable_'))return '请使用项目的 publishable key';
  return '';
}catch{return '数据服务地址无效';}})();
export const instance=project;
export const client=configurationError?null:createClient(url,key,{auth:{flowType:'pkce',detectSessionInUrl:true,persistSession:true,autoRefreshToken:true}});
let initialization:Promise<Session|null>|undefined;
export function initialize():Promise<Session|null>{return initialization??= (async()=>{
  if(!client)return null;
  const {data,error}=await client.auth.getSession(); if(error)throw error;
  if(new URL(location.href).searchParams.has('code')&&data.session){
    const clean=new URL(location.href); clean.searchParams.delete('code'); history.replaceState({},'',clean.pathname+clean.search+clean.hash);
  }
  return data.session;
})().finally(()=>{initialization=undefined;});}
export async function login(){ if(!client)throw new Error(configurationError); const {error}=await client.auth.signInWithOAuth({provider:'github',options:{redirectTo:location.origin+import.meta.env.BASE_URL}});if(error)throw error; }
export async function logout(){if(client){const {error}=await client.auth.signOut({scope:'local'});if(error)throw error;}}
async function rpc<T>(name:string,args:Record<string,unknown>={}):Promise<T>{
  if(!client)throw new Error(configurationError);
  const {data,error}=await client.rpc(name,args);if(error){
    if(['PGRST301','PGRST302'].includes(error.code)||error.code==='42501'&&error.message.includes('FORBIDDEN'))
      window.dispatchEvent(new CustomEvent('planner-auth-invalid',{detail:error.message.includes('FORBIDDEN')?'forbidden':'expired'}));
    throw error;
  }
  return data as T;
}
export const api={
  context:async()=>recordClock(await rpc<Context>('planner_context')),
  list:(plan:string,filter:Filter,offset=0,limit=50)=>rpc<ListResult>('planner_list',{p_plan:plan,p_filter:filter,p_offset:offset,p_limit:limit}),
  detail:(id:string,offset=0)=>rpc<{record:Row|null;related:Row[];historyTotal:number}>('planner_detail',{p_id:id,p_offset:offset}),
  export:()=>rpc<Backup>('planner_export'),
  execute:(m:Mutation)=>rpc<{id:string|null;generation:string;revision:number}>('planner_execute',{p_operation:m.operation,p_generation:m.generation,p_action:m.action,p_payload:m.payload,p_expected:m.expected})
};

export async function providerStatus(){if(!client)return false;const response=await fetch(url+'/auth/v1/settings',{headers:{apikey:key}});if(!response.ok)throw new Error('无法检查登录服务，请稍后重试');const value=await response.json();return value.external?.github===true;}
