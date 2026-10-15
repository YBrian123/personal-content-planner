// Development-only browser fixture. Vite refuses to build this mode.
// It executes the real migrations in an isolated PostgreSQL engine, without cloud access.
import {PGlite} from '@electric-sql/pglite';
import initial from '../supabase/migrations/001_planner.sql?raw';
import hardening from '../supabase/migrations/002_workflow_hardening.sql?raw';
import integrity from '../supabase/migrations/003_time_and_closure_integrity.sql?raw';
import type {Session,AuthChangeEvent} from '@supabase/supabase-js';
import type {Backup,Context,Filter,ListResult,Mutation,Row} from '../src/domain';
const uid='11111111-1111-4111-8111-111111111111';
export const instance='qa-isolated',configurationError='';
document.querySelectorAll('.qa-banner').forEach(n=>n.remove());
const banner=document.createElement('div');banner.className='qa-banner';banner.textContent='开发验收环境 · 独立临时数据 · 不连接云端';document.body.prepend(banner);
let failNext='';
for(const [text,kind] of [['下次提交前断开','before'],['下次提交后丢响应','after'],['下次延迟回复 8 秒','delay']]){const button=document.createElement('button');button.textContent=text;button.onclick=()=>{failNext=kind;button.textContent='已安排故障';setTimeout(()=>button.textContent=text,2000);};banner.append(button);}
const database=new PGlite();
const ready=(async()=>{
  await database.exec("create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;");
  await database.exec(initial);await database.exec(hardening);await database.exec(integrity);
  await database.query('update public.planner_control set owner_id=$1',[uid]);
  await database.query("select set_config('request.jwt.claim.sub',$1,false)",[uid]);
  await database.exec('set role authenticated');
  const c=await call<Context>('planner_context');
  await call('planner_execute',[crypto.randomUUID(),c.generation,'create',JSON.stringify({kind:'direction',data:{name:'验收方向',goal:'检查日常操作'}}),null]);
  const plan=(await call<Context>('planner_context')).records.find(r=>r.kind==='plan')!;
  for(let n=1;n<=10;n++)await call('planner_execute',[crypto.randomUUID(),c.generation,'create',JSON.stringify({kind:'item',parent_id:plan.id,data:{title:'验收事项 '+String(n).padStart(2,'0'),batch:n<=3?'首批':'候选池',platform:n%3===0?'视频':'公众号',rank:n,goal:'检查流程与记录',outline:'检查新增、保存、开始、完成与恢复。'}}),null]);
})();
async function call<T>(name:string,args:unknown[]=[]):Promise<T>{const r=await database.query<{value:T}>('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') as value',args);return r.rows[0].value;}
async function rpc<T>(name:string,args:unknown[]=[]):Promise<T>{await ready;return call<T>(name,args);}
let session={access_token:'qa-only',refresh_token:'qa-only',expires_in:3600,token_type:'bearer',user:{id:uid,aud:'authenticated',role:'authenticated',created_at:'2026-10-15T00:00:00Z',app_metadata:{provider:'github'},user_metadata:{user_name:'开发验收'}}} as Session;
const listeners=new Set<(event:AuthChangeEvent,session:Session|null)=>void>();
export const initialize=async()=>{await ready;return session;};
export const login=async()=>{for(const f of listeners)f('SIGNED_IN',session);};
export const logout=async()=>{for(const f of listeners)f('SIGNED_OUT',null);};
export {errorText} from '../src/errors';
export {mutation} from '../src/commands';
import {recordClock} from '../src/commands';
export const providerStatus=async()=>true;
export const api={
  context:async()=>recordClock(await rpc<Context>('planner_context')),
  list:(plan:string,filter:Filter,offset=0,limit=50)=>rpc<ListResult>('planner_list',[plan,JSON.stringify(filter),offset,limit]),
  detail:(id:string,offset=0)=>rpc<{record:Row|null;related:Row[];historyTotal:number}>('planner_detail',[id,offset]),
  export:()=>rpc<Backup>('planner_export'),
  execute:async(m:Mutation)=>{const failure=m.action==='daily_snapshot'?'':failNext;if(m.action!=='daily_snapshot')failNext='';if(failure==='before')throw new Error('network: 请求尚未提交');const result=await rpc<{id:string|null;generation:string;revision:number}>('planner_execute',[m.operation,m.generation,m.action,JSON.stringify(m.payload),m.expected]);if(failure==='delay')await new Promise(resolve=>setTimeout(resolve,8000));if(failure==='after')throw new Error('network: 提交后响应丢失');return result;}
};

type Result={data:unknown;error:unknown};
function reader(table:string){
  let columns='*',single=false,limit=1000;const clauses:string[]=[],params:unknown[]=[];let ordering='created_at desc';
  const query={
    select(value:string){columns=value;return query;},
    eq(field:string,value:unknown){if(!['id','kind','parent_id'].includes(field))throw new Error('Unsupported fixture field');params.push(value);clauses.push(field+'=$'+params.length);return query;},
    order(field:string,options?:{ascending?:boolean}){if(field!=='created_at')throw new Error('Unsupported fixture order');ordering='created_at '+(options?.ascending===false?'desc':'asc');return query;},
    limit(n:number){limit=n;return query;},
    single(){single=true;return query;},
    then(onfulfilled:((r:Result)=>unknown)|undefined,onrejected?:((e:unknown)=>unknown)){
      const run=async():Promise<Result>=>{try{
        await ready;if(!['planner_records','planner_snapshots'].includes(table))throw new Error('Unsupported fixture table');
        if(columns!=='*'&&!/^[a-z_,]+$/.test(columns))throw new Error('Unsupported fixture projection');
        const result=await database.query('select '+columns+' from public.'+table+(clauses.length?' where '+clauses.join(' and '):'')+' order by '+ordering+' limit '+Number(limit),params);
        return {data:single?result.rows[0]:result.rows,error:null};
      }catch(error){return {data:null,error};}};
      return run().then(onfulfilled,onrejected);
    }
  };return query;
}
export const client={auth:{onAuthStateChange(callback:(event:AuthChangeEvent,session:Session|null)=>void){listeners.add(callback);return {data:{subscription:{unsubscribe(){listeners.delete(callback);}}}};}},from:reader};
