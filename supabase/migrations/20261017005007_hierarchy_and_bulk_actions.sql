-- Recoverable deletion for all three levels and atomic, revision-checked item batches.
create function public.planner_in_trash(p_id uuid) returns boolean language sql stable security definer set search_path='' as $$
  with recursive ancestors as (
    select id,parent_id,data from public.planner_records where id=p_id and owner_id=auth.uid()
    union all
    select p.id,p.parent_id,p.data from public.planner_records p join ancestors a on p.id=a.parent_id where p.owner_id=auth.uid()
  ) select coalesce(bool_or(coalesce((data->>'trashed')::boolean,false)),false) from ancestors;
$$;
revoke all on function public.planner_in_trash(uuid) from public,anon,authenticated;

do $migration$
declare definition text;
begin
  select pg_get_functiondef('public.planner_validate(text,jsonb)'::regprocedure) into definition;
  if strpos(definition,$old$array['name','goal','archived']$old$)=0 then raise exception 'Unexpected direction validator'; end if;
  definition:=replace(definition,$old$array['name','goal','archived']$old$,$new$array['name','goal','archived','trashed']$new$);
  definition:=replace(definition,$old$array['name','goal','defaultCriteria','archived','defaultBatch','reviewEnabled']$old$,$new$array['name','goal','defaultCriteria','archived','defaultBatch','reviewEnabled','trashed']$new$);
  execute definition;
end;
$migration$;

alter function public.planner_execute(uuid,uuid,text,jsonb,bigint) rename to planner_execute_record;
revoke all on function public.planner_execute_record(uuid,uuid,text,jsonb,bigint) from public,anon,authenticated;
do $migration$
declare definition text;
begin
  select pg_get_functiondef('public.planner_execute_record(uuid,uuid,text,jsonb,bigint)'::regprocedure) into definition;
  if strpos(definition,$old$(p_action in ('trash','untrash') and r.kind<>'item')$old$)=0 then raise exception 'Unexpected trash branch'; end if;
  definition:=replace(definition,$old$(p_action in ('trash','untrash') and r.kind<>'item')$old$,$new$(p_action in ('trash','untrash') and r.kind not in ('direction','plan','item'))$new$);
  definition:=replace(definition,$old$update public.planner_records set data=data||jsonb_build_object(case when p_action in ('trash','untrash')$old$,$new$if p_action='trash' and r.kind in ('direction','plan') then perform public.planner_take_snapshot('trash_container'); end if;
    update public.planner_records set data=data||jsonb_build_object(case when p_action in ('trash','untrash')$new$);
  execute definition;
end;
$migration$;

create function public.planner_execute(p_operation uuid,p_generation uuid,p_action text,p_payload jsonb default '{}',p_expected bigint default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.planner_control; request_body jsonb; response jsonb; r public.planner_records; entry jsonb; n integer; occurred text; snapshot_id uuid;
begin
  if not public.planner_is_owner() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into c from public.planner_control where singleton=true and owner_id=auth.uid() for update;
  if not found then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if c.generation is distinct from p_generation then raise exception 'STALE_GENERATION'; end if;
  if c.schema_version<>1 then raise exception 'SCHEMA_MISMATCH'; end if;
  if p_operation is null then raise exception 'OPERATION_REQUIRED'; end if;
  request_body:=jsonb_build_object('action',p_action,'payload',p_payload,'expected',p_expected);
  select result into response from public.planner_operations where owner_id=auth.uid() and generation=p_generation and operation_id=p_operation;
  if found then
    if (select request from public.planner_operations where owner_id=auth.uid() and generation=p_generation and operation_id=p_operation)<>request_body then raise exception 'OPERATION_REUSED'; end if;
    return response;
  end if;
  if p_action in ('batch_status','batch_trash') then
    if jsonb_typeof(p_payload->'items') is distinct from 'array' then raise exception 'INVALID_SELECTION'; end if;
    n:=jsonb_array_length(p_payload->'items');
    if n not between 1 and 200 then raise exception 'INVALID_SELECTION'; end if;
    for entry in select value from jsonb_array_elements(p_payload->'items') loop
      if jsonb_typeof(entry) is distinct from 'object' or jsonb_typeof(entry->'id') is distinct from 'string' or entry->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or jsonb_typeof(entry->'revision') is distinct from 'number' or entry->>'revision' !~ '^[1-9][0-9]*$' then raise exception 'INVALID_SELECTION'; end if;
      select * into r from public.planner_records where owner_id=auth.uid() and id=(entry->>'id')::uuid;
      if not found or r.kind<>'item' or r.parent_id is distinct from nullif(p_payload->>'plan_id','')::uuid then raise exception 'INVALID_SELECTION'; end if;
      if r.revision<>(entry->>'revision')::bigint then raise exception 'CONFLICT'; end if;
      if public.planner_in_trash(r.id) then raise exception 'ITEM_TRASHED'; end if;
    end loop;
    if (select count(*)<>count(distinct (value->>'id')::uuid) from jsonb_array_elements(p_payload->'items')) then raise exception 'INVALID_SELECTION'; end if;
    if p_action='batch_trash' then snapshot_id:=public.planner_take_snapshot('batch_trash'); end if;
    occurred:=coalesce(nullif(p_payload->>'occurredAt',''),to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    for entry in select value from jsonb_array_elements(p_payload->'items') loop
      perform public.planner_execute_record(gen_random_uuid(),p_generation,case p_action when 'batch_status' then 'status' else 'trash' end,
        jsonb_build_object('id',entry->>'id','status','done','occurredAt',occurred),(entry->>'revision')::bigint);
    end loop;
    response:=jsonb_build_object('id',null,'record',null,'count',n,'generation',c.generation,'revision',(select revision from public.planner_control where singleton=true),'snapshot',snapshot_id);
    insert into public.planner_operations(owner_id,generation,operation_id,request,result) values(auth.uid(),p_generation,p_operation,request_body,response);
    return response;
  end if;
  if nullif(p_payload->>'id','') is not null then
    select * into r from public.planner_records where owner_id=auth.uid() and id=(p_payload->>'id')::uuid;
    if not found then raise exception 'NOT_FOUND'; end if;
    if p_action='untrash' then
      if public.planner_in_trash(r.parent_id) then raise exception 'PARENT_TRASHED'; end if;
    elsif public.planner_in_trash(r.id) then raise exception 'ITEM_TRASHED'; end if;
    if p_action='trash' and r.kind in ('direction','plan') and ((p_payload->>'scopeRevision') is null or (p_payload->>'scopeRevision')::bigint<>c.revision) then raise exception 'RANGE_CHANGED'; end if;
  end if;
  if p_action in ('create','move') then
    if public.planner_in_trash(nullif(p_payload->>'parent_id','')::uuid) then raise exception 'PARENT_TRASHED'; end if;
    if p_action='create' and coalesce((p_payload->'data'->>'trashed')::boolean,false) then raise exception 'USE_STATE_ACTION'; end if;
  end if;
  if p_action='close_batch' and public.planner_in_trash(nullif(p_payload->>'plan_id','')::uuid) then raise exception 'PARENT_TRASHED'; end if;
  return public.planner_execute_record(p_operation,p_generation,p_action,p_payload,p_expected);
end;
$$;
revoke all on function public.planner_execute(uuid,uuid,text,jsonb,bigint) from public,anon;
grant execute on function public.planner_execute(uuid,uuid,text,jsonb,bigint) to authenticated;

do $migration$
declare definition text;
begin
  select pg_get_functiondef('public.planner_list(uuid,jsonb,integer,integer)'::regprocedure) into definition;
  definition:=replace(definition,$old$if p_offset<0$old$,$new$if public.planner_in_trash(p_plan) then raise exception 'PARENT_TRASHED'; end if;
  if p_offset<0$new$);
  execute definition;
end;
$migration$;

create or replace function public.planner_context() returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.planner_control;
begin
  if not public.planner_is_owner() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into c from public.planner_control where singleton=true and owner_id=auth.uid() for share;
  if not found then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  return jsonb_build_object('generation',c.generation,'revision',c.revision,'schemaVersion',c.schema_version,'serverTime',clock_timestamp(),
    'siteName',(select to_jsonb(r)-'owner_id' from public.planner_records r where owner_id=auth.uid() and kind='settings' and parent_id is null and data->>'name'='websiteName' order by created_at limit 1),
    'overview',(select coalesce(jsonb_agg(jsonb_build_object('id',scope.id,'total',n.total,'effective',n.effective,'done',n.done,'cancelled',n.cancelled)),'[]'::jsonb)
      from public.planner_records scope cross join lateral(select count(*) as total,count(*) filter(where item.data->>'status'<>'cancelled') as effective,
        count(*) filter(where item.data->>'status'='done') as done,count(*) filter(where item.data->>'status'='cancelled') as cancelled
        from public.planner_records item join public.planner_records item_plan on item_plan.id=item.parent_id join public.planner_records item_direction on item_direction.id=item_plan.parent_id where item.owner_id=auth.uid() and item.kind='item' and not coalesce((item.data->>'trashed')::boolean,false) and not coalesce((item_plan.data->>'trashed')::boolean,false) and not coalesce((item_direction.data->>'trashed')::boolean,false) and
          (scope.kind='plan' and item.parent_id=scope.id or scope.kind='direction' and item.parent_id in
            (select id from public.planner_records plan where plan.owner_id=auth.uid() and plan.kind='plan' and plan.parent_id=scope.id and
              (coalesce((scope.data->>'archived')::boolean,false) or not coalesce((plan.data->>'archived')::boolean,false))))) n
      where scope.owner_id=auth.uid() and scope.kind in ('direction','plan')),
    'contents',(select coalesce(jsonb_agg(jsonb_build_object('id',scope.id,
      'plans',(select count(*) from public.planner_records p where p.owner_id=auth.uid() and p.kind='plan' and p.parent_id=scope.id and not coalesce((p.data->>'trashed')::boolean,false)),
      'items',(select count(*) from public.planner_records item where item.owner_id=auth.uid() and item.kind='item' and not coalesce((item.data->>'trashed')::boolean,false) and
        (scope.kind='plan' and item.parent_id=scope.id or scope.kind='direction' and item.parent_id in(select id from public.planner_records p where p.owner_id=auth.uid() and p.kind='plan' and p.parent_id=scope.id and not coalesce((p.data->>'trashed')::boolean,false)))))), '[]'::jsonb)
      from public.planner_records scope where scope.owner_id=auth.uid() and scope.kind in ('direction','plan')),
    'records',coalesce((select jsonb_agg(to_jsonb(r)-'owner_id' order by r.created_at,r.id) from public.planner_records r where r.owner_id=auth.uid() and r.kind in ('direction','plan')),'[]'::jsonb));
end;
$$;
update public.planner_control set generation=gen_random_uuid(),revision=revision+1,daily_day=null where singleton=true;
notify pgrst,'reload schema';
