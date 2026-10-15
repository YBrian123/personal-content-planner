export const STATUS = { todo: '待开始', doing: '进行中', done: '已完成', paused: '暂缓', cancelled: '已取消' } as const;
export type Status = keyof typeof STATUS;
export type Kind = 'direction' | 'plan' | 'item' | 'effort' | 'event' | 'closure' | 'reference' | 'settings';
export interface Item extends Record<string, unknown> {
  title: string; status: Status; type: 'content'|'support'; platform: string; batch: string; group: string; chapter: string;
  priority: 'high'|'normal'|'low'; rank: number; sourceCode: string; sourceVersion: string; criteria: string;
  goal: string; outline: string; explanation: string; notes: string; planStart: string; planEnd: string;
  actualStart: string; actualFinish: string; startPrecision: 'minute'|'date'; finishPrecision: 'minute'|'date';
  verifiedOn: string; informationType: string; trashed: boolean; links: Array<{label: string; url?: string; path?: string}>; related: string[];
}
export interface Row<T = Record<string, unknown>> { id: string; kind: Kind; parent_id: string|null; data: T; revision: number; created_at: string; updated_at: string; }
export interface Context { generation: string; revision: number; schemaVersion: number; serverTime: string; siteName?: Row|null; records: Row[]; overview?: Array<{id:string;total:number;effective:number;done:number;cancelled:number}>; }
export interface Totals { original?:number; added?:number; removed?:number; total: number; effective: number; done: number; cancelled: number; content: number; support: number; started: string|null; finished: string|null; missingStart: number; missingFinish?:number; effortMinutes: number; effortCoverage: number; cancelledEffort: number; }
export interface ListResult { records: Row<Item>[]; matched: number; totals: Totals; revision: number; }
export interface Filter { q?: string; batch?: string; status?: string; platform?: string; group?: string; sort?: string; view?:string; trash?: boolean; }
export interface Backup { format: 'personal-planner'; payload: string; checksum: string; exportedAt: string; count: number; revision?: number; generation?: string; }
export interface Mutation { operation: string; generation: string; action: string; payload: Record<string, unknown>; expected: number|null; }
export function emptyItem(criteria = ''): Item { return { title:'', status:'todo', type:'content',platform:'公众号',batch:'',group:'',chapter:'',priority:'normal',rank:999999,sourceCode:'',sourceVersion:'',criteria,goal:'',outline:'',explanation:'',notes:'',planStart:'',planEnd:'',actualStart:'',actualFinish:'',startPrecision:'minute',finishPrecision:'minute',verifiedOn:'',informationType:'',trashed:false,links:[],related:[] }; }
export function chinaDate(value: string|Date = new Date()): string {
  if(typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value); if(!Number.isFinite(+d)) return '';
  const p = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(d);
  return ['year','month','day'].map(k=>p.find(x=>x.type===k)?.value).join('-');
}
export function dateTime(value: string): string {
  if(!value) return '未记录';
  if(!Number.isFinite(Date.parse(value)))return '记录不完整';
  if(/^\d{4}-\d{2}-\d{2}$/.test(value)) return value+'（按日）';
  return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
}
export function duration(minutes: number): string { const m=Math.max(0,Math.floor(minutes)); return [Math.floor(m/60)?Math.floor(m/60)+' 小时':'',m%60?m%60+' 分钟':''].filter(Boolean).join(' ')||'0 分钟'; }
export function elapsed(item: Pick<Item,'actualStart'|'actualFinish'|'startPrecision'|'finishPrecision'|'status'>, now=Date.now()): string {
  if(!item.actualStart) return item.actualFinish?'缺少开始记录':'尚未开始';
  const end=item.actualFinish;
  if(item.startPrecision==='date'||(end&&item.finishPrecision==='date')){
    const days=Math.floor((Date.parse(chinaDate(end||new Date(now)))-Date.parse(chinaDate(item.actualStart)))/86400000);
    return Math.max(0,days)+' 天（按日估算）';
  }
  const minutes=Math.floor(((end?Date.parse(end):now)-Date.parse(item.actualStart))/60000);
  return minutes<0?'完成早于开始，请修正':(end?'历时 ':'已开始 ')+duration(minutes);
}
export function reviewDate(verified: string,kind: string): string {
  if(!verified || !['A','B','A+B'].includes(kind)) return '';
  const [y,m,d]=verified.split('-').map(Number);
  const month=new Date(Date.UTC(y,m-1+(kind==='A'?6:3),1));
  const last=new Date(Date.UTC(month.getUTCFullYear(),month.getUTCMonth()+1,0)).getUTCDate();
  return [month.getUTCFullYear(),String(month.getUTCMonth()+1).padStart(2,'0'),String(Math.min(d,last)).padStart(2,'0')].join('-');
}
export function due(item: Item, today=chinaDate()): string {
  if(!item.planEnd) return '';
  if(item.status==='done'&&item.actualFinish){
    const days=Math.round((Date.parse(chinaDate(item.actualFinish))-Date.parse(item.planEnd))/86400000);
    return days===0?'按期完成':days>0?'延后 '+days+' 天':'提前 '+(-days)+' 天';
  }
  return item.status!=='cancelled'&&!item.trashed&&item.planEnd<today?'计划日期已过':'';
}
export function safeUrl(value: string): string|null { try { const u=new URL(value); return ['https:','http:'].includes(u.protocol)?u.href:null; }catch{return null;} }
export function csv(rows: Row<Item>[]): string {
  const escape=(v: unknown)=>{let text=String(v??'');if(/^[\s]*[=+@-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
  const header=['来源编号','标题','平台','状态','计划开始','计划结束','实际开始','实际完成','历时','实际投入分钟'];
  return '\ufeff'+[header,...rows.map(r=>[r.data.sourceCode,r.data.title,r.data.platform,STATUS[r.data.status],r.data.planStart,r.data.planEnd,r.data.actualStart,r.data.actualFinish,elapsed(r.data),(r.data as Item & {effortMinutes?:number}).effortMinutes??'未记录'])].map(a=>a.map(escape).join(',')).join('\r\n');
}
export async function checksum(payload: string): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload)))].map(x=>x.toString(16).padStart(2,'0')).join(''); }
export async function validateBackup(value: unknown): Promise<{backup: Backup; rows: Row[]}> {
  const b=value as Backup;
  if(!b||b.format!=='personal-planner'||typeof b.payload!=='string'||typeof b.checksum!=='string') throw new Error('备份格式不正确');
  if(await checksum(b.payload)!==b.checksum) throw new Error('备份校验失败，文件可能不完整');
  const bundle=JSON.parse(b.payload) as {schemaVersion:number;records:Row[]};
  if(bundle.schemaVersion!==1||!Array.isArray(bundle.records)) throw new Error('不支持的数据版本');
  if(typeof b.count!=='number'||b.count!==bundle.records.length)throw new Error('备份记录数量不匹配');
  if(new Set(bundle.records.map(r=>r.id)).size!==bundle.records.length) throw new Error('备份包含重复编号');
  return {backup:b, rows:bundle.records};
}

export function matchesView(item:Item,view='',reviewEnabled=false,today=chinaDate()):boolean {
  if(!view)return true;
  const active=!['done','cancelled'].includes(item.status);
  if(view==='doing')return item.status==='doing';
  if(view==='unscheduled')return active&&!item.planEnd;
  if(view==='overdue')return active&&!!item.planEnd&&item.planEnd<today;
  if(view==='upcoming')return active&&!!item.planEnd&&item.planEnd>=today&&Date.parse(item.planEnd)<=Date.parse(today)+7*86400000;
  const next=reviewDate(item.verifiedOn,item.informationType);return view==='review'&&reviewEnabled&&!!next&&next<=today;
}

export function period(t:Totals):string {
  if(!t.effective)return t.total?'无有效事项':'尚无事项';
  if(!t.started&&!t.finished)return '等待第一项开始';
  if(t.missingStart)return '开始记录不全';
  if(t.done===t.effective){
    if(t.missingFinish||!t.finished)return '完成记录不全';
    return dateTime(t.started||'')+' → '+dateTime(t.finished)+' · '+elapsed({actualStart:t.started||'',actualFinish:t.finished,startPrecision:/^\d{4}-\d{2}-\d{2}$/.test(t.started||'')?'date':'minute',finishPrecision:/^\d{4}-\d{2}-\d{2}$/.test(t.finished)?'date':'minute',status:'done'});
  }
  return dateTime(t.started||'');
}
