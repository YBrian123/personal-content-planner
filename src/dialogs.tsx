import {createContext,useCallback,useContext,useEffect,useRef,useState} from 'react';
import type {ReactNode} from 'react';

type Request={kind:'confirm'|'text';message:string;initial:string;id:number};
type Dialogs={confirm:(message:string)=>Promise<boolean>;prompt:(message:string,initial?:string)=>Promise<string|null>;cancel:()=>void};
const DialogContext=createContext<Dialogs|null>(null);

export function DialogProvider({children}:{children:ReactNode}){
  const [request,setRequest]=useState<Request|null>(null);
  const pending=useRef<((value:string|null)=>void)|null>(null),sequence=useRef(0);
  const finish=useCallback((value:string|null)=>{const resolve=pending.current;pending.current=null;setRequest(null);resolve?.(value);},[]);
  const cancel=useCallback(()=>finish(null),[finish]);
  const ask=useCallback((kind:Request['kind'],message:string,initial='')=>{
    if(pending.current)return Promise.resolve(null);
    return new Promise<string|null>(resolve=>{pending.current=resolve;setRequest({kind,message,initial,id:++sequence.current});});
  },[]);
  const confirm=useCallback(async(message:string)=>(await ask('confirm',message))==='confirmed',[ask]);
  const prompt=useCallback((message:string,initial='')=>ask('text',message,initial),[ask]);
  useEffect(()=>()=>{pending.current?.(null);pending.current=null;},[]);
  return <DialogContext.Provider value={{confirm,prompt,cancel}}>{children}{request&&<SiteDialog key={request.id} request={request} finish={finish}/>}</DialogContext.Provider>;
}

export function useDialogs(){const value=useContext(DialogContext);if(!value)throw new Error('DialogProvider required');return value;}

function SiteDialog({request,finish}:{request:Request;finish:(value:string|null)=>void}){
  const element=useRef<HTMLDialogElement>(null),[value,setValue]=useState(request.initial);
  useEffect(()=>{const dialog=element.current!;dialog.showModal();return()=>dialog.close();},[]);
  const multiline=/文本|目标|标准|备注/.test(request.message);
  return <dialog ref={element} className="site-dialog" aria-labelledby="site-dialog-title" onCancel={e=>{e.preventDefault();finish(null);}}>
    <form onSubmit={e=>{e.preventDefault();finish(request.kind==='confirm'?'confirmed':value);}}>
      <h2 id="site-dialog-title">{request.kind==='confirm'?'确认操作':request.message}</h2>
      {request.kind==='confirm'?<p>{request.message}</p>:multiline?<textarea autoFocus aria-label={request.message} value={value} onChange={e=>setValue(e.target.value)} rows={6}/>:<input autoFocus aria-label={request.message} value={value} onChange={e=>setValue(e.target.value)}/>}
      <footer><button type="button" onClick={()=>finish(null)}>取消</button><button className="primary" type="submit">{request.kind==='confirm'?'确认继续':'确定'}</button></footer>
    </form>
  </dialog>;
}
