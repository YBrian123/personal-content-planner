import {useCallback,useEffect,useRef,useState} from 'react';
import type {Session} from '@supabase/supabase-js';
import {api,client,configurationError,errorText,initialize,instance,login,logout,mutation,providerStatus} from './data';
import {STATUS,chinaDate,checksum,csv,dateTime,due,duration,elapsed,emptyItem,matchesView,period,reviewDate,safeUrl,validateBackup} from './domain';
import type {Backup,Context,Filter,Item,ListResult,Mutation,Row,Status} from './domain';
import {drafts} from './drafts';
import {useDialogs} from './dialogs';
import type {Draft} from './drafts';
const pageName:Record<string,string>={plan:'计划表',resources:'资料与规则',archive:'归档计划',recycle:'回收站',settings:'备份与设置'};
const label=(r:Pick<Row,'data'>)=>String(r.data.name||'未命名');
function download(name:string,text:string,type:string){const u=URL.createObjectURL(new Blob([text],{type}));const a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),2000);}
function preference(key:string,value?:string):string{try{if(value!==undefined)localStorage.setItem(key,value);return localStorage.getItem(key)||'';}catch{return '';}}
export default function App(){
  const {confirm,prompt,cancel:cancelDialog}=useDialogs();
  const [session,setSession]=useState<Session|null>(null),[ctx,setCtx]=useState<Context|null>(null);
  const [initializing,setInitializing]=useState(true),[authEnabled,setAuthEnabled]=useState<boolean|null>(null),[page,setPage]=useState(location.hash.slice(1)||'plan');
  const [plan,setPlan]=useState(''),[filter,setFilter]=useState<Filter>({sort:'rank'}),[offset,setOffset]=useState(0),[list,setList]=useState<ListResult|null>(null);
  const [selected,setSelectedState]=useState<Row<Item>|'new'|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[pending,setPending]=useState<Mutation|null>(null);
  const [backup,setBackup]=useState<{backup:Backup;rows:Row[];added?:number;repeated?:number}|null>(null),[backupRevision,setBackupRevision]=useState<number|null>(null);
  const [resources,setResources]=useState<Row[]>([]),[closures,setClosures]=useState<Row[]>([]),[snapshots,setSnapshots]=useState<Row[]>([]),[showArchived,setShowArchived]=useState(false);
  useEffect(()=>cancelDialog(),[session?.user.id,ctx?.generation,cancelDialog]);
  const epoch=useRef(0),sessionRef=useRef(session),planRef=useRef(plan),readSequence=useRef(0),detailSequence=useRef(0);
  const selectedId=useRef<string|null>(null),editorSequence=useRef(0),contextSequence=useRef(0),importSequence=useRef(0),writeInFlight=useRef<string|null>(null);
  function setSelected(value:Row<Item>|'new'|null){const id=value==='new'?'new':value?.id||null;if(id!==selectedId.current)editorSequence.current++;selectedId.current=id;setSelectedState(value);}
  const dirty=useRef(false),inputFile=useRef<HTMLInputElement>(null);
  sessionRef.current=session;planRef.current=plan;
  useEffect(()=>{
    let alive=true;const initialEpoch=epoch.current;
    providerStatus().then(ready=>{if(alive)setAuthEnabled(ready);}).catch(e=>{if(alive)setError(errorText(e));});
    initialize().then(s=>{if(alive&&initialEpoch===epoch.current)setSession(s);}).catch(e=>{if(alive)setError(errorText(e));}).finally(()=>{if(alive)setInitializing(false);});
    const sub=client?.auth.onAuthStateChange((event,s)=>{
      if(event==='SIGNED_OUT'||sessionRef.current?.user.id!==s?.user.id){epoch.current++;setCtx(null);setList(null);setSelected(null);setResources([]);setClosures([]);setSnapshots([]);setPending(null);setBackup(null);setPlan('');setFilter({sort:'rank'});setBusy(false);setError('');setNotice('');dirty.current=false;}
      setSession(s);
    });
    const hash=()=>setPage(location.hash.slice(1)||'plan');window.addEventListener('hashchange',hash);
    const lock=(event:Event)=>{epoch.current++;setCtx(null);setList(null);setSelected(null);setResources([]);setClosures([]);setSnapshots([]);setBackup(null);setBackupRevision(null);setPending(null);setNotice('');setBusy(false);dirty.current=false;if((event as CustomEvent).detail==='expired'){sessionRef.current=null;setSession(null);}};
    window.addEventListener('planner-auth-invalid',lock);
    return()=>{alive=false;sub?.data.subscription.unsubscribe();window.removeEventListener('hashchange',hash);window.removeEventListener('planner-auth-invalid',lock);};
  },[]);
  const loadContext=useCallback(async()=>{
    const token=epoch.current,user=sessionRef.current?.user.id,sequence=++contextSequence.current;if(!user)return;
    const result=await api.context();if(token!==epoch.current||sequence!==contextSequence.current||sessionRef.current?.user.id!==user)return;
    if(result.schemaVersion!==1)throw new Error('SCHEMA_MISMATCH');
    setCtx(result);
    if(!planRef.current||!result.records.some(x=>x.id===planRef.current)){
      const saved=preference('planner:'+instance+':'+user+':plan');
      const eligible=(x:Row)=>x.kind==='plan'&&!x.data.archived&&!result.records.find(d=>d.id===x.parent_id)?.data.archived;
      const first=result.records.find(eligible);
      const choice=result.records.find(x=>x.id===saved&&eligible(x))||first;
      setPlan(choice?.id||'');
      if(choice){let savedFilter:Filter={sort:'rank',...(choice.data.defaultBatch?{batch:String(choice.data.defaultBatch)}:{})};try{const stored=preference('planner:'+instance+':'+user+':filter:'+choice.id);if(stored)savedFilter=JSON.parse(stored);}catch{}setFilter(savedFilter);}
    }
    return result;
  },[]);
  useEffect(()=>{if(session)loadContext().catch(e=>setError(errorText(e)));},[session?.user.id,loadContext]);
  const loadList=useCallback(async()=>{
    if(!sessionRef.current||!plan)return;const token=epoch.current,sequence=++readSequence.current;
    const result=await api.list(plan,{...filter,trash:page==='recycle'},offset);
    if(token===epoch.current&&sequence===readSequence.current&&planRef.current===plan)setList(result);
  },[plan,filter,offset,page]);
  useEffect(()=>{setList(null);if(plan&&ctx)loadList().catch(e=>setError(errorText(e)));},[loadList,ctx?.generation]);
  useEffect(()=>{if(plan&&session)preference('planner:'+instance+':'+session.user.id+':plan',plan);},[plan,session?.user.id]);
  useEffect(()=>{if(plan&&session&&ctx)preference('planner:'+instance+':'+session.user.id+':filter:'+plan,JSON.stringify(filter));},[plan,session?.user.id,ctx?.generation,filter]);
  useEffect(()=>{
    if(!ctx||!session)return;let active=true;const token=epoch.current;
    const key='planner:daily:'+instance+':'+session.user.id+':'+ctx.generation+':'+chinaDate();
    let op=preference(key);if(!op){op=crypto.randomUUID();preference(key,op);}
    api.execute({operation:op,generation:ctx.generation,action:'daily_snapshot',payload:{},expected:null}).catch(e=>{if(active&&token===epoch.current)setNotice('日常快照未保存：'+errorText(e));});
    return()=>{active=false;};
  },[ctx?.generation,session?.user.id]);
  useEffect(()=>{
    if(!client||!ctx||!session||!['resources','settings'].includes(page))return;
    let alive=true;const token=epoch.current;
    if(page==='resources')client.from('planner_records').select('*').eq('kind','reference').eq('parent_id',plan).order('created_at').then(({data,error:e})=>{if(alive&&token===epoch.current){if(e)setError(errorText(e));else setResources(data as Row[]||[]);}});
    if(page==='resources')client.from('planner_records').select('*').eq('kind','closure').eq('parent_id',plan).order('created_at',{ascending:false}).then(({data,error:e})=>{if(alive&&token===epoch.current){if(e)setError(errorText(e));else setClosures(data as Row[]||[]);}});
    if(page==='settings')client.from('planner_snapshots').select('id,reason,bytes,created_at').order('created_at',{ascending:false}).limit(30).then(({data,error:e})=>{if(alive&&token===epoch.current){if(e)setError(errorText(e));else setSnapshots((data||[]).map(x=>({id:x.id,kind:'settings' as const,parent_id:null,revision:1,created_at:x.created_at,updated_at:x.created_at,data:{reason:x.reason,bytes:x.bytes}})));}});
    return()=>{alive=false;};
  },[page,ctx?.revision,plan,session?.user.id]);
  async function navigate(next:string){if(dirty.current&&!await confirm('详情有未保存内容，草稿会保留。离开当前详情？'))return;dirty.current=false;setSelected(null);location.hash=next;setOffset(0);setError('');}
  useEffect(()=>{if(!ctx||!session)return;const token=epoch.current;
    drafts.find(session.user.id,instance,'pendingOperation').then(found=>{if(token===epoch.current&&found.length){setPending(found[0].values.request as unknown as Mutation);setNotice('发现上次结果待确认的提交，请先核对。');}}).catch(e=>setError(errorText(e)));
  },[ctx?.generation,session?.user.id]);
  async function perform(m:Mutation):Promise<boolean>{
    if(writeInFlight.current)return false;
    if(pending&&pending.operation!==m.operation){setError('请先确认上次提交的结果，再进行新的修改。');return false;}
    const token=epoch.current,user=sessionRef.current?.user.id;if(!user)return false;
    writeInFlight.current=m.operation;const requestKey=['operation',instance,user,m.operation].join(':');let issued=false;
    setBusy(true);setError('');setNotice('正在保存…');
    try{
      await drafts.save({key:requestKey,user,instance,item:'pendingOperation',editor:m.operation,version:1,generation:m.generation,revision:m.expected||0,updatedAt:new Date().toISOString(),values:{request:m}});
      if(token!==epoch.current)return false;
      issued=true;await api.execute(m);
      await drafts.clearVersion(requestKey,1).catch(()=>{});
      if(token!==epoch.current)return false;
      const outstanding=await drafts.find(user,instance,'pendingOperation').catch(()=>[]);setPending(outstanding.length?outstanding[0].values.request as unknown as Mutation:null);setNotice(outstanding.length?'已保存；另有上次提交等待核对。':'已保存');
      try{const c=await loadContext();if(c&&planRef.current===plan)await loadList();}catch(e){setError('操作已保存，重新读取失败：'+errorText(e));}
      return true;
    }catch(e){if(token!==epoch.current)return false;const message=String((e as {message?:string})?.message||e);setError(errorText(e));
      if(issued&&/fetch|network|timeout|upstream/i.test(message)){setPending(m);setNotice('结果待确认，原请求已保留在本机。');}
      else{await drafts.clearVersion(requestKey,1).catch(()=>{});setPending(null);setNotice('');}
      if(/JWT|PGRST30[12]|FORBIDDEN/i.test(message)){epoch.current++;setCtx(null);setList(null);setSelected(null);setResources([]);setClosures([]);setSnapshots([]);setBusy(false);}
      return false;
    }finally{if(writeInFlight.current===m.operation)writeInFlight.current=null;if(token===epoch.current)setBusy(false);}
  }
  function changeFilter(key:keyof Filter,value:string){setFilter(f=>({...f,[key]:value}));setOffset(0);}
  async function openItem(id:string){
    if(dirty.current&&!await confirm('当前详情尚未保存，草稿会保留。切换事项？'))return;
    dirty.current=false;const token=epoch.current,sequence=++detailSequence.current;setSelected(null);
    try{const detail=await api.detail(id);if(token===epoch.current&&sequence===detailSequence.current&&detail.record)setSelected(detail.record as Row<Item>);}catch(e){setError(errorText(e));}
  }
  async function stateAction(row:Row<Item>,action:string,status?:Status){
    if(!ctx)return;const selectionSequence=detailSequence.current;
    if(action==='refresh'||await perform(mutation(ctx,action,{id:row.id,...(status?{status}:{} )},row.revision))){
      const token=epoch.current;const detail=await api.detail(row.id);
      if(token===epoch.current&&selectedId.current===row.id&&selectionSequence===detailSequence.current)setSelected(detail.record as Row<Item>);
    }
  }
  async function signOut(){
    const user=sessionRef.current?.user.id;if(!user)return;
    if((dirty.current||pending)&&!await confirm('退出会清理本入口的私人草稿和待确认请求。请先核对保存结果或复制内容，确定退出？'))return;
    epoch.current++;sessionRef.current=null;setSession(null);setCtx(null);setList(null);setSelected(null);setResources([]);setClosures([]);setSnapshots([]);setBackup(null);setPending(null);setBusy(false);dirty.current=false;
    const problems:string[]=[];
    try{await logout();}catch(e){problems.push('退出确认：'+errorText(e));}
    try{await drafts.clearUser(user);}catch(e){problems.push('本机草稿未清除：'+errorText(e));}
    setError(problems.join('；'));setNotice(problems.length?'页面已锁定，请核对退出提示。':'已退出，已清理本机草稿。');
  }
  async function createGroup(kind:'direction'|'plan'){
    if(!ctx)return;const name=await prompt(kind==='direction'?'新方向名称':'新计划名称');if(!name?.trim())return;
    const current=ctx.records.find(r=>r.id===plan);
    let parent=current?.parent_id;
    if(kind==='plan'&&!parent){setError('请先建立一个方向');return;}
    await perform(mutation(ctx,'create',{kind,data:{name:name.trim(),archived:false},...(kind==='plan'?{parent_id:parent}:{})}));
  }
  async function exportBackup(){
    const token=epoch.current;try{const b=await api.export();if(token!==epoch.current)return;download('我的内容规划-'+chinaDate()+'.json',JSON.stringify(b),'application/json');preference('planner:last-export:'+instance, new Date().toISOString());setNotice('备份已生成并触发下载。请确认文件落盘并妥善保存。');}catch(e){if(token===epoch.current)setError(errorText(e));}
  }
  async function exportCsv(){
    const token=epoch.current;try{
      const b=await validateBackup(await api.export());if(token!==epoch.current)return;
      const items=(b.rows.filter(r=>r.kind==='item'&&r.parent_id===plan) as Row<Item>[]).filter(r=>{
        const d=r.data;return !!d.trashed===(page==='recycle')&&(!filter.batch||d.batch===filter.batch)&&(!filter.platform||d.platform===filter.platform)&&(!filter.group||d.group===filter.group)&&(!filter.status||d.status===filter.status)&&matchesView(d,filter.view,!!ctx?.records.find(p=>p.id===plan)?.data.reviewEnabled)&&(!filter.q||[d.title,d.sourceCode,d.notes].join(' ').toLowerCase().includes(filter.q.toLowerCase()));
      }).map(r=>({...r,data:{...r.data,effortMinutes:b.rows.some(e=>e.kind==='effort'&&e.parent_id===r.id&&!e.data.voided)?b.rows.filter(e=>e.kind==='effort'&&e.parent_id===r.id&&!e.data.voided).reduce((s,e)=>s+Number(e.data.minutes),0):undefined}}));
      download('计划表-'+chinaDate()+'.csv',csv(items),'text/csv;charset=utf-8');setNotice('已导出全部 '+items.length+' 条匹配事项');
    }catch(e){if(token===epoch.current)setError(errorText(e));}
  }
  async function importFile(file:File){
    const token=epoch.current,sequence=++importSequence.current;setBackup(null);setBackupRevision(null);setError('');setNotice('');
    try{if(file.size>16777216)throw new Error('BACKUP_CAPACITY');const parsed=await validateBackup(JSON.parse(await file.text()));if(token!==epoch.current||sequence!==importSequence.current)return;const current=await api.export();const existing=new Set((await validateBackup(current)).rows.map(r=>r.id));if(token!==epoch.current||sequence!==importSequence.current)return;setBackup({...parsed,added:parsed.rows.filter(r=>!existing.has(r.id)).length,repeated:parsed.rows.filter(r=>existing.has(r.id)).length});setBackupRevision(current.revision??ctx?.revision??null);}catch(e){if(token===epoch.current&&sequence===importSequence.current)setError(errorText(e));}
  }
  async function restore(action:'restore'|'merge'){
    if(!ctx||!backup||backupRevision===null)return;
    if(!await confirm(action==='restore'?'完整恢复会将当前业务集合恢复为文件中的状态，备份后新增事项退出当前集合。继续？':'增加新编号记录，冲突保留当前内容。继续？'))return;
    if(await perform(mutation(ctx,action,{backup:backup.backup},backupRevision))){setBackup(null);setSelected(null);dirty.current=false;}
  }
  async function closeBatch(){
    if(!ctx||!filter.batch){setError('请先填写并筛选要结项的批次名称');return;}
    const before=await api.list(plan,{batch:filter.batch},0,1);
    const mode=before.totals.effective>0&&before.totals.done===before.totals.effective?'completed':'stopped';
    if(!await confirm('批次“'+filter.batch+'”：完成 '+before.totals.done+'/'+before.totals.effective+'，取消 '+before.totals.cancelled+'。将记录为'+(mode==='completed'?'全部完成':'本轮停止')+'，确认结项？'))return;
    const note=await prompt('本轮复盘备注（可空）');if(note===null)return;
    await perform(mutation(ctx,'close_batch',{plan_id:plan,batch:filter.batch,mode,note},before.revision));
  }
  const plans=ctx?.records.filter(r=>r.kind==='plan')||[],directions=ctx?.records.filter(r=>r.kind==='direction')||[];
  const currentPlan=plans.find(r=>r.id===plan),totals=list?.totals;
  const overview=(id:string|null|undefined)=>ctx?.overview?.find(x=>x.id===id);
  const compactProgress=(id:string|null|undefined)=>{const p=overview(id);return p?p.effective?p.done+'/'+p.effective:p.total?'无有效事项':'尚无事项':'—';};
  const siteTitle=String(ctx?.siteName?.data.value||'我的内容规划');
  const lastExport=preference('planner:last-export:'+instance);
  const backupDue=!lastExport||Date.now()-Date.parse(lastExport)>7*86400000;
  useEffect(()=>{document.title=siteTitle;},[siteTitle]);
  const scopeName=filter.batch||label(currentPlan||{data:{name:'当前计划'}});
  const renderedEditor=editorSequence.current;
  return <div className="shell">
    <aside className="sidebar"><div className="brand"><span className="brand-icon">✓</span><div><strong>{siteTitle}</strong><small>把想法，慢慢做成作品</small></div></div>
      <nav>{Object.entries(pageName).map(([key,name])=><button key={key} className={page===key?'nav-active':''} onClick={()=>navigate(key)}><span>{({plan:'▤',resources:'▧',archive:'▱',recycle:'↶',settings:'⚙'} as Record<string,string>)[key]}</span>{name}</button>)}</nav>
      <div className="sidebar-label">内容方向 <button title="新建方向" disabled={!ctx||busy} onClick={()=>createGroup('direction')}>＋</button></div>
      {directions.filter(d=>showArchived||!d.data.archived).map(direction=><section className="direction" key={direction.id}><div className="direction-name">{label(direction)} <small>{compactProgress(direction.id)}</small></div>
        {plans.filter(p=>p.parent_id===direction.id&&(showArchived||!p.data.archived)).map(p=><button className={plan===p.id?'plan-active':''} key={p.id} onClick={async()=>{if(dirty.current&&!await confirm('草稿会保留，切换计划？'))return;dirty.current=false;setSelected(null);setPlan(p.id);setOffset(0);let saved:Filter={sort:'rank',...(p.data.defaultBatch?{batch:String(p.data.defaultBatch)}:{})};try{const f=preference('planner:'+instance+':'+session!.user.id+':filter:'+p.id);if(f)saved=JSON.parse(f);}catch{}setFilter(saved);navigate('plan');}}>{label(p)} <small>{compactProgress(p.id)}</small></button>)}</section>)}
      {!directions.length&&<p className="muted sidebar-empty">连接后，在这里管理不同的内容方向。</p>}
      <button className="subtle" disabled={!ctx} onClick={()=>createGroup('plan')}>＋ 新建计划</button>
      <label className="show-archived"><input type="checkbox" checked={showArchived} onChange={e=>setShowArchived(e.target.checked)}/>显示归档方向与计划</label>
      <div className="sidebar-footer"><i className={ctx?'online':''}/>{ctx?'已连接个人数据':'等待连接'}<small>记录、安排、完成、回看</small></div>
    </aside>
    <main className="main"><header className="topbar"><span>{pageName[page]||'计划表'}</span><div>{session&&<><span className="user">{session.user.user_metadata.user_name||'本人'}</span><button className="link-button" onClick={signOut}>退出</button></>}<span className="date">{chinaDate()}</span></div></header>
      <div className="main-content">
      {error&&<div className="alert" role="alert">{error}<button onClick={()=>setError('')} aria-label="关闭错误">×</button></div>}
      {notice&&<div className="notice" role="status">{notice}{pending&&<><span>原操作时间：{dateTime(String(pending.payload.occurredAt||''))}</span><button disabled={busy} onClick={()=>void perform(pending)}>核对并重试</button></>}</div>}
      {!ctx?<section className="welcome"><div className="eyebrow">PERSONAL CONTENT PLANNER</div><h1>每一个想法，<br/>都有下一步。</h1><p>把选题放进计划，记下开始和完成的时间。<br/>以后回看，也知道自己是怎样一步步做出来的。</p>
        <div className="welcome-card"><span className="step-badge">01</span><div><h2>{configurationError?'连接你的个人数据':session?'正在确认本人权限':'登录，接着上次的计划'}</h2><p>{configurationError?'数据服务配置完成后，使用你的 GitHub 账号登录。已保存的数据会在本机与线上入口共用。':session?'如果这是首次使用，需要在数据服务后台绑定本人身份。':'规划仅在本人登录后可查看和修改。'}</p>
        {!configurationError&&!session&&<button className="primary" onClick={()=>login().catch(e=>setError(errorText(e)))} disabled={initializing||authEnabled!==true}>使用 GitHub 登录 →</button>}
        {!configurationError&&!session&&authEnabled===false&&<p>登录服务尚未启用，配置完成后即可继续。</p>}{configurationError&&<details><summary>查看连接配置</summary><p>在本机 .env 中填写 Supabase 项目 URL、publishable key 和项目标识，再重启页面。后台秘密不放入页面配置。</p><code>VITE_SUPABASE_URL<br/>VITE_SUPABASE_PUBLISHABLE_KEY<br/>VITE_SUPABASE_PROJECT_ID</code></details>}
        {session&&!ctx&&<><p className="mono">本人标识：{session.user.id}</p><button onClick={()=>loadContext().catch(e=>setError(errorText(e)))}>重新检查连接</button></>}
        </div></div><div className="welcome-features"><span>✓ 完成有日期</span><span>✓ 历时与投入分开</span><span>✓ 备份可带走</span></div></section>:
      <>
      {page==='plan'&&backupDue&&<div className="backup-reminder">{lastExport?'距离上次触发独立备份已超过 7 天。':'还没有独立备份记录。'}<button className="link-button" onClick={exportBackup}>下载 JSON 备份</button></div>}
      {['plan','recycle'].includes(page)&&<><div className="heading-row"><div><div className="eyebrow">{page==='recycle'?'RECYCLE BIN':'YOUR NEXT CHAPTER'}</div><h1>{page==='recycle'?'回收站':currentPlan?label(currentPlan):'先建立一份计划'}</h1><p className="muted">{page==='recycle'?'误删的事项可以恢复，时间与投入继续保留。':String(currentPlan?.data.goal||'从一件小事开始，完成后留下记录。')}</p></div><button className="primary" disabled={!plan||busy} onClick={async()=>{if(dirty.current&&!await confirm('草稿保留，新建事项？'))return;dirty.current=false;setSelected('new');}}>＋ 新增事项</button></div>
        {page==='plan'&&<><div className="scope-chips"><span>当前计划 {compactProgress(plan)}</span><span>内容方向 {compactProgress(currentPlan?.parent_id)}</span>{filter.batch&&<button className="link-button" onClick={()=>changeFilter('batch','')}>查看整个计划 →</button>}</div><div className="stats"><div className="stat progress-stat"><small>{scopeName} · 有效进度</small><strong>{totals&&totals.effective>0?<>{totals.done}<em> / {totals.effective}</em></>:'—'}</strong><div className="progress"><i style={{width:totals&&totals.effective>0?totals.done/totals.effective*100+'%':'0%'}}/></div><span>{totals?totals.total===0?'尚无事项':totals.effective===0?'无有效事项':'首次范围 '+(totals.original??totals.total)+' 项 · 新增 '+(totals.added??0)+' · 移出 '+(totals.removed??0)+' · 取消 '+totals.cancelled:'等待读取'}</span></div>
          <div className="stat"><small>已完成内容</small><strong>{totals?.content??'—'}<em> 项</em></strong><span>辅助工作完成 {totals?.support??0} 项</span></div>
          <div className="stat"><small>实际投入</small><strong className="time-stat">{totals&&totals.effortCoverage>0?duration(totals.effortMinutes):'未记录'}</strong><span>覆盖 {totals?.effortCoverage??0}/{totals?.effective??0} 项{totals?.cancelledEffort?' · 取消项另投入 '+duration(totals.cancelledEffort):''}</span></div>
          <div className="stat"><small>计划时间概况</small><strong className="time-stat">{totals&&totals.effective===0?totals.total?'无有效事项':'尚无事项':!totals?.started&&!totals?.finished?'尚未开始':totals?.effective&&totals.done===totals.effective?'已完成':'仍在进行'}</strong><span>{totals?period(totals):'等待读取'}</span></div></div>
        </>}<section className="table-card"><div className="filters"><input aria-label="搜索事项" placeholder="搜索标题、编号或备注" value={filter.q||''} onChange={e=>changeFilter('q',e.target.value)}/>
          <select aria-label="状态筛选" value={filter.status||''} onChange={e=>changeFilter('status',e.target.value)}><option value="">全部状态</option>{Object.entries(STATUS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>
          <input className="batch-filter" aria-label="批次筛选" placeholder="批次（例如：首轮 10 篇）" value={filter.batch||''} onChange={e=>changeFilter('batch',e.target.value)}/>
          <input className="batch-filter" aria-label="分组筛选" placeholder="分组／卷" value={filter.group||''} onChange={e=>changeFilter('group',e.target.value)}/><select aria-label="平台筛选" value={filter.platform||''} onChange={e=>changeFilter('platform',e.target.value)}><option value="">全部平台</option>{['公众号','视频','小红书','其他'].map(k=><option key={k}>{k}</option>)}</select>
          <select aria-label="排序" value={filter.sort||'rank'} onChange={e=>changeFilter('sort',e.target.value)}>{[['rank','制作顺序'],['deadline','计划结束'],['finished','完成时间'],['elapsed','历时'],['priority','优先级']].map(([v,n])=><option key={v} value={v}>{n}</option>)}</select>
          <select aria-label="日常清单" value={filter.view||''} onChange={e=>changeFilter('view',e.target.value)}><option value="">全部事项</option><option value="doing">正在进行</option><option value="upcoming">未来七天</option><option value="overdue">计划日期已过</option><option value="unscheduled">未排期</option>{!!currentPlan?.data.reviewEnabled&&<option value="review">待复查</option>}</select><button onClick={async()=>{setFilter({sort:'rank'});setOffset(0);}}>清除筛选</button><button onClick={()=>loadContext().then(loadList).catch(e=>setError(errorText(e)))} disabled={busy}>刷新</button></div>
          <div className="table-meta"><span>显示 {list?.matched??0} 条 · 筛选不会改变计划进度分母</span><div><button className="link-button" disabled={busy||!plan} onClick={exportCsv}>导出计划表</button><button className="link-button" disabled={busy||!filter.batch||page!=='plan'} onClick={closeBatch}>批次结项</button></div></div>
          <div className="table-wrap"><table><thead><tr><th>完成</th><th>事项</th><th>平台／状态</th><th>计划结束</th><th>时间记录</th><th/></tr></thead><tbody>{list?.records.map(row=><tr key={row.id}><td><input type="checkbox" aria-label={'完成 '+row.data.title} checked={row.data.status==='done'} disabled={busy||!!row.data.trashed} onChange={e=>stateAction(row,e.target.checked?'status':'undo',e.target.checked?'done':undefined)}/></td>
            <td><button className="item-title" onClick={()=>openItem(row.id)}>{row.data.title}</button><div className="item-meta">{row.data.sourceCode||'自主选题'}{row.data.group?' · '+row.data.group:''}{row.data.batch?' · '+row.data.batch:''}{row.data.type==='support'?' · 辅助工作':''}</div></td>
            <td><div className="platform">{row.data.platform}</div><span className={'status '+row.data.status}>{STATUS[row.data.status]}</span></td>
            <td>{row.data.planEnd||<span className="muted">未排期</span>}<small className="due">{due(row.data)}</small></td><td><span className="time-cell">{elapsed(row.data)}</span><small className="muted">{row.data.actualFinish?'完成 '+dateTime(row.data.actualFinish):row.data.actualStart?'开始 '+dateTime(row.data.actualStart):'日期待记录'}</small></td>
            <td>{page==='recycle'?<button disabled={busy} onClick={()=>stateAction(row,'untrash')}>恢复</button>:row.data.status==='todo'?<button className="link-button" disabled={busy} onClick={()=>stateAction(row,'status','doing')}>开始</button>:<button className="link-button" onClick={()=>openItem(row.id)}>查看 →</button>}</td></tr>)}</tbody></table></div>
          {!list?.records.length&&<div className="empty-state"><span>▤</span><h3>{!plan?'还没有计划':list?'这里还没有匹配的事项':'正在读取计划…'}</h3><p>{list?'可以调整筛选，或记下一个新想法。':'保存过的事项会在这里显示。'}</p></div>}
          <div className="pagination"><span>{list?.matched?offset+1:0}–{Math.min(offset+50,list?.matched||0)} / {list?.matched||0}</span><div><button disabled={offset===0} onClick={()=>setOffset(o=>Math.max(0,o-50))}>上一页</button><button disabled={!list||offset+50>=list.matched} onClick={()=>setOffset(o=>o+50)}>下一页</button></div></div></section>
      </>}
      {page==='archive'&&<><div className="heading-row"><div><div className="eyebrow">KEEP YOUR HISTORY</div><h1>归档计划</h1><p className="muted">把暂时不用的方向与计划收起来，需要时再继续。</p></div></div><div className="cards">{ctx.records.map(r=><article className="info-card" key={r.id}><small>{r.kind==='direction'?'内容方向':'具体计划'}</small><h2>{label(r)}</h2><p>{r.data.archived?'已归档':'使用中'}</p><div><button disabled={busy} onClick={async()=>{const name=await prompt('修改名称',label(r));if(name?.trim())await perform(mutation(ctx,'edit',{id:r.id,changes:{name:name.trim()}},r.revision));}}>改名</button><button disabled={busy} onClick={async()=>{const goal=await prompt('修改目标',String(r.data.goal||''));if(goal!==null)await perform(mutation(ctx,'edit',{id:r.id,changes:{goal}},r.revision));}}>目标</button>{r.kind==='plan'&&<><button disabled={busy} onClick={()=>perform(mutation(ctx,'edit',{id:r.id,changes:{reviewEnabled:!r.data.reviewEnabled}},r.revision))}>{r.data.reviewEnabled?'关闭复查周期':'启用复查周期'}</button><button disabled={busy} onClick={async()=>{const defaultCriteria=await prompt('新增事项的默认完成标准',String(r.data.defaultCriteria||''));if(defaultCriteria!==null)await perform(mutation(ctx,'edit',{id:r.id,changes:{defaultCriteria}},r.revision));}}>完成标准</button></>}<button disabled={busy} onClick={async()=>{if(await perform(mutation(ctx,r.data.archived?'unarchive':'archive',{id:r.id},r.revision))&&!r.data.archived&&(r.id===plan||currentPlan?.parent_id===r.id)){planRef.current='';setPlan('');setFilter({sort:'rank'});await loadContext();}}}>{r.data.archived?'恢复':'归档'}</button></div></article>)}</div></>}
      {page==='resources'&&<><div className="heading-row"><div><div className="eyebrow">SOURCES & GUIDELINES</div><h1>资料与规则</h1><p className="muted">每份计划关联自己的来源与规范，保留版本。</p></div><button className="primary" disabled={!plan} onClick={async()=>{const name=await prompt('资料名称');if(!name?.trim())return;const text=await prompt('资料文本（可空）');if(text===null)return;const url=await prompt('网页链接（可空）');if(url===null)return;await perform(mutation(ctx,'create',{kind:'reference',parent_id:plan,data:{name,text,url,sourceVersion:''}}));}}>＋ 添加资料</button></div>
        <div className="cards">{resources.map(r=><article className="info-card reference" key={r.id}><h2>{label(r)}</h2><small>{String(r.data.sourceVersion||'版本待补充')}</small><button disabled={busy} onClick={async()=>{const text=await prompt('更新资料文本（原文件保持原样）',String(r.data.text||''));if(text===null)return;const sourceVersion=await prompt('新快照版本',String(r.data.sourceVersion||''));if(sourceVersion===null)return;if(await confirm('文本由 '+String(r.data.text||'').length+' 字更新为 '+text.length+' 字，版本为 '+sourceVersion+'，确认保存快照？'))await perform(mutation(ctx,'edit',{id:r.id,changes:{text,sourceVersion}},r.revision));}}>更新快照</button>{safeUrl(String(r.data.url||''))&&<a href={safeUrl(String(r.data.url))!} target="_blank" rel="noreferrer">打开来源 ↗</a>}{Boolean(r.data.path)&&<button onClick={()=>navigator.clipboard.writeText(String(r.data.path)).then(()=>setNotice('路径已复制')).catch(()=>setError('复制失败，请手动选择路径'))}>复制文件路径</button>}<details><summary>查看资料文本</summary><pre>{String(r.data.text||'尚未添加文本')}</pre></details></article>)}</div>{!resources.length&&<div className="empty-state"><h3>为当前计划添加来源</h3><p>可以导入带版本的私有文本，原文件继续作为源稿保留。</p></div>}<h2 className="section-heading">批次回看</h2><div className="cards">{closures.map(c=><article className="info-card" key={c.id}><small>{dateTime(String(c.data.closedAt))}</small><h2>{String(c.data.name)}</h2><p>{c.data.mode==='completed'?'本轮完成':'本轮停止'} · {String(c.data.note||'尚未添加复盘备注')}</p><p>当时有效进度 {String((c.data.summary as {totals?:{done:number;effective:number}})?.totals?.done??'—')}/{String((c.data.summary as {totals?:{done:number;effective:number}})?.totals?.effective??'—')}</p><details><summary>查看原定范围与结项口径</summary><pre>{JSON.stringify(c.data.summary,null,2)}</pre></details><details><summary>查看结项时名单与时间</summary><pre>{JSON.stringify(c.data.members,null,2)}</pre></details><button disabled={busy} onClick={async()=>{if(await perform(mutation(ctx,'reopen_batch',{id:c.id},c.revision))){setFilter({sort:'rank',batch:String(c.data.name)});navigate('plan');}}}>重新打开这批安排</button></article>)}</div></>}
      {page==='settings'&&<><div className="heading-row"><div><div className="eyebrow">KEEP YOUR WORK</div><h1>备份与设置</h1><p className="muted">把记录留在自己手里，也为下一次继续做准备。</p></div></div>
        <div className="cards"><article className="info-card"><h2>网站名称</h2><p>{siteTitle}</p><button disabled={busy} onClick={async()=>{const value=await prompt('网站名称',siteTitle);if(!value?.trim())return;if(value.trim().length>50){setError('网站名称请控制在50字以内');return;}const r=ctx.siteName;await perform(mutation(ctx,r?'edit':'create',r?{id:r.id,changes:{value:value.trim()}}:{kind:'settings',data:{name:'websiteName',value:value.trim()}},r?.revision));}}>修改名称</button></article><article className="info-card"><h2>独立数据备份</h2><p>JSON 包含事项、时间、投入、历史、结项与资料引用。正文和成片文件需要另行备份。</p><button className="primary" onClick={exportBackup} disabled={busy}>下载完整 JSON</button><p className="muted">最近触发下载：{preference('planner:last-export:'+instance)?dateTime(preference('planner:last-export:'+instance)):'尚未记录'}</p></article>
          <article className="info-card"><h2>导入或恢复</h2><p>合并增加新记录，完整恢复回到备份中的业务状态。先校验、预览，再确认。</p><input ref={inputFile} type="file" accept=".json,application/json" onChange={e=>{const f=e.target.files?.[0];if(f)void importFile(f);e.target.value='';}}/>
          {backup&&<div className="import-preview"><strong>校验通过 · {backup.rows.length} 条记录</strong><p>事项 {backup.rows.filter(r=>r.kind==='item').length} 条；备份时间 {dateTime(backup.backup.exportedAt)}</p>{backup.added!==undefined&&<p>新增 {backup.added} 条，同编号 {backup.repeated} 条。合并保留当前同编号内容。</p>}<p>预览使用当前修订 {backupRevision}；内容变化后需要重新预览。</p><button disabled={busy} onClick={()=>restore('merge')}>合并导入</button><button className="danger" disabled={busy} onClick={()=>restore('restore')}>完整恢复</button></div>}</article>
          <article className="info-card"><h2>当前连接</h2><p className="mono">{instance}</p><p>数据结构版本 {ctx.schemaVersion} · 修订 {ctx.revision}</p><p className="muted">本机和线上使用同一数据库。临时草稿只在当前浏览器入口可找回。</p></article>
          <article className="info-card"><h2>应用快照</h2><p>用于找回误操作，和正式数据保存在同一服务中。独立 JSON 请另外保存。</p>{snapshots.map(s=><div className="snapshot" key={s.id}><span>{dateTime(s.created_at)} · {String(s.data.reason)}<small>{(Number(s.data.bytes)/1024).toFixed(1)} KB</small></span><button disabled={busy} onClick={async()=>{
            const token=epoch.current,sequence=++importSequence.current;setBackup(null);setBackupRevision(null);setError('');setNotice('');
            try{const {data,error:e}=await client!.from('planner_snapshots').select('payload').eq('id',s.id).single();if(token!==epoch.current||sequence!==importSequence.current)return;if(e)throw e;
              const payload=JSON.stringify(data.payload);const b:Backup={format:'personal-planner',payload,checksum:await checksum(payload),exportedAt:s.created_at,count:data.payload.records.length};const preview=await validateBackup(b);if(token!==epoch.current||sequence!==importSequence.current)return;setBackup(preview);setBackupRevision(ctx.revision);setNotice('快照已加载到恢复预览，请在上方核对。');
            }catch(e){if(token===epoch.current&&sequence===importSequence.current)setError(errorText(e));}
          }}>预览恢复</button></div>)}</article></div></>}
      </>}
      </div>
    </main>
    {selected&&ctx&&session&&<Editor key={selected==='new'?'new':selected.id} row={selected==='new'?null:selected} planId={plan} plans={plans} context={ctx} user={session.user.id} busy={busy}
      onDirty={v=>{dirty.current=v;}} onError={setError} onClose={async()=>{if(dirty.current&&!await confirm('未保存输入会留在草稿，确定关闭？'))return;dirty.current=false;setSelected(null);}}
      perform={perform} onAction={stateAction} onSaved={()=>{if(renderedEditor!==editorSequence.current)return;dirty.current=false;setSelected(null);}}/>}
  </div>;
}

function Editor({row,planId,plans,context,user,busy,onDirty,onError,onClose,perform,onAction,onSaved}:{row:Row<Item>|null;planId:string;plans:Row[];context:Context;user:string;busy:boolean;onDirty:(v:boolean)=>void;onError:(s:string)=>void;onClose:()=>void;perform:(m:Mutation)=>Promise<boolean>;onAction:(r:Row<Item>,a:string,s?:Status)=>Promise<void>;onSaved:()=>void}){
  const {confirm,prompt}=useDialogs();
  const [values,setValues]=useState<Item>(()=>({...emptyItem(String(plans.find(p=>p.id===planId)?.data.defaultCriteria||'')),...row?.data}));
  const [available,setAvailable]=useState<Draft[]>([]),[related,setRelated]=useState<Row[]>([]),[historyTotal,setHistoryTotal]=useState(0),[minutes,setMinutes]=useState(''),[note,setNote]=useState(''),[linkInput,setLinkInput]=useState('');
  const editor=useRef(crypto.randomUUID()),version=useRef(0),latest=useRef(values),dirty=useRef(false),changed=useRef(new Set<keyof Item>()),generation=useRef(context.generation),itemId=row?.id||'new:'+planId;
  const mounted=useRef(false),panel=useRef<HTMLElement>(null),closeEditor=useRef(onClose);
  closeEditor.current=onClose;
  useEffect(()=>{
    mounted.current=true;const previous=document.activeElement as HTMLElement|null;
    panel.current?.querySelector<HTMLInputElement>('input')?.focus();
    const keyboard=(e:KeyboardEvent)=>{
      if(document.querySelector('dialog[open]'))return;
      if(e.key==='Escape'){e.preventDefault();closeEditor.current();return;}
      if(e.key!=='Tab'||!panel.current)return;
      const nodes=[...panel.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,a[href]')].filter(n=>n.getClientRects().length>0);
      const first=nodes[0],last=nodes.at(-1);if(!first||!last)return;
      if(e.shiftKey&&(document.activeElement===first||!panel.current.contains(document.activeElement))){e.preventDefault();last.focus();}
      else if(!e.shiftKey&&(document.activeElement===last||!panel.current.contains(document.activeElement))){e.preventDefault();first.focus();}
    };
    document.addEventListener('keydown',keyboard);
    return()=>{mounted.current=false;document.removeEventListener('keydown',keyboard);if(previous?.isConnected)previous.focus();};
  },[]);
  const key=[instance,user,itemId,editor.current].join(':');latest.current=values;
  const revision=row?.revision||0;
  useEffect(()=>{let alive=true;drafts.find(user,instance,itemId).then(ds=>{if(alive)setAvailable(ds.filter(d=>d.editor!==editor.current));}).catch(e=>onError(errorText(e)));
    if(row)api.detail(row.id).then(d=>{if(alive){setRelated(d.related);setHistoryTotal(d.historyTotal);}}).catch(e=>onError(errorText(e)));return()=>{alive=false;};},[itemId,row?.revision]);
  useEffect(()=>{if(!row)return;const merged={...emptyItem(),...row.data};for(const field of changed.current)merged[field]=latest.current[field] as never;merged.status=row.data.status;latest.current=merged;setValues(merged);},[row?.revision]);
  const persist=useCallback((v:Item)=>{const draft:Draft={key,user,instance,item:itemId,editor:editor.current,version:version.current,generation:generation.current,revision,updatedAt:new Date().toISOString(),values:v as unknown as Record<string,unknown>};return drafts.save(draft);},[key,user,itemId,revision]);
  function update<K extends keyof Item>(field:K,value:Item[K]){const v={...latest.current,[field]:value};latest.current=v;changed.current.add(field);version.current++;dirty.current=true;onDirty(true);setValues(v);void persist(v).catch(e=>onError(errorText(e)));}
  useEffect(()=>{const before=(e:BeforeUnloadEvent)=>{if(dirty.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',before);return()=>window.removeEventListener('beforeunload',before);},[]);
  async function save(){
    if(generation.current!==context.generation){onError('数据已恢复或升级，请重新打开并核对草稿。');return;}
    const submittedVersion=version.current,v={...latest.current};if(!v.title.trim()){onError('请填写事项标题');return;}
    const {status:_,beforeDone:__,trashed:___,...changes}=v as Item & {beforeDone?:string};
    const m=mutation(context,row?'edit':'create',row?{id:row.id,changes}:{kind:'item',parent_id:planId,data:v},row?.revision??null);
    if(await perform(m)){await drafts.clearVersion(key,submittedVersion).catch(e=>{if(mounted.current)onError(errorText(e));});if(!mounted.current)return;if(version.current===submittedVersion){dirty.current=false;onDirty(false);onSaved();}else{if(row)await onAction(row,'refresh');onError('提交内容已保存，随后输入的内容仍未保存。');}}
  }
  const textField=(field:keyof Item,label:string,textarea=false)=> <label>{label}{textarea?<textarea value={String(values[field]??'')} onChange={e=>update(field,e.target.value as never)} rows={field==='outline'?5:3}/>:<input value={String(values[field]??'')} onChange={e=>update(field,e.target.value as never)}/>}</label>;
  function precisionField(field:'actualStart'|'actualFinish',precision:'startPrecision'|'finishPrecision',title:string){
    const raw=values[field],value=values[precision]==='date'?raw:raw?raw.slice(0,16):'';
    return <label>{title}<div className="precision"><select aria-label={title+'精度'} value={values[precision]} onChange={e=>{const p=e.target.value as 'date'|'minute';update(precision,p);update(field,'');}}><option value="minute">具体时分（中国时区）</option><option value="date">仅记得日期</option></select>
      <input aria-label={title+'时间'} type={values[precision]==='date'?'date':'datetime-local'} value={values[precision]==='minute'&&raw?new Date(Date.parse(raw)+8*3600000).toISOString().slice(0,16):value} onChange={e=>update(field,e.target.value?(values[precision]==='date'?e.target.value:new Date(e.target.value+':00+08:00').toISOString()):'')}/></div></label>;
  }
  return <div className="drawer-shade"><section ref={panel} className="drawer" role="dialog" aria-modal="true" aria-label="事项详情"><header><div><small>{row?values.sourceCode||'计划事项':'记下一个新想法'}</small><h2>{row?'事项详情':'新增事项'}</h2></div><button aria-label="关闭详情" onClick={onClose}>×</button></header>
    <fieldset className="drawer-body" disabled={busy&&!row}>{available.length>0&&<div className="draft-banner"><strong>找到了未保存草稿</strong>{available.map(d=><div key={d.key}><span>{dateTime(d.updatedAt)}{d.generation!==context.generation||d.revision!==revision?' · 基于旧数据，请核对':''}</span><button onClick={async()=>{if(!await confirm('将草稿放入表单供核对，尚未提交到正式数据。继续？'))return;const v={...emptyItem(),...d.values} as Item;setValues(v);latest.current=v;Object.keys(v).forEach(k=>changed.current.add(k));version.current++;dirty.current=true;onDirty(true);setAvailable([]);void persist(v).catch(e=>onError(errorText(e)));}}>放入表单核对</button></div>)}</div>}
      {textField('title','标题')}
      <div className="two-columns"><label>平台<select value={values.platform} onChange={e=>update('platform',e.target.value)}>{['公众号','视频','小红书','其他'].map(v=><option key={v}>{v}</option>)}</select></label>
      <label>事项类型<select value={values.type} onChange={e=>update('type',e.target.value as Item['type'])}><option value="content">内容交付</option><option value="support">辅助工作</option></select></label></div>
      {row&&<div className="state-controls"><span className={'status '+row.data.status}>{STATUS[row.data.status]}</span><select aria-label="改变事项状态" value={row.data.status} disabled={busy} onChange={e=>onAction(row,'status',e.target.value as Status)}>{Object.entries(STATUS).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>{row.data.status==='done'&&<><button disabled={busy} onClick={()=>onAction(row,'undo')}>误勾撤销</button><button disabled={busy} onClick={()=>onAction(row,'reopen')}>重新打开返工</button></>}</div>}
      <div className="two-columns">{textField('batch','批次')}{textField('group','分组／卷')}{textField('chapter','章节')}<label>优先级<select value={values.priority} onChange={e=>update('priority',e.target.value as Item['priority'])}><option value="high">高</option><option value="normal">普通</option><option value="low">低</option></select></label><label>制作顺序<input type="number" min="0" step="1" value={values.rank} onChange={e=>update('rank',Number(e.target.value))}/></label></div>
      <div className="two-columns"><label>计划开始<input type="date" value={values.planStart} onChange={e=>update('planStart',e.target.value)}/></label><label>计划结束／截止日<input type="date" value={values.planEnd} onChange={e=>update('planEnd',e.target.value)}/></label></div>
      {textField('criteria','这项怎样才算完成',true)}
      <details open><summary>内容准备</summary>{textField('goal','目标／认知收益',true)}{textField('outline','大纲',true)}{textField('explanation','本篇需要解释什么',true)}{textField('notes','备注、卡住的原因与下一步',true)}</details>
      {row?<details><summary>实际时间与投入</summary><p className="muted">历时包含等待与休息，实际投入另行手动记录。</p>{precisionField('actualStart','startPrecision','实际开始')}{precisionField('actualFinish','finishPrecision','实际完成')}<p>{elapsed(values)}</p>
      {row&&<><div className="effort-list">{related.filter(r=>r.kind==='effort').map(r=><div key={r.id}>{duration(Number(r.data.minutes))} · {String(r.data.on||'')}{r.data.voided?' · 已撤销':''}<small>{String(r.data.note||'')}</small><button disabled={busy} onClick={async()=>{const value=await prompt('修正投入分钟数',String(r.data.minutes));if(value===null)return;if(!/^\d+$/.test(value)||Number(value)<1){onError('请填写正整数分钟');return;}if(await perform(mutation(context,'correct_effort',{id:r.id,changes:{minutes:Number(value),voided:false}},r.revision)))await onAction(row,'refresh');}}>修正</button>{!r.data.voided&&<button disabled={busy} onClick={async()=>{if(await perform(mutation(context,'correct_effort',{id:r.id,changes:{voided:true}},r.revision)))await onAction(row,'refresh');}}>撤销投入</button>}</div>)}</div><div className="two-columns"><label>新增投入（分钟）<input disabled={busy} type="number" min="1" step="1" value={minutes} onChange={e=>setMinutes(e.target.value)}/></label><label>投入说明<input disabled={busy} value={note} onChange={e=>setNote(e.target.value)}/></label></div><button disabled={busy||!minutes} onClick={async()=>{if(!/^\d+$/.test(minutes)||Number(minutes)<=0){onError('投入请填写正整数分钟');return;}if(await perform(mutation(context,'effort',{id:row.id,data:{minutes:Number(minutes),on:chinaDate(),note}},row.revision))){setMinutes('');setNote('');await onAction(row,'refresh');}}}>记录投入</button></>}
      </details>
      :<p className="muted">先保存事项，再记录开始、完成或补录实际时间与投入。</p>}
      <details><summary>资料复查</summary><div className="two-columns"><label>信息类型<select value={values.informationType} onChange={e=>update('informationType',e.target.value)}><option value="">未安排</option><option value="A">A · 稳定概念</option><option value="B">B · 动态信息</option><option value="A+B">A+B · 混合信息</option></select></label><label>最近完整核验<input type="date" value={values.verifiedOn} onChange={e=>update('verifiedOn',e.target.value)}/></label></div><p>建议下次复查：{reviewDate(values.verifiedOn,values.informationType)||'未安排复查'}</p><p className="muted">数字、价格、版本等在复用时另查。完成勾选不会自动填核验或发布日期。</p></details>
      <details><summary>成果与来源</summary><label>网页链接或本地路径<input value={linkInput} onChange={e=>setLinkInput(e.target.value)}/></label><button onClick={async()=>{if(!linkInput.trim())return;update('links',[...values.links,{label:linkInput,...(safeUrl(linkInput)?{url:linkInput}:{path:linkInput})}]);setLinkInput('');}}>添加引用</button>
        {values.links.map((l,i)=><div className="reference-link" key={i}>{l.url&&safeUrl(l.url)?<a href={safeUrl(l.url)!} target="_blank" rel="noreferrer">{l.label} ↗</a>:<button onClick={()=>navigator.clipboard.writeText(l.path||l.label).catch(()=>onError('复制失败，请手动复制路径'))}>复制：{l.label}</button>}<button onClick={()=>update('links',values.links.filter((_,j)=>i!==j))}>移除</button></div>)}
        <p>来源：{values.sourceCode||'自主新增'} · {values.sourceVersion||'未注明'}</p>
        {row&&<label>关联事项编号（每行一个内部 UUID）<textarea value={values.related.join('\n')} onChange={e=>update('related',e.target.value.split('\n').map(v=>v.trim()).filter(Boolean))}/></label>}
      </details>
      {row&&<details><summary>操作历史 · 已加载 {related.filter(r=>r.kind==='event').length}/{historyTotal}</summary><button disabled={busy} onClick={()=>onAction(row,'undo_edit')}>撤销最近一次编辑</button>{related.filter(r=>r.kind==='event').map(r=><div className="history" key={r.id}><strong>{({create:'新增',edit:'修改内容',status:'切换状态',undo:'撤销误勾',reopen:'返工重开',effort:'记录投入',correct_effort:'修正投入',undo_edit:'撤销编辑',move:'移动事项',copy:'复制事项',trash:'移入回收站',untrash:'恢复事项',close_batch:'批次结项',reopen_batch:'批次重开'} as Record<string,string>)[String(r.data.action)]||String(r.data.action)}</strong><time>{dateTime(String(r.data.recordedAt))}</time><details><summary>查看变化</summary><pre>{JSON.stringify({之前:r.data.before,之后:r.data.after},null,2)}</pre></details></div>)}{related.filter(r=>r.kind==='event').length<historyTotal&&<button onClick={async()=>{const d=await api.detail(row.id,related.filter(r=>r.kind==='event').length);setRelated(current=>[...current,...d.related.filter(v=>!current.some(x=>x.id===v.id))]);}}>加载更早历史</button>}</details>}
      {row&&<div className="item-tools"><label>移动到计划<select defaultValue="" disabled={busy} onChange={async e=>{const destination=e.target.value;if(!destination)return;if(!await confirm('移动保留时间与投入，并清空原分组／批次。继续？'))return;if(await perform(mutation(context,'move',{id:row.id,parent_id:destination},row.revision)))onSaved();}}><option value="">选择目标计划</option>{plans.filter(p=>p.id!==row.parent_id&&!p.data.archived).map(p=><option key={p.id} value={p.id}>{label(p)}</option>)}</select></label><button disabled={busy} onClick={()=>perform(mutation(context,'copy',{id:row.id},row.revision))}>复制成新事项</button><button className="danger" disabled={busy} onClick={async()=>{if(await confirm('移入回收站？记录和投入会保留。')&&await perform(mutation(context,'trash',{id:row.id},row.revision)))onSaved();}}>移入回收站</button></div>}
    </fieldset><footer><span>{dirty.current?'有未保存修改':row?'已保存记录':'尚未保存'}{row?' · '+dateTime(row.updated_at):''}</span><button className="primary" disabled={busy} onClick={save}>{busy?'保存中…':'保存事项'}</button></footer>
  </section></div>;
}
