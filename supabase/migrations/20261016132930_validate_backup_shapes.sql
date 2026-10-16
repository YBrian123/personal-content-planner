-- Validate nested references and original batch manifests before accepting writes or backups.
create or replace function public.planner_validate(p_kind text,p_data jsonb) returns void language plpgsql set search_path='' as $$
declare k text; allowed text[]; a text; b text; entry jsonb;
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
        if (case when p_data->>'startPrecision'='date' then a::date else (a::timestamptz at time zone 'Asia/Shanghai')::date end)>(case when p_data->>'finishPrecision'='date' then b::date else (b::timestamptz at time zone 'Asia/Shanghai')::date end) then raise exception 'INVALID_TIME_ORDER'; end if;
      elsif a::timestamptz>b::timestamptz then raise exception 'INVALID_TIME_ORDER'; end if;
    end if;
    if p_data ? 'links' and jsonb_typeof(p_data->'links')<>'array' then raise exception 'INVALID_LINKS'; end if;
  end if;
  if p_kind='settings' and p_data->>'name'='websiteName' and (jsonb_typeof(p_data->'value') is distinct from 'string' or length(trim(p_data->>'value')) not between 1 and 50) then raise exception 'INVALID_TEXT'; end if;
  if p_kind='effort' and (coalesce(p_data->>'minutes','') !~ '^[0-9]+$' or (p_data->>'minutes')::bigint not between 1 and 5256000) then raise exception 'INVALID_EFFORT'; end if;

  if p_kind='item' and p_data ? 'links' then
    for entry in select value from jsonb_array_elements(p_data->'links') loop
      if jsonb_typeof(entry) is distinct from 'object' or jsonb_typeof(entry->'label') is distinct from 'string' then raise exception 'INVALID_LINKS'; end if;
      for k in select jsonb_object_keys(entry) loop
        if k not in ('label','url','path') or jsonb_typeof(entry->k) is distinct from 'string' then raise exception 'INVALID_LINKS'; end if;
      end loop;
    end loop;
  end if;
  if p_kind='item' and p_data ? 'related' then
    for entry in select value from jsonb_array_elements(p_data->'related') loop
      if jsonb_typeof(entry) is distinct from 'string' or (entry#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_RELATED_ITEM'; end if;
    end loop;
  end if;
  if p_kind='settings' and p_data->>'name' like 'baseline:%' then
    if (p_data->>'name'<>'baseline:plan' and p_data->>'name' !~ '^baseline:batch:[0-9a-f]{32}$') or jsonb_typeof(p_data->'value') is distinct from 'object' or jsonb_typeof(p_data->'value'->'members') is distinct from 'array' then raise exception 'INVALID_BASELINE'; end if;
    for entry in select value from jsonb_array_elements(p_data->'value'->'members') loop
      if jsonb_typeof(entry) is distinct from 'object' or jsonb_typeof(entry->'id') is distinct from 'string' or entry->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'INVALID_BASELINE'; end if;
      for k in select jsonb_object_keys(entry) loop
        if k not in ('id','platform','group','type') or jsonb_typeof(entry->k) not in ('string','null') then raise exception 'INVALID_BASELINE'; end if;
      end loop;
    end loop;
    if (select count(*)<>count(distinct (x->>'id')::uuid) from jsonb_array_elements(p_data->'value'->'members')x) then raise exception 'INVALID_BASELINE'; end if;
  end if;
end; $$;

-- UUID spelling is case-insensitive in Postgres. Reject duplicate identities before insertion.
do $migration$
declare definition text;
begin
  select pg_get_functiondef('public.planner_execute(uuid,uuid,text,jsonb,bigint)'::regprocedure) into definition;
  if strpos(definition,$old$count(distinct x->>'id')$old$)=0 then raise exception 'Unexpected duplicate-ID check'; end if;
  definition:=replace(definition,$old$count(distinct x->>'id')$old$,$new$count(distinct (x->>'id')::uuid)$new$);
  definition:=replace(definition,$old$perform public.planner_validate(entry->>'kind',entry->'data');$old$,$new$perform public.planner_validate(entry->>'kind',entry->'data');
      if entry ? 'revision' and (jsonb_typeof(entry->'revision') is distinct from 'number' or (entry->>'revision') !~ '^[1-9][0-9]*$') then raise exception 'INVALID_MANIFEST'; end if;$new$);
  execute definition;
end;
$migration$;
update public.planner_control set generation=gen_random_uuid(),revision=revision+1,daily_day=null where singleton=true;
notify pgrst,'reload schema';
