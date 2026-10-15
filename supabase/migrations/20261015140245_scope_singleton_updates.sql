-- Keep safe-update protection enabled. Scope singleton control writes explicitly.
do $migration$
declare definition text; unscoped integer;
begin
  select pg_get_functiondef('public.planner_execute(uuid,uuid,text,jsonb,bigint)'::regprocedure) into definition;
  select count(*) into unscoped
    from regexp_matches(definition,'update public\.planner_control set [^;]+;','gi') as statement
    where statement[1] !~* '\mwhere\M';
  if unscoped <> 3 then
    raise exception 'Unexpected planner_execute definition: expected three unscoped control writes, found %', unscoped;
  end if;
  definition := regexp_replace(definition,
    '(update public\.planner_control set [^;]+);',
    '\1 where singleton = true and owner_id = auth.uid();','gi');
  execute definition;
end;
$migration$;

update public.planner_control
  set generation=gen_random_uuid(), revision=revision+1, daily_day=null
  where singleton=true;
notify pgrst,'reload schema';
