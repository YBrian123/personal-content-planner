create function public.planner_capture_baselines() returns void language plpgsql security definer set search_path='' as $$
declare plan_row record; batch_name text; scope_name text; members jsonb;
begin
  for plan_row in select id from public.planner_records where owner_id=auth.uid() and kind='plan' loop
    for batch_name in select null::text union select distinct data->>'batch' from public.planner_records where owner_id=auth.uid() and kind='item' and parent_id=plan_row.id and coalesce(data->>'batch','')<>'' loop
      scope_name:=case when batch_name is null then 'baseline:plan' else 'baseline:batch:'||md5(batch_name) end;
      if exists(select 1 from public.planner_records where owner_id=auth.uid() and kind='settings' and parent_id=plan_row.id and data->>'name'=scope_name) then continue; end if;
      select jsonb_agg(jsonb_build_object('id',id,'platform',data->>'platform','group',data->>'group','type',data->>'type') order by id) into members
        from public.planner_records where owner_id=auth.uid() and kind='item' and parent_id=plan_row.id and not coalesce((data->>'trashed')::boolean,false) and (batch_name is null or data->>'batch'=batch_name);
      if members is not null then insert into public.planner_records(owner_id,kind,parent_id,data) values(auth.uid(),'settings',plan_row.id,jsonb_build_object('name',scope_name,'value',jsonb_build_object('members',members))); end if;
    end loop;
  end loop;
end; $$;
revoke execute on function public.planner_capture_baselines() from public,anon,authenticated;

-- Complete existing v1 behavior: correction, history paging and explicit ordering.
create or replace function public.planner_validate(p_kind text,p_data jsonb) returns void language plpgsql set search_path='' as $$
declare k text; allowed text[]; a text; b text;
begin
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'INVALID_DATA'; end if;
  allowed:=case p_kind
    when 'direction' then array['name','goal','archived']
    when 'plan' then array['name','goal','defaultCriteria','archived','defaultBatch','reviewEnabled']
    when 'item' then array['title','sourceCode','sourceVersion','platform','group','chapter','batch','rank','priority','type','goal','outline','explanation','criteria','notes','status','beforeDone','planStart','planEnd','actualStart','actualFinish','startPrecision','finishPrecision','verifiedOn','informationType','trashed','links','related']
    when 'effort' then array['minutes','on','note','voided']
    when 'reference' then array['name','text','url','path','sourceVersion']
    when 'closure' then array['name','mode','members','summary','closedAt','reopened','note']
    when 'settings' then array['name','value']
    when 'event' then array['action','recordId','before','after','occurredAt','recordedAt','operationId','note','parentBefore','parentAfter']
    else null end;
  if allowed is null then raise exception 'INVALID_KIND'; end if;
  for k in select jsonb_object_keys(p_data) loop
    if not(k=any(allowed)) then raise exception 'INVALID_FIELD: %',k; end if;
    if k in ('rank','minutes') then
      if jsonb_typeof(p_data->k)<>'number' or p_data->>k !~ '^[0-9]+$' then raise exception 'INVALID_NUMBER'; end if;
    elsif k in ('links','related','members') then
      if jsonb_typeof(p_data->k)<>'array' then raise exception 'INVALID_ARRAY'; end if;
    elsif k not in ('archived','trashed','reopened','voided','reviewEnabled','before','after','summary','value') and not(k in ('recordId','parentBefore','parentAfter') and p_data->k='null'::jsonb) then
      if jsonb_typeof(p_data->k)<>'string' then raise exception 'INVALID_TEXT'; end if;
    end if;
    if length(p_data->>k)>80000 and k not in ('members','before','after','value') then raise exception 'TEXT_TOO_LONG'; end if;
  end loop;
  for k in select unnest(array['archived','trashed','reopened','voided','reviewEnabled']) loop
    if p_data ? k and jsonb_typeof(p_data->k)<>'boolean' then raise exception 'INVALID_BOOLEAN'; end if;
  end loop;
  if p_kind in ('direction','plan','reference') and (length(trim(p_data->>'name')) not between 1 and 200 or p_data->>'name' is null)
    then raise exception 'NAME_REQUIRED'; end if;
  if p_kind='item' then
    if length(trim(p_data->>'title')) not between 1 and 300 or p_data->>'title' is null then raise exception 'TITLE_REQUIRED'; end if;
    if coalesce(p_data->>'status','todo') not in ('todo','doing','done','paused','cancelled') then raise exception 'INVALID_STATUS'; end if;
    if coalesce(p_data->>'type','content') not in ('content','support') then raise exception 'INVALID_TYPE'; end if;
    if coalesce(p_data->>'priority','normal') not in ('high','normal','low') then raise exception 'INVALID_PRIORITY'; end if;
    for k in select unnest(array['planStart','planEnd','verifiedOn']) loop
      a:=nullif(p_data->>k,'');
      if a is not null and (a !~ '^\d{4}-\d{2}-\d{2}$' or (a::date)::text<>a) then raise exception 'INVALID_DATE'; end if;
    end loop;
    if nullif(p_data->>'planStart','')::date > nullif(p_data->>'planEnd','')::date then raise exception 'INVALID_DATE_ORDER'; end if;
    for k in select unnest(array['actualStart','actualFinish']) loop
      a:=nullif(p_data->>k,'');
      if a is not null then
        if coalesce(p_data->>(case k when 'actualStart' then 'startPrecision' else 'finishPrecision' end),'minute') not in ('minute','date') then raise exception 'INVALID_PRECISION'; end if;
        if coalesce(p_data->>(case k when 'actualStart' then 'startPrecision' else 'finishPrecision' end),'minute')='date' then
          if a !~ '^\d{4}-\d{2}-\d{2}$' or (a::date)::text<>a then raise exception 'INVALID_DATE'; end if;
        else
          if a !~ '^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$' then raise exception 'INVALID_TIMESTAMP'; end if;
          perform a::timestamptz;
        end if;
      end if;
    end loop;
    a:=nullif(p_data->>'actualStart',''); b:=nullif(p_data->>'actualFinish','');
    if a is not null and b is not null then
      if (p_data->>'startPrecision'='date' or p_data->>'finishPrecision'='date') then
        if ((a::timestamptz at time zone 'Asia/Shanghai')::date)>((b::timestamptz at time zone 'Asia/Shanghai')::date) then raise exception 'INVALID_TIME_ORDER'; end if;
      elsif a::timestamptz>b::timestamptz then raise exception 'INVALID_TIME_ORDER'; end if;
    end if;
    if p_data ? 'links' and jsonb_typeof(p_data->'links')<>'array' then raise exception 'INVALID_LINKS'; end if;
  end if;
  if p_kind='effort' and (coalesce(p_data->>'minutes','') !~ '^[0-9]+$' or (p_data->>'minutes')::bigint not between 1 and 5256000) then raise exception 'INVALID_EFFORT'; end if;
end; $$;
create or replace function public.planner_list(p_plan uuid,p_filter jsonb default '{}',p_offset integer default 0,p_limit integer default 50) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; totals jsonb;
begin
  if not public.planner_is_owner() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  perform 1 from public.planner_control where owner_id=auth.uid() for share;
  if not found then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_offset<0 or p_limit not between 1 and 200 then raise exception 'INVALID_PAGE'; end if;
  with scope as (select r.* from public.planner_records r where r.owner_id=auth.uid() and r.kind='item' and r.parent_id=p_plan
    and coalesce((r.data->>'trashed')::boolean,false)=coalesce((p_filter->>'trash')::boolean,false)
    and (coalesce(p_filter->>'batch','')='' or r.data->>'batch'=p_filter->>'batch')
    and (coalesce(p_filter->>'platform','')='' or r.data->>'platform'=p_filter->>'platform')
    and (coalesce(p_filter->>'group','')='' or r.data->>'group'=p_filter->>'group'))
  select jsonb_build_object('total',count(*),'effective',count(*) filter(where data->>'status'<>'cancelled'),
    'done',count(*) filter(where data->>'status'='done'),'cancelled',count(*) filter(where data->>'status'='cancelled'),
    'content',count(*) filter(where data->>'type'='content' and data->>'status'='done'),
    'support',count(*) filter(where data->>'type'='support' and data->>'status'='done'),
    'started',min(nullif(data->>'actualStart','')) filter(where data->>'status'<>'cancelled'),'finished',max(nullif(data->>'actualFinish','')) filter(where data->>'status'<>'cancelled'),
    'missingStart',count(*) filter(where data->>'status'<>'cancelled' and coalesce(data->>'actualStart','')=''),
    'effortMinutes',coalesce((select sum((e.data->>'minutes')::bigint) from public.planner_records e where e.kind='effort' and not coalesce((e.data->>'voided')::boolean,false) and e.parent_id in(select id from scope where data->>'status'<>'cancelled')),0),
    'effortCoverage',(select count(distinct parent_id) from public.planner_records where kind='effort' and not coalesce((data->>'voided')::boolean,false) and parent_id in(select id from scope where data->>'status'<>'cancelled')),
    'cancelledEffort',coalesce((select sum((e.data->>'minutes')::bigint) from public.planner_records e where e.kind='effort' and not coalesce((e.data->>'voided')::boolean,false) and e.parent_id in(select id from scope where data->>'status'='cancelled')),0)) into totals from scope;
  with matched as(select r.* from public.planner_records r where r.owner_id=auth.uid() and r.kind='item' and r.parent_id=p_plan
    and coalesce((r.data->>'trashed')::boolean,false)=coalesce((p_filter->>'trash')::boolean,false)
    and (coalesce(p_filter->>'batch','')='' or r.data->>'batch'=p_filter->>'batch')
    and (coalesce(p_filter->>'platform','')='' or r.data->>'platform'=p_filter->>'platform')
    and (coalesce(p_filter->>'group','')='' or r.data->>'group'=p_filter->>'group')
    and (coalesce(p_filter->>'status','')='' or r.data->>'status'=p_filter->>'status')
    and (coalesce(p_filter->>'view','')='' or
      (p_filter->>'view'='doing' and r.data->>'status'='doing') or
      (p_filter->>'view'='unscheduled' and coalesce(r.data->>'planEnd','')='' and r.data->>'status' not in ('done','cancelled')) or
      (p_filter->>'view'='overdue' and r.data->>'status' not in ('done','cancelled') and nullif(r.data->>'planEnd','')::date < (now() at time zone 'Asia/Shanghai')::date) or
      (p_filter->>'view'='upcoming' and r.data->>'status' not in ('done','cancelled') and nullif(r.data->>'planEnd','')::date between (now() at time zone 'Asia/Shanghai')::date and (now() at time zone 'Asia/Shanghai')::date+7) or
      (p_filter->>'view'='review' and exists(select 1 from public.planner_records plan where plan.id=p_plan and coalesce((plan.data->>'reviewEnabled')::boolean,false)) and
        r.data->>'informationType' in ('A','B','A+B') and (nullif(r.data->>'verifiedOn','')::date + case when r.data->>'informationType'='A' then interval '6 months' else interval '3 months' end)::date <= (now() at time zone 'Asia/Shanghai')::date))
    and (coalesce(p_filter->>'q','')='' or strpos(lower(concat_ws(' ',r.data->>'title',r.data->>'sourceCode',r.data->>'notes')),lower(p_filter->>'q'))>0)),
  page as(select id,kind,parent_id,revision,created_at,updated_at,data-'outline'-'explanation'-'goal'-'notes'-'links'-'related' as data,row_number() over(order by case when p_filter->>'sort'='deadline' then nullif(data->>'planEnd','') end nulls last,
    case when p_filter->>'sort'='finished' then nullif(data->>'actualFinish','') end desc nulls last,
    case when p_filter->>'sort'='priority' then case data->>'priority' when 'high' then 0 when 'normal' then 1 else 2 end end,
    case when p_filter->>'sort'='elapsed' and coalesce(data->>'actualStart','')<>'' and coalesce(data->>'actualFinish','')<>'' then (data->>'actualFinish')::timestamptz-(data->>'actualStart')::timestamptz end desc nulls last,
    case when coalesce(p_filter->>'sort','rank')='rank' then coalesce(nullif(data->>'rank','')::numeric,999999) end,id) as page_order from matched order by page_order limit p_limit offset p_offset)
  select jsonb_build_object('records',coalesce((select jsonb_agg(to_jsonb(page)-'page_order' order by page_order) from page),'[]'::jsonb),'matched',(select count(*) from matched),'totals',totals,
    'revision',(select revision from public.planner_control)) into result;
  declare baseline jsonb; original_ids uuid[]; current_ids uuid[];
  begin
    select data->'value'->'members' into baseline from public.planner_records where owner_id=auth.uid() and kind='settings' and parent_id=p_plan
      and data->>'name'=case when coalesce(p_filter->>'batch','')='' then 'baseline:plan' else 'baseline:batch:'||md5(p_filter->>'batch') end limit 1;
    if baseline is not null then
      select coalesce(array_agg((m->>'id')::uuid),'{}'::uuid[]) into original_ids from jsonb_array_elements(baseline)m where
        (coalesce(p_filter->>'platform','')='' or m->>'platform'=p_filter->>'platform') and (coalesce(p_filter->>'group','')='' or m->>'group'=p_filter->>'group');
      select coalesce(array_agg(id),'{}'::uuid[]) into current_ids from public.planner_records where owner_id=auth.uid() and kind='item' and parent_id=p_plan and not coalesce((data->>'trashed')::boolean,false)
        and (coalesce(p_filter->>'batch','')='' or data->>'batch'=p_filter->>'batch') and (coalesce(p_filter->>'platform','')='' or data->>'platform'=p_filter->>'platform') and (coalesce(p_filter->>'group','')='' or data->>'group'=p_filter->>'group');
      result:=jsonb_set(result,'{totals}',(result->'totals')||jsonb_build_object('original',cardinality(original_ids),
        'added',(select count(*) from unnest(current_ids)u(id) where not(id=any(original_ids))),
        'removed',(select count(*) from unnest(original_ids)u(id) where not(id=any(current_ids)))));
    end if;
  end;
  return result;
end; $$;
drop function public.planner_detail(uuid);
create function public.planner_detail(p_id uuid,p_offset integer default 0) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.planner_is_owner() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  perform 1 from public.planner_control where owner_id=auth.uid() for share;
  if not found then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if p_offset<0 then raise exception 'INVALID_PAGE'; end if;
  return jsonb_build_object('record',(select to_jsonb(r)-'owner_id' from public.planner_records r where id=p_id and owner_id=auth.uid()),
    'related',coalesce((select jsonb_agg(x.obj order by x.created_at desc,x.id) from (
      select to_jsonb(r)-'owner_id' as obj,r.created_at,r.id from public.planner_records r where owner_id=auth.uid() and parent_id=p_id and kind='effort'
      union all
      select * from(select to_jsonb(r)-'owner_id' as obj,r.created_at,r.id from public.planner_records r where owner_id=auth.uid() and kind='event' and data->>'recordId'=p_id::text order by created_at desc,id desc limit 50 offset p_offset) h
    ) x),'[]'::jsonb),
    'historyTotal',(select count(*) from public.planner_records where owner_id=auth.uid() and kind='event' and data->>'recordId'=p_id::text));
end; $$;
revoke execute on function public.planner_detail(uuid,integer) from public,anon;
grant execute on function public.planner_detail(uuid,integer) to authenticated;

create or replace function public.planner_execute(p_operation uuid,p_generation uuid,p_action text,p_payload jsonb default '{}',p_expected bigint default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.planner_control; request_body jsonb; previous jsonb; response jsonb; r public.planner_records; before_data jsonb;
  target uuid; new_id uuid; d jsonb; new_status text; event_action text; entry jsonb; bundle jsonb; snapshot_id uuid; parent_kind text; k text;
begin
  if not public.planner_is_owner() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into c from public.planner_control for update;
  if c.owner_id is distinct from auth.uid() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  if c.generation<>p_generation then raise exception 'STALE_GENERATION'; end if;
  if c.schema_version<>1 then raise exception 'SCHEMA_MISMATCH'; end if;
  if p_operation is null then raise exception 'OPERATION_REQUIRED'; end if;
  request_body:=jsonb_build_object('action',p_action,'payload',p_payload,'expected',p_expected);
  select result into response from public.planner_operations where owner_id=auth.uid() and generation=p_generation and operation_id=p_operation;
  if found then
    if (select o.request from public.planner_operations o where owner_id=auth.uid() and generation=p_generation and operation_id=p_operation)<>request_body then raise exception 'OPERATION_REUSED'; end if;
    return response;
  end if;
  target:=nullif(p_payload->>'id','')::uuid;
  if target is not null then
    select * into r from public.planner_records where id=target and owner_id=auth.uid();
    if not found then raise exception 'NOT_FOUND'; end if;
    if p_expected is null or r.revision<>p_expected then raise exception 'CONFLICT'; end if;
    before_data:=r.data;
  end if;
  if p_action='create' then
    if p_payload->>'kind' not in ('direction','plan','item','reference') then raise exception 'INVALID_KIND'; end if;
    d:=p_payload->'data';
    if p_payload->>'kind'='item' then
      d:=jsonb_build_object('status','todo','type','content','platform','公众号','priority','normal','rank',999999,'trashed',false)||d;
      d:=d||jsonb_build_object('status','todo','actualStart','','actualFinish','');
    end if;
    perform public.planner_validate(p_payload->>'kind',d);
    if p_payload->>'kind'<>'direction' then
      select kind into parent_kind from public.planner_records where id=(p_payload->>'parent_id')::uuid and owner_id=auth.uid();
      if parent_kind is distinct from (case when p_payload->>'kind'='plan' then 'direction' else 'plan' end) then raise exception 'INVALID_PARENT'; end if;
    end if;
    insert into public.planner_records(owner_id,kind,parent_id,data) values(auth.uid(),p_payload->>'kind',nullif(p_payload->>'parent_id','')::uuid,d) returning id into target;
    if p_payload->>'kind'='direction' then
      insert into public.planner_records(owner_id,kind,parent_id,data) values(auth.uid(),'plan',target,'{"name":"零散选题","archived":false}');
    end if;
    event_action:='create';
  elsif p_action='edit' then
    if r.kind not in ('direction','plan','item','reference','settings') then raise exception 'INVALID_EDIT'; end if;
    if (p_payload->'changes') ?| array['status','beforeDone','trashed','archived'] then raise exception 'USE_STATE_ACTION'; end if;
    if r.kind='settings' and r.data->>'name' like 'baseline:%' then raise exception 'IMMUTABLE_BASELINE'; end if;
    d:=r.data||(p_payload->'changes'); perform public.planner_validate(r.kind,d);
    update public.planner_records set data=d,revision=revision+1,updated_at=now() where id=target;
    event_action:='edit';
  elsif p_action in ('status','undo','reopen') then
    if r.kind<>'item' then raise exception 'INVALID_KIND'; end if;
    new_status:=case p_action when 'undo' then coalesce(r.data->>'beforeDone','todo') when 'reopen' then 'doing' else p_payload->>'status' end;
    if coalesce((r.data->>'trashed')::boolean,false) then raise exception 'ITEM_TRASHED'; end if;
    d:=r.data;
    if new_status<>r.data->>'status' then
      if new_status='done' then d:=d||jsonb_build_object('beforeDone',r.data->>'status','actualFinish',coalesce(nullif(p_payload->>'occurredAt',''),to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'finishPrecision','minute'); end if;
      if new_status<>'done' and r.data->>'status'='done' then d:=d||'{"actualFinish":""}'; end if;
      if new_status='doing' and coalesce(d->>'actualStart','')='' then d:=d||jsonb_build_object('actualStart',coalesce(nullif(p_payload->>'occurredAt',''),to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'startPrecision','minute'); end if;
      d:=d||jsonb_build_object('status',new_status); perform public.planner_validate('item',d);
      update public.planner_records set data=d,revision=revision+1,updated_at=now() where id=target;
      event_action:=p_action;
    end if;
  elsif p_action='effort' then
    if r.kind<>'item' then raise exception 'INVALID_KIND'; end if;
    d:=p_payload->'data'; perform public.planner_validate('effort',d);
    insert into public.planner_records(owner_id,kind,parent_id,data) values(auth.uid(),'effort',target,d);
    update public.planner_records set revision=revision+1,updated_at=now() where id=target;
    event_action:='effort';
  elsif p_action in ('trash','untrash','archive','unarchive') then
    if (p_action in ('trash','untrash') and r.kind<>'item') or (p_action in ('archive','unarchive') and r.kind not in ('direction','plan')) then raise exception 'INVALID_KIND'; end if;
    update public.planner_records set data=data||jsonb_build_object(case when p_action in ('trash','untrash') then 'trashed' else 'archived' end,p_action in ('trash','archive')),revision=revision+1,updated_at=now() where id=target;
    event_action:=p_action;
  elsif p_action='move' then
    if r.kind<>'item' or not exists(select 1 from public.planner_records where id=(p_payload->>'parent_id')::uuid and kind='plan' and owner_id=auth.uid()) then raise exception 'INVALID_PARENT'; end if;
    perform public.planner_take_snapshot('move');
    update public.planner_records set parent_id=(p_payload->>'parent_id')::uuid,data=data||'{"batch":"","group":"","chapter":""}',revision=revision+1,updated_at=now() where id=target;
    event_action:='move';
  elsif p_action='copy' then
    if r.kind<>'item' then raise exception 'INVALID_KIND'; end if;
    d:=(r.data-'sourceCode'-'sourceVersion'-'beforeDone'-'links'-'related')||jsonb_build_object('title',left(r.data->>'title',296)||'（副本）','status','todo','planStart','','planEnd','','actualStart','','actualFinish','','verifiedOn','','notes','','links','[]'::jsonb,'related','[]'::jsonb,'startPrecision','minute','finishPrecision','minute','trashed',false);
    perform public.planner_validate('item',d);
    insert into public.planner_records(owner_id,kind,parent_id,data) values(auth.uid(),'item',r.parent_id,d) returning id into target;
    event_action:='copy';
  elsif p_action='correct_effort' then
    if r.kind<>'effort' then raise exception 'INVALID_KIND'; end if;
    d:=r.data||(p_payload->'changes'); perform public.planner_validate('effort',d);
    update public.planner_records set data=d,revision=revision+1,updated_at=now() where id=target;
    update public.planner_records set revision=revision+1,updated_at=now() where id=r.parent_id and owner_id=auth.uid();
    event_action:='correct_effort';
  elsif p_action='undo_edit' then
    select data into previous from public.planner_records where kind='event' and owner_id=auth.uid() and data->>'recordId'=target::text order by created_at desc,id desc limit 1;
    if previous is null or previous->>'action'<>'edit' or previous->'after'<>r.data then raise exception 'UNDO_CONFLICT'; end if;
    d:=previous->'before'; perform public.planner_validate(r.kind,d);
    update public.planner_records set data=d,revision=revision+1,updated_at=now() where id=target;
    event_action:='undo_edit';
  elsif p_action='reopen_batch' then
    if r.kind<>'closure' then raise exception 'INVALID_KIND'; end if;
    if not exists(select 1 from public.planner_records where kind='event' and owner_id=auth.uid() and data->>'action'='reopen_batch' and data->>'recordId'=target::text) then event_action:='reopen_batch'; end if;
  elsif p_action='daily_snapshot' then
    if c.daily_day is distinct from (now() at time zone 'Asia/Shanghai')::date then
      if c.daily_revision<>c.revision then perform public.planner_take_snapshot('daily'); end if;
      update public.planner_control set daily_day=(now() at time zone 'Asia/Shanghai')::date,daily_revision=c.revision;
    end if;
  elsif p_action='close_batch' then
    if p_expected is null or p_expected<>c.revision then raise exception 'RANGE_CHANGED'; end if;
    if not exists(select 1 from public.planner_records where id=(p_payload->>'plan_id')::uuid and kind='plan' and owner_id=auth.uid()) then raise exception 'INVALID_PARENT'; end if;
    if p_payload->>'mode' not in ('completed','stopped') or trim(coalesce(p_payload->>'batch',''))='' then raise exception 'INVALID_BATCH'; end if;
    if p_payload->>'mode'='completed' and (not exists(select 1 from public.planner_records where kind='item' and parent_id=(p_payload->>'plan_id')::uuid and data->>'batch'=p_payload->>'batch' and data->>'status'<>'cancelled' and not coalesce((data->>'trashed')::boolean,false))
      or exists(select 1 from public.planner_records where kind='item' and parent_id=(p_payload->>'plan_id')::uuid and data->>'batch'=p_payload->>'batch' and data->>'status' not in ('done','cancelled') and not coalesce((data->>'trashed')::boolean,false))) then raise exception 'BATCH_INCOMPLETE'; end if;
    perform public.planner_take_snapshot('close_batch');
    d:=jsonb_build_object('name',p_payload->>'batch','mode',p_payload->>'mode','closedAt',now(),'note',coalesce(p_payload->>'note',''),
      'members',coalesce((select jsonb_agg(to_jsonb(x)-'owner_id' order by id) from public.planner_records x where
       (kind='item' and parent_id=(p_payload->>'plan_id')::uuid and data->>'batch'=p_payload->>'batch') or
       (kind='effort' and parent_id in(select id from public.planner_records where kind='item' and parent_id=(p_payload->>'plan_id')::uuid and data->>'batch'=p_payload->>'batch'))),'[]'::jsonb));
    insert into public.planner_records(owner_id,kind,parent_id,data) values(auth.uid(),'closure',(p_payload->>'plan_id')::uuid,d) returning id into target;
    event_action:='close_batch';
  elsif p_action in ('merge','restore') then
    if p_expected is null or p_expected<>c.revision then raise exception 'RANGE_CHANGED'; end if;
    if p_payload->'backup'->>'format' is distinct from 'personal-planner' or
       p_payload->'backup'->>'checksum' is distinct from encode(sha256(convert_to(p_payload->'backup'->>'payload','UTF8')),'hex') then raise exception 'INVALID_CHECKSUM'; end if;
    if octet_length((p_payload->'backup')::text)>16777216 then raise exception 'BACKUP_CAPACITY'; end if;
    bundle:=(p_payload->'backup'->>'payload')::jsonb;
    if bundle->>'schemaVersion' is distinct from '1' or jsonb_typeof(bundle->'records') is distinct from 'array' then raise exception 'INVALID_BACKUP_VERSION'; end if;
    if (select count(*)<>count(distinct x->>'id') from jsonb_array_elements(bundle->'records') x) then raise exception 'DUPLICATE_ID'; end if;
    if jsonb_typeof(p_payload->'backup'->'count') is distinct from 'number' or (p_payload->'backup'->>'count')::numeric<>jsonb_array_length(bundle->'records') then raise exception 'INVALID_MANIFEST'; end if;
    snapshot_id:=public.planner_take_snapshot(p_action);
    if p_action='restore' then
      delete from public.planner_records where owner_id=auth.uid();
      update public.planner_control set generation=gen_random_uuid(),revision=revision+1,daily_day=null;
    end if;
    for entry in select value from jsonb_array_elements(bundle->'records') loop
      perform public.planner_validate(entry->>'kind',entry->'data');
      insert into public.planner_records(id,owner_id,kind,parent_id,data,revision,created_at,updated_at)
      values((entry->>'id')::uuid,auth.uid(),entry->>'kind',nullif(entry->>'parent_id','')::uuid,entry->'data',coalesce((entry->>'revision')::bigint,1),
        coalesce((entry->>'created_at')::timestamptz,now()),coalesce((entry->>'updated_at')::timestamptz,now())) on conflict(id) do nothing;
    end loop;
    if exists(select 1 from public.planner_records child left join public.planner_records parent on parent.id=child.parent_id
      where child.owner_id=auth.uid() and ((child.kind='direction' and child.parent_id is not null) or
      (child.kind='plan' and parent.kind is distinct from 'direction') or
      (child.kind in ('item','closure','reference') and parent.kind is distinct from 'plan') or
      (child.kind='effort' and parent.kind is distinct from 'item') or (child.parent_id is not null and parent.owner_id is distinct from auth.uid()))) then raise exception 'INVALID_RELATION'; end if;
    event_action:=p_action; target:=null;
  else raise exception 'UNKNOWN_ACTION';
  end if;
  if exists(select 1 from public.planner_records item cross join lateral jsonb_array_elements_text(coalesce(item.data->'related','[]')) link(id)
    where item.owner_id=auth.uid() and item.kind='item' and not exists(select 1 from public.planner_records other where other.owner_id=auth.uid() and other.kind='item' and other.id::text=link.id)) then raise exception 'INVALID_RELATED_ITEM'; end if;
  if event_action is not null and p_action<>'restore' then perform public.planner_capture_baselines(); end if;
  if event_action is not null then
    insert into public.planner_records(owner_id,kind,data) values(auth.uid(),'event',jsonb_build_object('action',event_action,'recordId',target,'before',before_data,
      'after',(select data from public.planner_records where id=target),'occurredAt',coalesce(nullif(p_payload->>'occurredAt',''),now()::text),'recordedAt',now(),'operationId',p_operation,'parentBefore',r.parent_id,'parentAfter',(select parent_id from public.planner_records where id=target)));
    update public.planner_control set revision=revision+1;
  end if;
  response:=jsonb_build_object('id',target,'generation',(select generation from public.planner_control),'revision',(select revision from public.planner_control),'snapshot',snapshot_id,'record',(select to_jsonb(x)-'owner_id' from public.planner_records x where id=target));
  insert into public.planner_operations(owner_id,generation,operation_id,request,result) values(auth.uid(),p_generation,p_operation,request_body,response);
  return response;
end; $$;
do $$ begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public,anon,authenticated;
  end if;
end; $$;
notify pgrst, 'reload schema';

update public.planner_control set generation=gen_random_uuid(),revision=revision+1,daily_day=null;

create or replace function public.planner_context() returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.planner_control;
begin
  if not public.planner_is_owner() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  perform 1 from public.planner_control where owner_id=auth.uid() for share;
  if not found then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into c from public.planner_control;
  return jsonb_build_object('generation',c.generation,'revision',c.revision,'schemaVersion',c.schema_version,
    'serverTime',clock_timestamp(),'siteName',(select to_jsonb(r)-'owner_id' from public.planner_records r where owner_id=auth.uid() and kind='settings' and parent_id is null and data->>'name'='websiteName' order by created_at limit 1),'overview',(select coalesce(jsonb_agg(jsonb_build_object('id',scope.id,'total',n.total,'effective',n.effective,'done',n.done,'cancelled',n.cancelled)),'[]'::jsonb)
    from public.planner_records scope cross join lateral(select count(*) as total,count(*) filter(where item.data->>'status'<>'cancelled') as effective,
      count(*) filter(where item.data->>'status'='done') as done,count(*) filter(where item.data->>'status'='cancelled') as cancelled
      from public.planner_records item where item.owner_id=auth.uid() and item.kind='item' and not coalesce((item.data->>'trashed')::boolean,false) and
        (scope.kind='plan' and item.parent_id=scope.id or scope.kind='direction' and item.parent_id in
          (select id from public.planner_records plan where plan.owner_id=auth.uid() and plan.kind='plan' and plan.parent_id=scope.id
           and (coalesce((scope.data->>'archived')::boolean,false) or not coalesce((plan.data->>'archived')::boolean,false))))) n
    where scope.owner_id=auth.uid() and scope.kind in ('direction','plan')),'records',coalesce((select jsonb_agg(to_jsonb(r)-'owner_id' order by r.created_at,r.id) from public.planner_records r where r.owner_id=auth.uid() and r.kind in ('direction','plan')),'[]'::jsonb));
end; $$;
create or replace function public.planner_export() returns jsonb language plpgsql security definer set search_path='' as $$
declare payload text; result jsonb; c public.planner_control;
begin
  if not public.planner_is_owner() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into c from public.planner_control for share;
  payload:=public.planner_payload()::text;
  result:=jsonb_build_object('format','personal-planner','payload',payload,'checksum',encode(sha256(convert_to(payload,'UTF8')),'hex'),'exportedAt',now(),'generation',c.generation,'revision',c.revision,'count',jsonb_array_length(payload::jsonb->'records'));
  if octet_length(result::text)>16777216 then raise exception 'BACKUP_CAPACITY'; end if;
  return result;
end; $$;
