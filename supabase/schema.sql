-- ============================================================================
-- MoveMint — Supabase schema, security (RLS) and storage
-- ============================================================================
-- Run this ONCE in your MoveMint Supabase project:
--   Supabase Dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- It is idempotent: safe to re-run. It creates the 10 tables the portal
-- reads/writes (movemint-portal.html), a profiles row auto-created on signup,
-- helper functions, Row Level Security policies, and a private Storage bucket
-- for documents.
--
-- Column names match the app EXACTLY (snake_case) so the portal works with no
-- code changes once you paste your project URL + anon key into the portal.
--
-- Roles live in profiles.role: 'admin' | 'staff' | 'client'
--   admin  -> full access (incl. Users & Access, Financial, Reports)
--   staff  -> operational read access + directory/desk work, no shipment writes
--   client -> read-only, scoped to their own customer_id; sees only docs flagged visible
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Tables  (column names == what shipToRow / persist* / rowTo* expect)
-- ----------------------------------------------------------------------------

-- Customers / Clients (PK is the app's string id, e.g. 'c1')
create table if not exists public.customers (
  id        text primary key,
  name      text,
  type      text,                       -- 'Company' | 'Individual'
  email     text,
  phone     text,
  country   text,
  zoho      text,                       -- Zoho Books customer ref
  portal    boolean not null default false,
  active    integer,                    -- open-shipment count (display)
  delivered integer,                    -- delivered count (display)
  last      text                        -- last activity date 'YYYY-MM-DD'
);

-- Suppliers / Partners
create table if not exists public.suppliers (
  id      text primary key,
  name    text,
  type    text,
  country text,
  contact text,
  email   text,
  phone   text,
  rating  numeric,
  on_time integer
);

-- Couriers
create table if not exists public.couriers (
  id       text primary key,
  name     text,
  mode     text,
  coverage text,
  active   boolean not null default true
);

-- Shipments (PK is the tracking number, e.g. 'MM-2026-0001')
create table if not exists public.shipments (
  tracking       text primary key,
  customer       text,                  -- customers.id
  customer_name  text,
  type           text,                  -- Incoterm
  mode           text,
  service        text,
  supplier       text,                  -- suppliers.id
  origin         jsonb default '{}'::jsonb,
  destination    jsonb default '{}'::jsonb,
  packages       integer,
  weight         text,                  -- display string e.g. '62 kg'
  cbm            numeric default 0,
  dims           text,
  value          text,                  -- display string e.g. '$2,450'
  costs          jsonb default '{}'::jsonb,  -- {freight,customs,warehouse,transport,taxes}
  selling_price  numeric default 0,
  fragile        boolean default false,
  customs        boolean default false,
  status         text,
  eta            date,
  staff          text,
  courier        text,                  -- free-text courier name
  zoho_cust_ref  text,
  zoho_inv       text,
  payment        text,
  inv_link       text,
  notes_customer text,
  notes_internal text,
  documents      jsonb default '[]'::jsonb,
  base           text,                  -- ISO datetime seed for timeline
  updated_at     timestamptz not null default now()
);

-- Quotations (PK 'QT-2026-0001')
create table if not exists public.quotations (
  id            text primary key,
  customer      text,
  client_name   text,
  origin        text,
  destination   text,
  mode          text,
  incoterm      text,
  cbm           numeric default 0,
  weight        text,
  freight_cost  numeric default 0,
  selling_price numeric default 0,
  status        text,
  date          date,
  valid_until   text,                   -- may be '' (empty) when not yet priced
  requested     boolean default false,
  shipment      text
);

-- Invoices (synced from Zoho Books; PK 'INV-002218')
create table if not exists public.invoices (
  id          text primary key,
  customer    text,
  client_name text,
  shipment    text,
  amount      numeric default 0,
  currency    text default 'USD',
  status      text,
  issue_date  date,
  due_date    date,
  paid_date   date,
  link        text,
  history     jsonb default '[]'::jsonb -- [{date,amount,method}]
);

-- Documents (storage_path links to the Storage object; PK 'd1')
create table if not exists public.documents (
  id           text primary key,
  name         text,
  shipment     text,                    -- shipments.tracking
  type         text,
  uploaded_by  text,
  date         text,                    -- 'YYYY-MM-DD'
  visible      boolean not null default false,  -- visible to the customer
  storage_path text                     -- path in the 'documents' Storage bucket
);

-- Exceptions (operational issues; read raw by the app, so column names == app fields)
create table if not exists public.exceptions (
  id       text primary key,
  shipment text,
  customer text,                        -- customer display name
  type     text,
  severity text,                        -- 'High' | 'Medium' | 'Low'
  owner    text,
  opened   text,                        -- 'YYYY-MM-DD'
  last     text,                        -- 'YYYY-MM-DD'
  status   text                         -- 'Open' | 'In Progress' | 'Resolved'
);

-- Notifications
create table if not exists public.notifications (
  id       text primary key,
  type     text,                        -- status | quote | invoice | document | exception
  customer text,                        -- customers.id (nullable = org-wide)
  title    text,
  message  text,
  channel  text,                        -- 'Email' | 'Portal'
  date     text,                        -- ISO datetime string
  read     boolean not null default false
);

-- Zoho Books OAuth connection metadata. Tokens are encrypted by the server
-- before storage and are never readable from browser-side Supabase clients.
create table if not exists public.zoho_connections (
  id                      text primary key default 'default',
  organization_id         text,
  organization_name       text,
  data_center             text default 'com',
  accounts_url            text,
  api_base_url            text,
  refresh_token_encrypted text,
  refresh_token_iv        text,
  refresh_token_tag       text,
  connected_by            uuid,
  connected_at            timestamptz,
  updated_at              timestamptz not null default now(),
  last_sync_at            timestamptz,
  last_sync_status        text,
  last_sync_error         text
);

-- Profiles (1:1 with auth.users; drives role + per-customer scoping)
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  name        text,
  role        text not null default 'client' check (role in ('admin','staff','client')),
  avatar      text,
  active      boolean not null default true,
  customer_id text,                     -- customers.id for client users (null for staff/admin)
  phone       text,
  created_at  timestamptz not null default now()
);

-- Backfill columns if an older version of a table already existed -----------
alter table public.documents add column if not exists storage_path text;
alter table public.customers add column if not exists active integer;
alter table public.customers add column if not exists delivered integer;

-- Helpful indexes for the per-customer scoping ------------------------------
create index if not exists idx_shipments_customer     on public.shipments(customer);
create index if not exists idx_invoices_customer      on public.invoices(customer);
create index if not exists idx_quotations_customer    on public.quotations(customer);
create index if not exists idx_notifications_customer on public.notifications(customer);
create index if not exists idx_documents_shipment     on public.documents(shipment);

-- ----------------------------------------------------------------------------
-- 2. Helper functions
--    SECURITY DEFINER means these run as the function OWNER (the table owner),
--    so reading public.profiles bypasses its RLS -> no infinite recursion in the
--    profiles policies. This relies on profiles NOT having FORCE ROW LEVEL
--    SECURITY enabled (it isn't) and these functions staying owned by the table
--    owner. Do NOT `alter table public.profiles force row level security` or the
--    profiles_select policy will recurse (error 42P17).
--    All three gate on profiles.active, so deactivating a user immediately
--    revokes data access at the database layer (not just in the UI).
-- ----------------------------------------------------------------------------
create or replace function public.app_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() and active = true;
$$;

create or replace function public.app_customer_id()
returns text language sql stable security definer set search_path = public as $$
  select customer_id from public.profiles where id = auth.uid() and active = true;
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select active and role in ('admin','staff') from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select active and role = 'admin' from public.profiles where id = auth.uid()), false);
$$;

create or replace function public.is_service_role()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce(current_setting('request.jwt.claim.role', true) = 'service_role', false) or auth.uid() is null;
$$;

-- Column-level write guards for client-facing tables. WITH CHECK on a policy
-- cannot see OLD, so these BEFORE triggers enforce what clients may change.
-- Staff/admin (and the SECURITY DEFINER seeder run as them) pass through.

-- Clients may only REQUEST a quote (status 'Requested', no pricing) and later
-- ACCEPT/REJECT their own quote. They can never set their own pricing/fields.
create or replace function public.quotations_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_service_role() or public.is_staff() then return new; end if;
  if tg_op = 'INSERT' then
    if new.customer is distinct from public.app_customer_id() then
      raise exception 'quotations: not permitted';
    end if;
    new.status := 'Requested';
    new.requested := true;
    new.freight_cost := 0;
    new.selling_price := 0;
    return new;
  elsif tg_op = 'UPDATE' then
    if old.customer is distinct from public.app_customer_id() then
      raise exception 'quotations: not permitted';
    end if;
    if new.status not in ('Accepted','Rejected') then
      new.status := old.status;
    end if;
    -- freeze every other column to its prior value
    new.id := old.id; new.customer := old.customer; new.client_name := old.client_name;
    new.origin := old.origin; new.destination := old.destination; new.mode := old.mode;
    new.incoterm := old.incoterm; new.cbm := old.cbm; new.weight := old.weight;
    new.freight_cost := old.freight_cost; new.selling_price := old.selling_price;
    new.date := old.date; new.valid_until := old.valid_until;
    new.requested := old.requested; new.shipment := old.shipment;
    return new;
  end if;
  return new;
end;
$$;

-- Clients may only toggle the `read` flag on their own notifications.
create or replace function public.notifications_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.is_service_role() or public.is_staff() then return new; end if;
  if tg_op = 'UPDATE' then
    if old.customer is distinct from public.app_customer_id() then
      raise exception 'notifications: not permitted';
    end if;
    new.id := old.id; new.type := old.type; new.customer := old.customer;
    new.title := old.title; new.message := old.message;
    new.channel := old.channel; new.date := old.date;  -- only `read` may change
    return new;
  end if;
  return new;
end;
$$;

drop trigger if exists quotations_guard_trg on public.quotations;
create trigger quotations_guard_trg
  before insert or update on public.quotations
  for each row execute function public.quotations_guard();

drop trigger if exists notifications_guard_trg on public.notifications;
create trigger notifications_guard_trg
  before insert or update on public.notifications
  for each row execute function public.notifications_guard();

-- ----------------------------------------------------------------------------
-- 3. Auto-create a profile row whenever a new auth user signs up
--    (persistProfile in the app only UPDATEs, so the row must pre-exist).
--    role/name can be seeded from user metadata; default role = 'client'.
-- ----------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  begin
    insert into public.profiles (id, email, name, role, customer_id, active)
    values (
      new.id,
      new.email,
      coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)),
      coalesce(new.raw_user_meta_data->>'role', 'client'),
      nullif(new.raw_user_meta_data->>'customer_id', ''),
      true
    )
    on conflict (id) do nothing;
  exception when others then
    null;  -- never let a profile-insert problem abort the auth signup
  end;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- 4. Privileges — let the 'authenticated' role reach the tables; RLS (below)
--    is what actually scopes the rows. 'anon' (logged-out) gets nothing.
-- ----------------------------------------------------------------------------
-- Hard baseline: strip any stale anon/PUBLIC grants first (grants are additive,
-- so a re-run over pre-existing tables could otherwise leave anon access behind).
revoke all on all tables in schema public from anon, public;
alter default privileges in schema public revoke all on tables from anon, public;

grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;

-- ----------------------------------------------------------------------------
-- 5. Row Level Security
-- ----------------------------------------------------------------------------
alter table public.customers     enable row level security;
alter table public.suppliers     enable row level security;
alter table public.couriers      enable row level security;
alter table public.shipments     enable row level security;
alter table public.quotations    enable row level security;
alter table public.invoices      enable row level security;
alter table public.documents     enable row level security;
alter table public.exceptions    enable row level security;
alter table public.notifications enable row level security;
alter table public.zoho_connections enable row level security;
alter table public.profiles      enable row level security;

-- ---- SHIPMENTS -------------------------------------------------------------
drop policy if exists shipments_select on public.shipments;
create policy shipments_select on public.shipments for select
  using ( public.is_staff() or customer = public.app_customer_id() );
drop policy if exists shipments_write on public.shipments;
create policy shipments_write on public.shipments for all
  using ( public.is_admin() ) with check ( public.is_admin() );

-- ---- INVOICES --------------------------------------------------------------
drop policy if exists invoices_select on public.invoices;
create policy invoices_select on public.invoices for select
  using ( public.is_staff() or customer = public.app_customer_id() );
drop policy if exists invoices_write on public.invoices;
create policy invoices_write on public.invoices for all
  using ( public.is_staff() ) with check ( public.is_staff() );

-- ---- QUOTATIONS (clients may request + accept/reject their own) ------------
drop policy if exists quotations_select on public.quotations;
create policy quotations_select on public.quotations for select
  using ( public.is_staff() or customer = public.app_customer_id() );
drop policy if exists quotations_insert on public.quotations;
create policy quotations_insert on public.quotations for insert
  with check ( public.is_staff() or customer = public.app_customer_id() );
drop policy if exists quotations_update on public.quotations;
create policy quotations_update on public.quotations for update
  using ( public.is_staff() or customer = public.app_customer_id() )
  with check ( public.is_staff() or customer = public.app_customer_id() );
drop policy if exists quotations_delete on public.quotations;
create policy quotations_delete on public.quotations for delete
  using ( public.is_staff() );

-- ---- DOCUMENTS (clients see only visible docs for their own shipments) -----
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents for select
  using (
    public.is_staff()
    or ( visible = true and shipment in (
          select tracking from public.shipments where customer = public.app_customer_id() ) )
  );
drop policy if exists documents_write on public.documents;
create policy documents_write on public.documents for all
  using ( public.is_staff() ) with check ( public.is_staff() );

-- ---- NOTIFICATIONS (clients see + mark-read + create their own) ------------
drop policy if exists notifications_select on public.notifications;
create policy notifications_select on public.notifications for select
  using ( public.is_staff() or customer = public.app_customer_id() );
drop policy if exists notifications_insert on public.notifications;
create policy notifications_insert on public.notifications for insert
  with check ( public.is_staff() or customer = public.app_customer_id() );
drop policy if exists notifications_update on public.notifications;
create policy notifications_update on public.notifications for update
  using ( public.is_staff() or customer = public.app_customer_id() )
  with check ( public.is_staff() or customer = public.app_customer_id() );
drop policy if exists notifications_delete on public.notifications;
create policy notifications_delete on public.notifications for delete
  using ( public.is_staff() );

-- ---- CUSTOMERS (clients may read only their own record) --------------------
drop policy if exists customers_select on public.customers;
create policy customers_select on public.customers for select
  using ( public.is_staff() or id = public.app_customer_id() );
drop policy if exists customers_write on public.customers;
create policy customers_write on public.customers for all
  using ( public.is_staff() ) with check ( public.is_staff() );

-- ---- SUPPLIERS / COURIERS / EXCEPTIONS (internal: staff only) --------------
drop policy if exists suppliers_all on public.suppliers;
create policy suppliers_all on public.suppliers for all
  using ( public.is_staff() ) with check ( public.is_staff() );

drop policy if exists couriers_all on public.couriers;
create policy couriers_all on public.couriers for all
  using ( public.is_staff() ) with check ( public.is_staff() );

drop policy if exists exceptions_all on public.exceptions;
create policy exceptions_all on public.exceptions for all
  using ( public.is_staff() ) with check ( public.is_staff() );

-- ---- PROFILES (read own or any-if-staff; writes are admin-only) ------------
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select
  using ( id = auth.uid() or public.is_staff() );
drop policy if exists profiles_insert on public.profiles;
create policy profiles_insert on public.profiles for insert
  with check ( public.is_admin() );
drop policy if exists profiles_update on public.profiles;
create policy profiles_update on public.profiles for update
  using ( public.is_admin() ) with check ( public.is_admin() );
drop policy if exists profiles_delete on public.profiles;
create policy profiles_delete on public.profiles for delete
  using ( public.is_admin() );

-- ----------------------------------------------------------------------------
-- 6. Storage — private 'documents' bucket
--    Object path convention used by the portal: '<tracking>/<docId>-<filename>'
--    so the first path segment is the shipment, enabling per-customer reads.
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('documents', 'documents', false)
on conflict (id) do nothing;

drop policy if exists "documents staff all" on storage.objects;
create policy "documents staff all" on storage.objects for all
  using ( bucket_id = 'documents' and public.is_staff() )
  with check ( bucket_id = 'documents' and public.is_staff() );

drop policy if exists "documents client read" on storage.objects;
create policy "documents client read" on storage.objects for select
  using (
    bucket_id = 'documents'
    and exists (
      select 1
      from public.documents d
      join public.shipments s on s.tracking = d.shipment
      where d.storage_path = storage.objects.name
        and d.visible = true
        and s.customer = public.app_customer_id()
    )
  );

-- ============================================================================
-- Done. Next:
--   1. Create auth users (Authentication -> Users -> Add user, or invite).
--      The trigger creates each a 'client' profile automatically.
--   2. Promote your admin:  update public.profiles set role='admin'
--                           where email='admin@movemint.app';
--   3. For client logins, link them:  update public.profiles
--        set role='client', customer_id='c1' where email='client@cedarmart.lb';
--   4. Paste your Project URL + anon key into movemint-portal.html (SB_URL/SB_KEY).
--   5. Load sample data: sign in as admin -> Settings -> "Seed sample data to
--      Supabase" (added in the portal), which pushes the built-in demo records
--      through the app's own writers so they match perfectly.
-- ============================================================================
