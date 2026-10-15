-- Execute as project database administrator. No owner is assigned by a browser visitor.
create table public.planner_control (
  singleton boolean primary key default true check(singleton),
  owner_id uuid,
  generation uuid not null default gen_random_uuid(),
  revision bigint not null default 0,
  schema_version integer not null default 1,
  daily_day date,
  daily_revision bigint not null default -1
);
insert into public.planner_control(singleton) values(true);
create table public.planner_records (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  kind text not null check(kind in ('direction','plan','item','effort','event','closure','reference','settings')),
  parent_id uuid references public.planner_records(id) on delete cascade deferrable initially deferred,
  data jsonb not null check(jsonb_typeof(data)='object'),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index planner_parent on public.planner_records(parent_id,kind);
create unique index planner_source on public.planner_records(parent_id,(data->>'sourceCode'))
  where kind='item' and coalesce(data->>'sourceCode','')<>'';
create table public.planner_operations (
  owner_id uuid not null, generation uuid not null, operation_id uuid not null,
  request jsonb not null, result jsonb not null, recorded_at timestamptz not null default now(),
  primary key(owner_id,generation,operation_id)
);
create table public.planner_snapshots (
  id uuid primary key default gen_random_uuid(), owner_id uuid not null,
  reason text not null, payload jsonb not null, bytes bigint not null,
  created_at timestamptz not null default now()
);

create function public.planner_is_owner() returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.planner_control where owner_id=auth.uid());
$$;
alter table public.planner_control enable row level security;
alter table public.planner_records enable row level security;
alter table public.planner_operations enable row level security;
alter table public.planner_snapshots enable row level security;
create policy owner_read on public.planner_records for select to authenticated
  using(owner_id=auth.uid() and public.planner_is_owner());
create policy owner_read on public.planner_snapshots for select to authenticated
  using(owner_id=auth.uid() and public.planner_is_owner());
revoke all on public.planner_control,public.planner_records,public.planner_operations,public.planner_snapshots from anon,authenticated;
grant select on public.planner_records,public.planner_snapshots to authenticated;

create function public.planner_validate(p_kind text,p_data jsonb) returns void language plpgsql set search_path='' as $$
declare k text; allowed text[]; a text; b text;
begin
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'INVALID_DATA'; end if;
  allowed:=case p_kind
    when 'direction' then array['name','goal','archived']
    when 'plan' then array['name','goal','defaultCriteria','archived']
    when 'item' then array['title','sourceCode','sourceVersion','platform','group','chapter','batch','rank','priority','type','goal','outline','explanation','criteria','notes','status','beforeDone','planStart','planEnd','actualStart','actualFinish','startPrecision','finishPrecision','verifiedOn','informationType','trashed','links','related']
    when 'effort' then array['minutes','on','note']
    when 'reference' then array['name','text','url','path','sourceVersion']
    when 'closure' then array['name','mode','members','summary','closedAt','reopened','note']
    when 'settings' then array['name','value']
    when 'event' then array['action','recordId','before','after','occurredAt','recordedAt','operationId','note']
    else null end;
  if allowed is null then raise exception 'INVALID_KIND'; end if;
  for k in select jsonb_object_keys(p_data) loop
    if not(k=any(allowed)) then raise exception 'INVALID_FIELD: %',k; end if;
    if k in ('rank','minutes') then
      if jsonb_typeof(p_data->k)<>'number' or p_data->>k !~ '^[0-9]+$' then raise exception 'INVALID_NUMBER'; end if;
    elsif k in ('links','related','members') then
      if jsonb_typeof(p_data->k)<>'array' then raise exception 'INVALID_ARRAY'; end if;
    elsif k not in ('archived','trashed','reopened','before','after','summary','value') and not(k='recordId' and p_data->k='null'::jsonb) then
      if jsonb_typeof(p_data->k)<>'string' then raise exception 'INVALID_TEXT'; end if;
    end if;
    if length(p_data->>k)>80000 and k not in ('members','before','after') then raise exception 'TEXT_TOO_LONG'; end if;
  end loop;
  for k in select unnest(array['archived','trashed','reopened']) loop
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

create function public.planner_payload() returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('schemaVersion',1,'records',coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'kind',kind,'parent_id',parent_id,'data',data,'revision',revision,
    'created_at',created_at,'updated_at',updated_at) order by id),'[]'::jsonb))
  from public.planner_records where owner_id=auth.uid();
$$;
create function public.planner_take_snapshot(p_reason text) returns uuid language plpgsql security definer set search_path='' as $$
declare payload jsonb; n bigint; result uuid;
begin
  payload:=public.planner_payload(); n:=octet_length(payload::text);
  if n>52428800 then raise exception 'SNAPSHOT_BUDGET'; end if;
  insert into public.planner_snapshots(owner_id,reason,payload,bytes) values(auth.uid(),p_reason,payload,n) returning id into result;
  loop
    exit when (select count(*)<=30 and coalesce(sum(bytes),0)<=52428800 from public.planner_snapshots where owner_id=auth.uid());
    delete from public.planner_snapshots where id=(select id from public.planner_snapshots where owner_id=auth.uid() and id<>result order by created_at,id limit 1);
  end loop;
  return result;
end; $$;
create function public.planner_context() returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.planner_control;
begin
  if not public.planner_is_owner() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into c from public.planner_control;
  return jsonb_build_object('generation',c.generation,'revision',c.revision,'schemaVersion',c.schema_version,
    'serverTime',clock_timestamp(),'records',coalesce((select jsonb_agg(to_jsonb(r)-'owner_id' order by r.created_at,r.id) from public.planner_records r where r.owner_id=auth.uid() and r.kind in ('direction','plan')),'[]'::jsonb));
end; $$;
create function public.planner_list(p_plan uuid,p_filter jsonb default '{}',p_offset integer default 0,p_limit integer default 50) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; totals jsonb;
begin
  if not public.planner_is_owner() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
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
    'started',min(nullif(data->>'actualStart','')),'finished',max(nullif(data->>'actualFinish','')),
    'missingStart',count(*) filter(where data->>'status'<>'cancelled' and coalesce(data->>'actualStart','')=''),
    'effortMinutes',coalesce((select sum((e.data->>'minutes')::bigint) from public.planner_records e where e.kind='effort' and e.parent_id in(select id from scope where data->>'status'<>'cancelled')),0),
    'effortCoverage',(select count(distinct parent_id) from public.planner_records where kind='effort' and parent_id in(select id from scope where data->>'status'<>'cancelled')),
    'cancelledEffort',coalesce((select sum((e.data->>'minutes')::bigint) from public.planner_records e where e.kind='effort' and e.parent_id in(select id from scope where data->>'status'='cancelled')),0)) into totals from scope;
  with matched as(select r.* from public.planner_records r where r.owner_id=auth.uid() and r.kind='item' and r.parent_id=p_plan
    and coalesce((r.data->>'trashed')::boolean,false)=coalesce((p_filter->>'trash')::boolean,false)
    and (coalesce(p_filter->>'batch','')='' or r.data->>'batch'=p_filter->>'batch')
    and (coalesce(p_filter->>'platform','')='' or r.data->>'platform'=p_filter->>'platform')
    and (coalesce(p_filter->>'group','')='' or r.data->>'group'=p_filter->>'group')
    and (coalesce(p_filter->>'status','')='' or r.data->>'status'=p_filter->>'status')
    and (coalesce(p_filter->>'q','')='' or strpos(lower(concat_ws(' ',r.data->>'title',r.data->>'sourceCode',r.data->>'notes')),lower(p_filter->>'q'))>0)),
  page as(select id,kind,parent_id,revision,created_at,updated_at,data-'outline'-'explanation'-'goal'-'notes'-'links'-'related' as data from matched
    order by case when p_filter->>'sort'='deadline' then nullif(data->>'planEnd','') end nulls last,
    case when p_filter->>'sort'='finished' then nullif(data->>'actualFinish','') end desc nulls last,
    case when p_filter->>'sort'='priority' then case data->>'priority' when 'high' then 0 when 'normal' then 1 else 2 end end,
    case when p_filter->>'sort'='elapsed' and coalesce(data->>'actualStart','')<>'' and coalesce(data->>'actualFinish','')<>'' then (data->>'actualFinish')::timestamptz-(data->>'actualStart')::timestamptz end desc nulls last,
    case when coalesce(p_filter->>'sort','rank')='rank' then coalesce(nullif(data->>'rank','')::numeric,999999) end,id limit p_limit offset p_offset)
  select jsonb_build_object('records',coalesce((select jsonb_agg(to_jsonb(page)) from page),'[]'::jsonb),'matched',(select count(*) from matched),'totals',totals,
    'revision',(select revision from public.planner_control)) into result;
  return result;
end; $$;
create function public.planner_detail(p_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if not public.planner_is_owner() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  return jsonb_build_object('record',(select to_jsonb(r)-'owner_id' from public.planner_records r where id=p_id and owner_id=auth.uid()),
    'related',coalesce((select jsonb_agg(to_jsonb(r)-'owner_id' order by created_at desc,id) from public.planner_records r
      where owner_id=auth.uid() and (parent_id=p_id or (kind='event' and data->>'recordId'=p_id::text))),'[]'::jsonb));
end; $$;
create function public.planner_export() returns jsonb language plpgsql security definer set search_path='' as $$
declare payload text; result jsonb;
begin
  if not public.planner_is_owner() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  payload:=public.planner_payload()::text;
  result:=jsonb_build_object('format','personal-planner','payload',payload,'checksum',encode(sha256(convert_to(payload,'UTF8')),'hex'),'exportedAt',now(),'count',jsonb_array_length(payload::jsonb->'records'));
  if octet_length(result::text)>16777216 then raise exception 'BACKUP_CAPACITY'; end if;
  return result;
end; $$;

create function public.planner_execute(p_operation uuid,p_generation uuid,p_action text,p_payload jsonb default '{}',p_expected bigint default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.planner_control; request_body jsonb; previous jsonb; response jsonb; r public.planner_records; before_data jsonb;
  target uuid; new_id uuid; d jsonb; new_status text; event_action text; entry jsonb; bundle jsonb; snapshot_id uuid; parent_kind text; k text;
begin
  if not public.planner_is_owner() then raise exception 'FORBIDDEN' using errcode='42501'; end if;
  select * into c from public.planner_control for update;
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
    d:=(r.data-'sourceCode'-'sourceVersion'-'beforeDone'-'links'-'related')||jsonb_build_object('title',(r.data->>'title')||'（副本）','status','todo','planStart','','planEnd','','actualStart','','actualFinish','','verifiedOn','','trashed',false);
    perform public.planner_validate('item',d);
    insert into public.planner_records(owner_id,kind,parent_id,data) values(auth.uid(),'item',r.parent_id,d) returning id into target;
    event_action:='copy';
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
  if event_action is not null then
    insert into public.planner_records(owner_id,kind,data) values(auth.uid(),'event',jsonb_build_object('action',event_action,'recordId',target,'before',before_data,
      'after',(select data from public.planner_records where id=target),'occurredAt',coalesce(nullif(p_payload->>'occurredAt',''),now()::text),'recordedAt',now(),'operationId',p_operation));
    update public.planner_control set revision=revision+1;
  end if;
  response:=jsonb_build_object('id',target,'generation',(select generation from public.planner_control),'revision',(select revision from public.planner_control),'snapshot',snapshot_id,'record',(select to_jsonb(x)-'owner_id' from public.planner_records x where id=target));
  insert into public.planner_operations(owner_id,generation,operation_id,request,result) values(auth.uid(),p_generation,p_operation,request_body,response);
  return response;
end; $$;
-- All helpers start private, including future functions. Explicitly grant only the five API endpoints.
do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname like 'planner_%' loop
    execute format('revoke execute on function %s from public,anon,authenticated',f.signature);
  end loop;
end; $$;
alter default privileges in schema public revoke execute on functions from public;
grant execute on function public.planner_is_owner() to authenticated;
grant execute on function public.planner_context(),public.planner_list(uuid,jsonb,integer,integer),public.planner_detail(uuid),public.planner_export(),public.planner_execute(uuid,uuid,text,jsonb,bigint) to authenticated;
