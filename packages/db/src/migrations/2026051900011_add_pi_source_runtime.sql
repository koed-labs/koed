do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_enum e on e.enumtypid = t.oid
    where t.typname = 'source_runtime'
      and e.enumlabel = 'pi'
  ) then
    alter type source_runtime add value 'pi';
  end if;
end
$$;
