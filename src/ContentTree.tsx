import {useEffect,useRef,useState} from 'react';
import {api,errorText} from './data';
import {STATUS} from './domain';
import type {Context,Item,Row} from './domain';
type Page={rows:Row<Item>[];matched:number};
type Props={context:Context|null;plan:string;storageKey:string;busy:boolean;showArchived:boolean;onPlan:(id:string)=>void;onItem:(id:string,parent:string)=>void;onNewDirection:()=>void;onNewPlan:(direction:string)=>void;onNewItem:(plan:string)=>void;onDelete:(row:Row)=>void;onError:(message:string)=>void;};
const name=(r:Row)=>String(r.data.name||'未命名');
export default function ContentTree({context,plan,storageKey,busy,showArchived,onPlan,onItem,onNewDirection,onNewPlan,onNewItem,onDelete,onError}:Props){
  const [open,setOpen]=useState<Record<string,boolean>>(()=>{try{return JSON.parse(localStorage.getItem(storageKey)||'{}');}catch{return {};}});
  const [pages,setPages]=useState<Record<string,Page>>({}),[loading,setLoading]=useState<Record<string,boolean>>({});
  const mounted=useRef(true),revision=useRef(context?.revision);revision.current=context?.revision;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{try{localStorage.setItem(storageKey,JSON.stringify(open));}catch{}},[open,storageKey]);
  const records=context?.records||[],directions=records.filter(r=>r.kind==='direction'&&!r.data.trashed&&(showArchived||!r.data.archived));
  const plans=records.filter(r=>r.kind==='plan'&&!r.data.trashed&&directions.some(d=>d.id===r.parent_id)&&(showArchived||!r.data.archived));
  const expanded=(id:string,kind:string)=>open[id]??(kind==='direction'||kind==='plan'&&id===plan);
  const visiblePlans=open.root===false?'':plans.filter(p=>expanded(p.parent_id!,'direction')&&expanded(p.id,'plan')).map(p=>p.id).join(',');
  useEffect(()=>{
    let alive=true;const ids=visiblePlans.split(',').filter(Boolean);if(!context)return;
    setLoading(Object.fromEntries(ids.map(id=>[id,true])));
    for(const id of ids)api.list(id,{sort:'rank'},0,30).then(result=>{if(alive)setPages(p=>({...p,[id]:{rows:result.records,matched:result.matched}}));}).catch(e=>{if(alive)onError(errorText(e));}).finally(()=>{if(alive)setLoading(p=>({...p,[id]:false}));});
    return()=>{alive=false;};
  },[visiblePlans,context?.revision,context?.generation,onError]);
  function toggle(id:string,kind:string){setOpen(p=>({...p,[id]:!expanded(id,kind)}));}
  function progress(id:string){const t=context?.overview?.find(r=>r.id===id);return t?.effective?t.done+'/'+t.effective:t?.total?'无有效事项':'0 项';}
  async function more(id:string){const token=revision.current,previous=pages[id];if(!previous)return;setLoading(p=>({...p,[id]:true}));try{const result=await api.list(id,{sort:'rank'},previous.rows.length,30);if(mounted.current&&revision.current===token)setPages(p=>({...p,[id]:{rows:[...previous.rows,...result.records],matched:result.matched}}));}catch(e){if(mounted.current&&revision.current===token)onError(errorText(e));}finally{if(mounted.current&&revision.current===token)setLoading(p=>({...p,[id]:false}));}}
  return <section className="content-tree" aria-label="内容方向、计划与事项目录">
    <div className="tree-heading"><button className="tree-root-toggle" aria-expanded={open.root!==false} onClick={()=>setOpen(p=>({...p,root:p.root===false}))}>{open.root===false?'▸':'▾'} 内容目录</button><button className="link-button" onClick={()=>setOpen(Object.fromEntries(records.filter(r=>['direction','plan'].includes(r.kind)).map(r=>[r.id,false])))}>全部折叠</button></div>
    <p className="tree-guide">内容方向 → 计划 → 事项</p>
    <button className="tree-create-direction" disabled={!context||busy} onClick={onNewDirection}>＋ 新建内容方向</button>
    <div hidden={open.root===false}>
    {!directions.length&&<p className="sidebar-empty">{context?'先建一个内容方向，再添加计划。':'连接后，在这里管理内容。'}</p>}
    {directions.map(direction=><section className="tree-direction" key={direction.id}>
      <div className="tree-row direction-row"><button className="tree-toggle" aria-label={(expanded(direction.id,'direction')?'折叠':'展开')+'内容方向 '+name(direction)} aria-expanded={expanded(direction.id,'direction')} aria-controls={'children-'+direction.id} onClick={()=>toggle(direction.id,'direction')}>{expanded(direction.id,'direction')?'▾':'▸'}</button><span className="level-badge">方向</span><strong title={name(direction)}>{name(direction)}</strong><small>{progress(direction.id)}</small></div>
      {expanded(direction.id,'direction')&&<div id={'children-'+direction.id} className="direction-children">
        <div className="tree-actions"><button disabled={busy} onClick={()=>onNewPlan(direction.id)} aria-label={'在 '+name(direction)+' 下新建计划'}>＋ 新建计划</button><button className="danger" disabled={busy} onClick={()=>onDelete(direction)} aria-label={'删除内容方向 '+name(direction)}>删除方向</button></div>
        {plans.filter(p=>p.parent_id===direction.id).map(p=><section className={'tree-plan '+(p.id===plan?'current-plan':'')} key={p.id}>
          <div className="tree-row"><button className="tree-toggle" aria-label={(expanded(p.id,'plan')?'折叠':'展开')+'计划 '+name(p)} aria-expanded={expanded(p.id,'plan')} aria-controls={'children-'+p.id} onClick={()=>toggle(p.id,'plan')}>{expanded(p.id,'plan')?'▾':'▸'}</button><span className="level-badge">计划</span><button className="tree-name" title={name(p)} aria-current={p.id===plan?'page':undefined} onClick={()=>{setOpen(x=>({...x,[p.id]:true}));onPlan(p.id);}}>{name(p)}</button><small>{progress(p.id)}</small></div>
          {expanded(p.id,'plan')&&<div id={'children-'+p.id} className="plan-children"><div className="tree-actions"><button disabled={busy} onClick={()=>onNewItem(p.id)}>＋ 新建事项</button><button className="danger" disabled={busy} onClick={()=>onDelete(p)} aria-label={'删除计划 '+name(p)}>删除计划</button></div>
            {loading[p.id]&&!pages[p.id]?<p className="tree-empty">读取事项…</p>:pages[p.id]?.rows.map(item=><div className="tree-item" key={item.id}><div className="tree-row"><button className="tree-toggle" aria-label={(expanded(item.id,'item')?'折叠':'展开')+'事项 '+item.data.title} aria-expanded={expanded(item.id,'item')} onClick={()=>toggle(item.id,'item')}>{expanded(item.id,'item')?'▾':'▸'}</button><span className="level-badge item-badge">事项</span><button className="tree-name" title={item.data.title} onClick={()=>onItem(item.id,p.id)}>{item.data.title}</button></div>{expanded(item.id,'item')&&<div className="tree-item-details"><span>{item.data.platform} · {STATUS[item.data.status]}</span><button className="link-button" onClick={()=>onItem(item.id,p.id)}>打开详情</button><button className="link-button danger" disabled={busy} onClick={()=>onDelete(item)}>删除</button></div>}</div>)}
            {pages[p.id]?.matched===0&&<p className="tree-empty">还没有事项</p>}{pages[p.id]&&pages[p.id].rows.length<pages[p.id].matched&&<button className="tree-more" disabled={loading[p.id]} onClick={()=>more(p.id)}>再显示 30 项（已显示 {pages[p.id].rows.length}/{pages[p.id].matched}）</button>}
          </div>}
        </section>)}
      </div>}
    </section>)}
    </div>
  </section>;
}
