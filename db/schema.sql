create table if not exists entity (
  entity_id bigserial primary key,
  name text not null unique,
  name_ar text,
  name_normalized text not null unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists company (
  company_id bigserial primary key,
  name text not null,
  name_raw text,
  name_normalized text not null unique,
  commercial_registration_number text,
  classification text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists tender (
  tender_id bigint primary key,
  tender_number text,
  title text,
  entity_id bigint references entity(entity_id),
  procurement_method text,
  category text,
  status text,
  estimated_value numeric(18,2),
  currency char(3) not null default 'QAR',
  published_date date,
  closing_date timestamptz,
  technical_open_date timestamptz,
  financial_open_date timestamptz,
  award_date date,
  awarded_value numeric(18,2),
  awarded_company_id bigint references company(company_id),
  source_url text,
  tender_detail_url text,
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  fetched_at timestamptz,
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists bid (
  bid_id bigserial primary key,
  tender_id bigint not null references tender(tender_id) on delete cascade,
  company_id bigint not null references company(company_id),
  bid_value numeric(18,2),
  approved_value numeric(18,2),
  currency char(3) not null default 'QAR',
  is_winner boolean not null default false,
  rank int,
  local_value_ratio numeric(8,2),
  financial_result numeric(18,2),
  notes text,
  source text not null check (source in ('awarded', 'opened')),
  raw jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tender_id, company_id, source)
);

create table if not exists raw_page (
  raw_id bigserial primary key,
  source_tender_id bigint references tender(tender_id) on delete cascade,
  page_type text not null,
  url text not null,
  http_status int,
  fetched_at timestamptz not null default now(),
  html_path text,
  raw_html_key text,
  content_hash text not null,
  content jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (source_tender_id, page_type, content_hash)
);

create table if not exists ingestion_run (
  run_id bigserial primary key,
  source text not null default 'apify',
  source_run_id text,
  source_dataset_id text,
  status text not null default 'running',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_seen int not null default 0,
  records_imported int not null default 0,
  records_failed int not null default 0,
  new_tenders int not null default 0,
  updated_tenders int not null default 0,
  validation_errors jsonb not null default '[]'::jsonb,
  summary jsonb not null default '{}'::jsonb
);

create index if not exists tender_tender_number_idx on tender (tender_number);
create index if not exists tender_award_date_idx on tender (award_date);
create index if not exists tender_awarded_value_idx on tender (awarded_value);
create index if not exists tender_method_idx on tender (procurement_method);
create index if not exists tender_entity_idx on tender (entity_id);
create index if not exists bid_winner_idx on bid (tender_id) where is_winner;
create index if not exists bid_company_tender_idx on bid (company_id, tender_id);
create index if not exists raw_page_hash_idx on raw_page (source_tender_id, page_type, content_hash);

create index if not exists tender_search_idx
  on tender using gin (
    to_tsvector('english', coalesce(tender_number, '') || ' ' || coalesce(title, '') || ' ' || coalesce(procurement_method, ''))
  );

create index if not exists entity_search_idx
  on entity using gin (to_tsvector('english', name));

create index if not exists company_search_idx
  on company using gin (to_tsvector('english', name));

create or replace view tenders as
select
  t.tender_id as id,
  t.tender_id,
  t.tender_number,
  t.title,
  e.name as entity,
  t.procurement_method,
  t.award_date,
  t.awarded_value as awarded_amount,
  t.currency as awarded_amount_currency,
  c.name as winning_company,
  t.source_url,
  t.tender_detail_url,
  t.raw,
  t.fetched_at,
  t.created_at,
  t.updated_at
from tender t
left join entity e on e.entity_id = t.entity_id
left join company c on c.company_id = t.awarded_company_id;

create or replace view tender_companies as
select
  b.bid_id as id,
  b.tender_id,
  c.name as company_name,
  c.commercial_registration_number,
  b.approved_value,
  b.bid_value as proposal_amount,
  b.local_value_ratio,
  b.financial_result,
  b.notes,
  b.is_winner,
  b.source,
  b.raw
from bid b
join company c on c.company_id = b.company_id;
