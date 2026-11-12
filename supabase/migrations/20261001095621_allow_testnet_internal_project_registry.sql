alter table public.projects
  drop constraint if exists projects_project_type_check;

alter table public.projects
  add constraint projects_project_type_check
  check (project_type = any (array['core'::text,'internal'::text,'external'::text]));
