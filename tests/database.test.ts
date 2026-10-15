import {beforeAll,afterAll,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFile,readdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import type {Backup,Context,Row,Item,ListResult} from '../src/domain';
let db:PGlite; let ctx:Context; let plan:string; let item:Row<Item>;
const owner='11111111-1111-4111-8111-111111111111', other='22222222-2222-4222-8222-222222222222';
async function fn<T>(name:string,args:unknown[]=[]):Promise<T>{ const r=await db.query<{result:T}>('select public.'+name+'('+args.map((_,i)=>'$'+(i+1)).join(',')+') as result',args);return r.rows[0].result;}
async function exec(action:string,payload:unknown={},expected:number|null=null,operation=randomUUID(),generation=ctx.generation){ const r=await fn<{id:string;record:Row<Item>}>('planner_execute',[operation,generation,action,JSON.stringify(payload),expected]);ctx=await fn('planner_context');return r; }
beforeAll(async()=>{
  db=new PGlite();await db.exec("create role anon;create role authenticated;create schema auth;create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;");
  const directory=new URL('../supabase/migrations/',import.meta.url);
  for(const name of (await readdir(directory)).filter(n=>n.endsWith('.sql')).sort())await db.exec(await readFile(new URL(name,directory),'utf8'));
  await db.query('update public.planner_control set owner_id=$1',[owner]);await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);await db.exec('set role authenticated');
  ctx=await fn('planner_context'); await exec('create',{kind:'direction',data:{name:'验收方向'}});
  plan=ctx.records.find(x=>x.kind==='plan')!.id;
  const created=await exec('create',{kind:'item',parent_id:plan,data:{title:'验收事项',batch:'第一批',rank:1}});item=created.record;
});
afterAll(async()=>{await db.close();});
it('fixed owner enforced on tables and every RPC; direct writes and helpers denied',async()=>{
  await expect(db.query("update public.planner_records set data='{}'")).rejects.toThrow('permission denied');
  await expect(fn('planner_payload')).rejects.toThrow('permission denied');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[other]);
  expect((await db.query('select * from public.planner_records')).rows).toHaveLength(0);
  await expect(fn('planner_context')).rejects.toThrow('FORBIDDEN');
  await db.exec('reset role;set role anon');
  await expect(fn('planner_context')).rejects.toThrow('permission denied');
  await db.exec('reset role;set role authenticated');
  await db.query("select set_config('request.jwt.claim.sub',$1,false)",[owner]);
});
it('atomic request deduplication and stale revision rejection',async()=>{
  const op=randomUUID(), payload={id:item.id,status:'doing'};
  const a=await exec('status',payload,item.revision,op); const b=await exec('status',payload,item.revision,op);
  expect(a.record.data.actualStart).toBe(b.record.data.actualStart);
  await expect(exec('status',{id:item.id,status:'done'},item.revision)).rejects.toThrow('CONFLICT');
  await expect(exec('status',{id:item.id,status:'done'},item.revision,op)).rejects.toThrow('OPERATION_REUSED');
  item=(await fn<{record:Row<Item>}>('planner_detail',[item.id])).record;
});
it('rejects invalid data without partial history or state changes',async()=>{
  const before=await fn<Backup>('planner_export');
  await expect(exec('edit',{id:item.id,changes:{planStart:'2026-10-16',planEnd:'2026-10-14'}},item.revision)).rejects.toThrow('INVALID_DATE_ORDER');
  await expect(exec('edit',{id:item.id,changes:{title:{bad:true}}},item.revision)).rejects.toThrow('INVALID_TEXT');
  expect((await fn<Backup>('planner_export')).payload).toBe(before.payload);
});
it('completed timestamp stable across repeats, undo retains work and start',async()=>{
  item=(await exec('status',{id:item.id,status:'done'},item.revision)).record;
  const finished=item.data.actualFinish, started=item.data.actualStart;
  item=(await exec('status',{id:item.id,status:'done'},item.revision)).record;expect(item.data.actualFinish).toBe(finished);
  item=(await exec('effort',{id:item.id,data:{minutes:270,on:'2026-10-15',note:'验收投入'}},item.revision)).record;
  item=(await exec('undo',{id:item.id},item.revision)).record;expect(item.data.actualStart).toBe(started);expect(item.data.actualFinish).toBe('');
  const list=await fn<ListResult>('planner_list',[plan,JSON.stringify({status:'done'}),0,50]);
  expect(list.records).toHaveLength(0);expect(list.totals.effortMinutes).toBe(270);expect(list.totals.effective).toBe(1);
});
it('backup and restore preserve records, bump epoch and remove post-backup records',async()=>{
  const backup=await fn<Backup>('planner_export');const generation=ctx.generation;
  const extra=await exec('create',{kind:'item',parent_id:plan,data:{title:'备份后新增'}});
  await exec('restore',{backup},ctx.revision);
  expect(ctx.generation).not.toBe(generation);
  expect((await fn<{record:Row|null}>('planner_detail',[extra.id])).record).toBe(null);
  await expect(exec('daily_snapshot',{},null,randomUUID(),generation)).rejects.toThrow('STALE_GENERATION');
  const data=JSON.parse((await fn<Backup>('planner_export')).payload).records as Row[];
  const previous=JSON.parse(backup.payload).records as Row[];
  for(const row of previous)expect(data.find(x=>x.id===row.id)).toEqual(row);
  item=(await fn<{record:Row<Item>}>('planner_detail',[item.id])).record;
});
it('bad checksum and invalid relation roll back the whole import',async()=>{
  const before=await fn<Backup>('planner_export');
  await expect(exec('restore',{backup:{...before,checksum:'bad'}},ctx.revision)).rejects.toThrow('INVALID_CHECKSUM');
  await expect(exec('restore',{backup:{}},ctx.revision)).rejects.toThrow('INVALID_CHECKSUM');
  expect((await fn<Backup>('planner_export')).payload).toBe(before.payload);
});
it('batch preview invalidation and closure immutable after later edits',async()=>{
  const revision=ctx.revision;
  item=(await exec('edit',{id:item.id,changes:{notes:'变化'}},item.revision)).record;
  await expect(exec('close_batch',{plan_id:plan,batch:'第一批',mode:'stopped'},revision)).rejects.toThrow('RANGE_CHANGED');
  const closure=await exec('close_batch',{plan_id:plan,batch:'第一批',mode:'stopped'},ctx.revision);
  const before=await fn('planner_detail',[closure.id]);
  item=(await exec('edit',{id:item.id,changes:{notes:'再变化'}},item.revision)).record;
  expect(await fn('planner_detail',[closure.id])).toEqual(before);
  await exec('reopen_batch',{id:closure.id},closure.record.revision);
  const reopened=await fn<{record:Row}>('planner_detail',[closure.id]);expect(reopened.record.data).toEqual(closure.record.data);
});
it('last edit can be undone, malformed related IDs cannot enter data',async()=>{
  item=(await exec('edit',{id:item.id,changes:{notes:'可撤销修改'}},item.revision)).record;
  item=(await exec('undo_edit',{id:item.id},item.revision)).record;expect(item.data.notes).toBe('再变化');
  await expect(exec('edit',{id:item.id,changes:{related:[randomUUID()]}},item.revision)).rejects.toThrow('INVALID_RELATED_ITEM');
});
it('manual work corrections retain audit and update coverage',async()=>{
  const detail=await fn<{related:Row[]}>('planner_detail',[item.id]);
  const effort=detail.related.find(r=>r.kind==='effort')!;
  await exec('correct_effort',{id:effort.id,changes:{minutes:300}},effort.revision);
  const updated=await fn<{record:Row}>('planner_detail',[effort.id]);
  await exec('correct_effort',{id:effort.id,changes:{voided:true}},updated.record.revision);
  const result=await fn<ListResult>('planner_list',[plan,'{}',0,50]);expect(result.totals.effortMinutes).toBe(0);expect(result.totals.effortCoverage).toBe(0);
  item=(await fn<{record:Row<Item>}>('planner_detail',[item.id])).record;
});
it('same day daily dedup does not swallow multiple action snapshots',async()=>{
  await exec('daily_snapshot'); await exec('daily_snapshot');
  expect((await db.query("select id from public.planner_snapshots where reason='daily'")).rows).toHaveLength(1);
  await exec('move',{id:item.id,parent_id:plan},item.revision);
  item=(await fn<{record:Row<Item>}>('planner_detail',[item.id])).record;
  await exec('move',{id:item.id,parent_id:plan},item.revision);
  expect((await db.query("select id from public.planner_snapshots where reason='move'")).rows).toHaveLength(2);
});
it('more than 1000 rows remain fully searchable, countable and exportable',async()=>{
  await db.exec('reset role');
  await db.query("insert into public.planner_records(owner_id,kind,parent_id,data) select $1,'item',$2,jsonb_build_object('title',case when n=1100 then '末页目标' else '同名' end,'status','todo','type','content','rank',2,'trashed',false) from generate_series(1,1100)n",[owner,plan]);
  await db.exec('set role authenticated');
  const first=await fn<ListResult>('planner_list',[plan,'{}',0,200]);expect(first.matched).toBe(1101);
  const last=await fn<ListResult>('planner_list',[plan,'{}',1000,200]);expect(last.records).toHaveLength(101);
  const search=await fn<ListResult>('planner_list',[plan,JSON.stringify({q:'末页目标'}),0,50]);expect(search.matched).toBe(1);expect(search.totals.effective).toBe(1101);
  expect(JSON.parse((await fn<Backup>('planner_export')).payload).records.filter((r:Row)=>r.kind==='item')).toHaveLength(1101);
});
it('scope baseline survives added, cancelled and removed items',async()=>{
  const direction=ctx.records.find(r=>r.kind==='direction')!;
  const p=(await exec('create',{kind:'plan',parent_id:direction.id,data:{name:'范围验收'}})).id;
  let a=(await exec('create',{kind:'item',parent_id:p,data:{title:'原定事项',batch:'测试批次'}})).record;
  await exec('create',{kind:'item',parent_id:p,data:{title:'新增事项',batch:'测试批次'}});
  a=(await exec('status',{id:a.id,status:'cancelled'},a.revision)).record;
  let l=await fn<ListResult>('planner_list',[p,JSON.stringify({batch:'测试批次',status:'done'}),0,50]);
  expect(l.matched).toBe(0);expect(l.totals).toMatchObject({original:1,added:1,removed:0,effective:1,cancelled:1});
  await exec('trash',{id:a.id},a.revision);
  l=await fn<ListResult>('planner_list',[p,JSON.stringify({batch:'测试批次'}),0,50]);expect(l.totals).toMatchObject({original:1,added:1,removed:1});
});
it('review is opt-in per plan and list filters do not change progress',async()=>{
  const direction=ctx.records.find(r=>r.kind==='direction')!;
  let p=(await exec('create',{kind:'plan',parent_id:direction.id,data:{name:'复查验收'}})).record;
  await exec('create',{kind:'item',parent_id:p.id,data:{title:'已核验事项',verifiedOn:'2020-08-31',informationType:'B',planEnd:'2020-10-01'}});
  let l=await fn<ListResult>('planner_list',[p.id,JSON.stringify({view:'review'}),0,50]);expect(l.matched).toBe(0);expect(l.totals.effective).toBe(1);
  p=(await exec('edit',{id:p.id,changes:{reviewEnabled:true}},p.revision)).record;
  l=await fn<ListResult>('planner_list',[p.id,JSON.stringify({view:'review'}),0,50]);expect(l.matched).toBe(1);
  expect((await fn<ListResult>('planner_list',[p.id,JSON.stringify({view:'overdue'}),0,50])).matched).toBe(1);
  expect((await fn<ListResult>('planner_list',[p.id,JSON.stringify({view:'upcoming'}),0,50])).matched).toBe(0);
});
it('copy clears execution and plan dates, while history pages have stable boundaries',async()=>{
  let origin=(await exec('create',{kind:'item',parent_id:plan,data:{title:'拷贝验收',planStart:'2026-01-01',planEnd:'2026-01-02',actualStart:'2026-01-01',actualFinish:'2026-01-02',startPrecision:'date',finishPrecision:'date',status:'done',notes:'旧成果记录',links:[{label:'旧成果',url:'https://example.com'}]}})).record;
  origin=(await exec('status',{id:origin.id,status:'done'},origin.revision)).record;
  origin=(await exec('edit',{id:origin.id,changes:{actualStart:'2026-01-01',actualFinish:'2026-01-02',startPrecision:'date',finishPrecision:'date'}},origin.revision)).record;
  const copied=(await exec('copy',{id:origin.id},origin.revision)).record;
  expect(copied.data).toMatchObject({status:'todo',planStart:'',planEnd:'',actualStart:'',actualFinish:'',notes:'',links:[]});
  let r=copied;for(let n=0;n<52;n++)r=(await exec('edit',{id:r.id,changes:{notes:'修改 '+n}},r.revision)).record;
  const page1=await fn<{related:Row[];historyTotal:number}>('planner_detail',[r.id,0]);
  const page2=await fn<{related:Row[]}>('planner_detail',[r.id,50]);
  const history=[...page1.related,...page2.related].filter(r=>r.kind==='event');expect(history.length).toBe(page1.historyTotal);expect(new Set(history.map(r=>r.id)).size).toBe(history.length);
});
it('scope compares actual instants across offsets and closure keeps original scope',async()=>{
  const direction=ctx.records.find(r=>r.kind==='direction')!;
  const p=(await exec('create',{kind:'plan',parent_id:direction.id,data:{name:'时间边界'}})).record;
  let a=(await exec('create',{kind:'item',parent_id:p.id,data:{title:'较早开始',batch:'时区批次',status:'done',actualStart:'2026-10-14T09:00:00+08:00',actualFinish:'2026-10-14T10:00:00+08:00'}})).record;
  a=(await exec('status',{id:a.id,status:'done'},a.revision)).record;await exec('edit',{id:a.id,changes:{actualStart:'2026-10-14T09:00:00+08:00',actualFinish:'2026-10-14T10:00:00+08:00'}},a.revision);
  let b=(await exec('create',{kind:'item',parent_id:p.id,data:{title:'较晚完成',batch:'时区批次',status:'done',actualStart:'2026-10-14T02:00:00Z',actualFinish:'2026-10-14T03:00:00Z'}})).record;
  b=(await exec('status',{id:b.id,status:'done'},b.revision)).record;await exec('edit',{id:b.id,changes:{actualStart:'2026-10-14T02:00:00Z',actualFinish:'2026-10-14T03:00:00Z'}},b.revision);
  const list=await fn<ListResult>('planner_list',[p.id,'{}',0,50]);expect(list.totals.started).toBe('2026-10-14T09:00:00+08:00');expect(list.totals.finished).toBe('2026-10-14T03:00:00Z');
  const closure=(await exec('close_batch',{plan_id:p.id,batch:'时区批次',mode:'completed'},ctx.revision)).record;
  const summary=closure.data.summary as {totals:{effective:number;done:number;original:number};originalMembers:unknown[]};expect(summary.totals).toMatchObject({effective:2,done:2,original:1});expect(summary.originalMembers).toHaveLength(1);
});

it('website name is owner business data with server validation',async()=>{
  const r=(await exec('create',{kind:'settings',data:{name:'websiteName',value:'个人作品安排'}})).record;expect((await fn<Context>('planner_context')).siteName?.data.value).toBe('个人作品安排');
  await expect(exec('edit',{id:r.id,changes:{value:{bad:true}}},r.revision)).rejects.toThrow('INVALID_TEXT');
  await expect(exec('create',{kind:'settings',data:{name:'baseline:plan',value:{}}})).rejects.toThrow('INVALID_KIND');
});
