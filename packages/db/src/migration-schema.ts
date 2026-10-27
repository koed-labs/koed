import { createHash } from "node:crypto";
import type pg from "pg";

type SchemaReader = Pick<pg.PoolClient, "query">;

/** Read on a transaction-held connection so catalog definitions use one search path. */
export const readMigrationSchema = async (client: SchemaReader) => {
  await client.query("set local search_path = public, pg_catalog");
  const queries = {
    columns: `select c.relname as table_name, a.attname as column_name,
        format_type(a.atttypid,a.atttypmod) as type, a.attnotnull as not_null,
        a.attidentity as identity, a.attgenerated as generated,
        coalesce(pg_get_expr(d.adbin,d.adrelid), '') as default_expression
      from pg_attribute a join pg_class c on c.oid=a.attrelid
      join pg_namespace n on n.oid=c.relnamespace
      left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum
      where n.nspname='public' and c.relkind in ('r','p','v','m') and a.attnum>0 and not a.attisdropped
        and not exists(select 1 from pg_depend dep where dep.classid='pg_class'::regclass and dep.objid=c.oid and dep.deptype='e')
      order by c.relname,a.attname`,
    constraints: `select relation.relname as table_name,c.conname,c.contype,pg_get_constraintdef(c.oid,true) as definition
      from pg_constraint c join pg_namespace n on n.oid=c.connamespace
      left join pg_class relation on relation.oid=c.conrelid
      where n.nspname='public' order by relation.relname,c.conname`,
    indexes: `select tablename,indexname,indexdef from pg_indexes
      where schemaname='public' order by tablename,indexname`,
    triggers: `select c.relname as table_name,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid,true) as definition
      from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and not t.tgisinternal order by c.relname,t.tgname`,
    enums: `select t.typname,row_number() over(partition by t.typname order by e.enumsortorder)::int as position,e.enumlabel
      from pg_type t join pg_enum e on e.enumtypid=t.oid join pg_namespace n on n.oid=t.typnamespace
      where n.nspname='public' order by t.typname,e.enumsortorder`,
    functions: `select p.proname as function_name,pg_get_function_identity_arguments(p.oid) as arguments,pg_get_functiondef(p.oid) as definition
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.prokind in ('f','p')
        and not exists(select 1 from pg_depend d where d.classid='pg_proc'::regclass and d.objid=p.oid and d.deptype='e')
      order by p.proname,pg_get_function_identity_arguments(p.oid)`,
    views: `select c.relname as view_name,c.relkind,pg_get_viewdef(c.oid,true) as definition,coalesce(c.reloptions,array[]::text[]) as options
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('v','m')
        and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
      order by c.relname`,
    relations: `select c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity,c.relreplident,c.relpersistence,coalesce(c.reloptions,array[]::text[]) as options
      from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relkind in ('r','p','v','m')
        and not exists(select 1 from pg_depend d where d.classid='pg_class'::regclass and d.objid=c.oid and d.deptype='e')
      order by c.relname`,
    policies: `select tablename,policyname,permissive,roles,cmd,qual,with_check
      from pg_policies where schemaname='public' order by tablename,policyname`
  };
  const schema: Record<string, pg.QueryResultRow[]> = {};
  for (const [name, query] of Object.entries(queries))
    schema[name] = (await client.query<pg.QueryResultRow>(query)).rows;
  return schema;
};

export const migrationSchemaFingerprint = async (client: SchemaReader) =>
  createHash("sha256")
    .update(JSON.stringify(await readMigrationSchema(client)))
    .digest("hex");
