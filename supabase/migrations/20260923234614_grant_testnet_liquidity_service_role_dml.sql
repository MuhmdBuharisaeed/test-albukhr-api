grant select, insert, update, delete
on table public.projects
to service_role;

grant select, insert, update, delete
on table public.project_treasury
to service_role;

grant select, insert, update, delete
on table public.project_liquidity_payments
to service_role;

grant select, insert, update, delete
on table public.users
to service_role;

grant select, insert, update, delete
on table public.project_owner_withdrawals
to service_role;
