-- Szkic schematu bazy (PostgreSQL). Wszystko jest przypisane do planu (plan_id = IR:PlanId z pliku IREDES)
-- i do otworu (plan_id + hole_id = IR:HoleId). Pliki MWD z tym samym PlanId/HoleId łączą się bez zgadywania.
-- Układ współrzędnych: kolejność N, E, H w metrach; crs zapisany przy planie.

create table organizations (
  org_id      uuid primary key default gen_random_uuid(),
  name        text not null
);

create table sites (
  site_id     uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations on delete cascade,
  name        text not null,
  crs         text not null default 'ETRF2000-PL / CS2000/21'
);

create table products (            -- baza materiałów wybuchowych (per organizacja)
  product_id  text primary key,
  org_id      uuid not null references organizations on delete cascade,
  name        text not null,
  kind        text not null check (kind in ('bulk', 'cartridge')),
  density_gcc numeric,             -- sypki / pompowany
  cart_dia_mm numeric, cart_len_mm numeric, cart_mass_kg numeric
);

-- PLAN: jedna wersja projektu strzału. Zmiana po wywierceniu = nowy plan_id.
create table plans (
  plan_id     text primary key,    -- IR:PlanId, np. '03dd336a4b75'
  site_id     uuid not null references sites on delete cascade,
  name        text not null,
  project     text,
  crs         text not null,
  bearing_deg numeric,
  parent_plan text references plans,   -- poprzednia wersja
  created_at  timestamptz not null default now(),
  created_by  uuid,
  status      text not null default 'draft' check (status in ('draft', 'issued', 'drilled', 'loaded', 'fired', 'closed')),
  design      jsonb not null       -- pełny projekt (typy, szablony, obrys) do ponownego otwarcia
);

create table holes (
  plan_id     text not null references plans on delete cascade,
  hole_id     integer not null,    -- IR:HoleId, stały, nigdy nie przenumerowywany
  name        text not null,       -- HoleName: '2.11' (rząd.kolejny numer)
  type        text not null default 'normal' check (type in ('normal', 'profile')),
  collar_n numeric not null, collar_e numeric not null, collar_h numeric not null,
  toe_n    numeric not null, toe_e    numeric not null, toe_h    numeric not null,
  diameter_mm numeric not null,
  target_h    numeric,             -- rzędna docelowa wyrobiska
  subdrill_m  numeric,
  stemming_m  numeric,
  design_charge jsonb,             -- segmenty: przybitka / ładunek (produkt, kg) / przekładka
  primary key (plan_id, hole_id)
);

-- WIERCENIE (logger wiertacza)
create table drilled (
  plan_id text not null, hole_id integer not null,
  event_id uuid not null default gen_random_uuid(),   -- nadawany na urządzeniu: synchronizacja idempotentna
  drilled_at timestamptz, rig text, driller text,
  depth_m numeric, water boolean, comment text,
  actual_collar_n numeric, actual_collar_e numeric, actual_collar_h numeric,
  primary key (plan_id, hole_id, event_id),
  foreign key (plan_id, hole_id) references holes on delete cascade
);

-- MWD: duże szeregi czasowe trzymaj w plikach (object storage), w bazie podsumowanie i odnośnik
create table mwd_files (
  mwd_id uuid primary key default gen_random_uuid(),
  plan_id text not null, hole_id integer not null,
  storage_path text not null, format text, rig text, recorded_at timestamptz,
  foreign key (plan_id, hole_id) references holes on delete cascade
);
create table mwd_summary (
  mwd_id uuid primary key references mwd_files on delete cascade,
  depth_m numeric, mean_rop numeric, mean_torque numeric, specific_energy numeric,
  voids jsonb                      -- wykryte pustki / strefy słabe: [{from, to}]
);

-- ŁADOWANIE (logger ładowania) - fakt na ścianie
create table loadings (
  plan_id text not null, hole_id integer not null,
  event_id uuid not null default gen_random_uuid(),
  loaded_at timestamptz, loader text, truck text,
  stemming_m numeric, comment text,
  primary key (plan_id, hole_id, event_id),
  foreign key (plan_id, hole_id) references holes on delete cascade
);
create table loading_segments (
  plan_id text not null, hole_id integer not null, event_id uuid not null,
  seq integer not null, kind text not null check (kind in ('charge', 'deck', 'stemming')),
  product_id text references products, from_m numeric, to_m numeric, mass_kg numeric,
  primary key (plan_id, hole_id, event_id, seq),
  foreign key (plan_id, hole_id, event_id) references loadings on delete cascade
);

-- SIEĆ STRZAŁOWA I OPÓŹNIENIA
create table network_links (
  plan_id text not null, from_hole integer, to_hole integer not null,  -- from_hole null = punkt inicjacji
  delay_ms integer not null, kind text not null check (kind in ('surface', 'start')),
  primary key (plan_id, to_hole),
  foreign key (plan_id, to_hole) references holes on delete cascade
);
create table hole_timing (
  plan_id text not null, hole_id integer not null,
  inhole_delay_ms integer not null, fire_time_ms integer not null,
  primary key (plan_id, hole_id),
  foreign key (plan_id, hole_id) references holes on delete cascade
);

-- WYNIKI STRZAŁU
create table blasts (
  plan_id text primary key references plans on delete cascade,
  fired_at timestamptz, comment text
);
create table vibration_records (
  record_id uuid primary key default gen_random_uuid(),
  plan_id text not null references blasts on delete cascade,
  sensor text, distance_m numeric, ppv_mm_s numeric, freq_hz numeric, storage_path text
);
create table fragmentation_results (
  result_id uuid primary key default gen_random_uuid(),
  plan_id text not null references blasts on delete cascade,
  p50_mm numeric, p80_mm numeric, oversize_pct numeric, storage_path text
);

-- Widok „projekt a fakt" (podstawa raportu odchyłek)
create view plan_vs_actual as
select h.plan_id, h.hole_id, h.name, h.diameter_mm,
       sqrt((h.collar_h - h.toe_h)^2 + (h.collar_n - h.toe_n)^2 + (h.collar_e - h.toe_e)^2) as design_length_m,
       d.depth_m as drilled_depth_m,
       (select sum(s.mass_kg) from loading_segments s where s.plan_id = h.plan_id and s.hole_id = h.hole_id and s.kind = 'charge') as loaded_kg
from holes h
left join lateral (select depth_m from drilled d where d.plan_id = h.plan_id and d.hole_id = h.hole_id order by drilled_at desc nulls last limit 1) d on true;

-- Dostęp: włącz Row Level Security na każdej tabeli, tak by użytkownik widział tylko plany swojej organizacji.
