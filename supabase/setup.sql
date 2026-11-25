-- ============================================================================
-- Varroa-Kalibrierung: Einrichtung der Supabase-Datenbank
-- Einmal komplett im SQL-Editor des Supabase-Projekts ausführen.
-- Vorher in Zeile 20-21 die beiden Codes ändern!
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Zugangscodes (nur über die Funktion join_project lesbar, nie direkt)
-- ---------------------------------------------------------------------------
create table if not exists public.app_config (
  id int primary key default 1 check (id = 1),
  invite_code text not null,
  admin_code text not null
);
alter table public.app_config enable row level security;

insert into public.app_config (id, invite_code, admin_code)
values (1, 'HIER-EINLADUNGSCODE', 'HIER-ADMINCODE')
on conflict (id) do update set invite_code = excluded.invite_code, admin_code = excluded.admin_code;

-- ---------------------------------------------------------------------------
-- Mitglieder (anonyme Anmeldung + Kürzel, kein Nutzerkonto mit E-Mail)
-- ---------------------------------------------------------------------------
create table if not exists public.members (
  id uuid primary key references auth.users(id) on delete cascade,
  kuerzel text not null check (char_length(kuerzel) between 1 and 20),
  role text not null default 'member' check (role in ('admin', 'member')),
  joined_at timestamptz not null default now()
);
alter table public.members enable row level security;

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where id = auth.uid());
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.members where id = auth.uid() and role = 'admin');
$$;

create or replace function public.join_project(p_code text, p_kuerzel text) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_role text;
  v_cfg public.app_config%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;
  select * into v_cfg from public.app_config where id = 1;
  if not found then
    raise exception 'Projekt ist noch nicht eingerichtet';
  end if;
  if p_code = v_cfg.admin_code then
    v_role := 'admin';
  elsif p_code = v_cfg.invite_code then
    v_role := 'member';
  else
    raise exception 'Falscher Einladungscode';
  end if;
  insert into public.members (id, kuerzel, role)
  values (auth.uid(), trim(p_kuerzel), v_role)
  on conflict (id) do update
    set kuerzel = excluded.kuerzel,
        role = case when public.members.role = 'admin' then 'admin' else excluded.role end;
  return (select role from public.members where id = auth.uid());
end $$;

revoke all on function public.join_project(text, text) from public;
grant execute on function public.join_project(text, text) to authenticated;

drop policy if exists members_select on public.members;
create policy members_select on public.members
  for select to authenticated using (public.is_member());

-- ---------------------------------------------------------------------------
-- Windelfotos mit Kandidaten und Prüfergebnissen
-- ---------------------------------------------------------------------------
create table if not exists public.images (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid() references public.members(id),
  updated_at timestamptz not null default now(),
  file_name text,
  file_path text not null,
  thumb_path text,
  width int not null,
  height int not null,
  taken_at timestamptz,
  device text,
  colony text,
  site text,
  inserted_at timestamptz,
  removed_at timestamptz,
  windel_w_mm numeric,
  windel_l_mm numeric,
  width_dir text check (width_dir in ('senkrecht', 'waagrecht')),
  roi jsonb,
  px_per_mm numeric not null,
  scale_source text,
  split text not null default 'train' check (split in ('train', 'test')),
  status text not null default 'neu' check (status in ('neu', 'geprueft', 'bestaetigt')),
  reviewed_by uuid references public.members(id),
  confirmed_by uuid references public.members(id),
  n_candidates int,
  n_mites int,
  candidates jsonb,
  annotations jsonb,
  note text
);
-- Für bereits eingerichtete Datenbanken (ältere Version mit cm-Spalten)
alter table public.images add column if not exists windel_w_mm numeric;
alter table public.images add column if not exists windel_l_mm numeric;
alter table public.images add column if not exists width_dir text check (width_dir in ('senkrecht', 'waagrecht'));
alter table public.images add column if not exists scale_ref jsonb;
create index if not exists images_status_idx on public.images (status);
alter table public.images enable row level security;

drop policy if exists images_select on public.images;
drop policy if exists images_insert on public.images;
drop policy if exists images_update on public.images;
drop policy if exists images_delete on public.images;
create policy images_select on public.images for select to authenticated using (public.is_member());
create policy images_insert on public.images for insert to authenticated
  with check (public.is_member() and created_by = auth.uid());
create policy images_update on public.images for update to authenticated
  using (public.is_member()) with check (public.is_member());
create policy images_delete on public.images for delete to authenticated using (public.is_admin());

-- Regeln für Prüfungen, serverseitig erzwungen
create or replace function public.images_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if new.status <> 'neu' then
      raise exception 'Neue Bilder müssen den Status neu haben';
    end if;
    return new;
  end if;
  if new.status = 'neu' and old.status <> 'neu' and not public.is_admin() then
    raise exception 'Nur Admins dürfen Bilder zurücksetzen';
  end if;
  if new.status = 'bestaetigt' and old.status <> 'bestaetigt' then
    if new.reviewed_by is distinct from auth.uid() then
      raise exception 'reviewed_by muss die eigene Kennung sein';
    end if;
  end if;
  if old.status = 'bestaetigt' and new.status = 'bestaetigt'
     and new.annotations is distinct from old.annotations
     and not public.is_admin() and old.reviewed_by is distinct from auth.uid() then
    raise exception 'Geprüfte Bilder kann nur die prüfende Person oder ein Admin ändern';
  end if;
  return new;
end $$;

drop trigger if exists images_guard on public.images;
create trigger images_guard before insert or update on public.images
  for each row execute function public.images_guard();

-- ---------------------------------------------------------------------------
-- Modellversionen (jede automatische Neuberechnung = neue Version)
-- ---------------------------------------------------------------------------
create table if not exists public.model_versions (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references public.members(id),
  gen text not null,
  model jsonb not null,
  n_images int,
  n_pos int,
  n_neg int,
  train_ids jsonb,
  note text
);
alter table public.model_versions enable row level security;
drop policy if exists models_select on public.model_versions;
drop policy if exists models_insert on public.model_versions;
drop policy if exists models_delete on public.model_versions;
create policy models_select on public.model_versions for select to authenticated using (public.is_member());
create policy models_insert on public.model_versions for insert to authenticated with check (public.is_member());
create policy models_delete on public.model_versions for delete to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------------
-- Speicher für die Fotos (privat, nur für Mitglieder)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('windeln', 'windeln', false)
on conflict (id) do nothing;

drop policy if exists windeln_select on storage.objects;
drop policy if exists windeln_insert on storage.objects;
drop policy if exists windeln_delete on storage.objects;
create policy windeln_select on storage.objects for select to authenticated
  using (bucket_id = 'windeln' and public.is_member());
create policy windeln_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'windeln' and public.is_member());
create policy windeln_delete on storage.objects for delete to authenticated
  using (bucket_id = 'windeln' and public.is_admin());

-- ---------------------------------------------------------------------------
-- Zugriffsrechte für angemeldete Nutzer (neuere Supabase-Projekte vergeben
-- diese nicht mehr automatisch). Was jemand sehen darf, regeln weiterhin die
-- Policies oben.
-- ---------------------------------------------------------------------------
grant usage on schema public to authenticated;
grant select on public.members to authenticated;
grant select, insert, update, delete on public.images to authenticated;
grant select, insert, delete on public.model_versions to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on function public.join_project(text, text), public.is_member(), public.is_admin() to authenticated;
