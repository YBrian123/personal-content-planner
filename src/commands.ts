import type {Context,Mutation} from './domain';
const clocks=new WeakMap<Context,{server:number;received:number}>();
export function recordClock(c:Context){clocks.set(c,{server:Date.parse(c.serverTime),received:performance.now()});return c;}
export function mutation(context:Context,action:string,payload:Record<string,unknown>,expected:number|null=null):Mutation{
  const clock=clocks.get(context);const recorded=clock?new Date(clock.server+performance.now()-clock.received).toISOString():undefined;
  const body=recorded&&['status','undo','reopen','effort','batch_status'].includes(action)?{occurredAt:recorded,...payload}:payload;
  return {operation:crypto.randomUUID(),generation:context.generation,action,payload:body,expected};
}
