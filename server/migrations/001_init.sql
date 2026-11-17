create table users (
  id text primary key,
  email text unique,
  name text not null,
  password_hash text,
  guest boolean not null default false,
  created_at timestamptz not null default now()
);

create table sessions (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index sessions_user on sessions(user_id);

create table sheets (
  id text primary key,
  owner_id text not null references users(id) on delete cascade,
  title text not null,
  link_access text not null default 'none' check (link_access in ('none', 'viewer', 'editor')),
  seq bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index sheets_owner on sheets(owner_id);

create table members (
  sheet_id text not null references sheets(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  role text not null check (role in ('editor', 'viewer')),
  primary key (sheet_id, user_id)
);

create index members_user on members(user_id);

create table opens (
  sheet_id text not null references sheets(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  opened_at timestamptz not null default now(),
  primary key (sheet_id, user_id)
);

create index opens_user on opens(user_id);

create table ops (
  sheet_id text not null references sheets(id) on delete cascade,
  seq bigint not null,
  client_id text not null,
  cseq integer not null,
  user_id text not null,
  op jsonb not null,
  created_at timestamptz not null default now(),
  primary key (sheet_id, seq)
);

create index ops_client on ops(sheet_id, client_id, cseq);

create table versions (
  id bigserial primary key,
  sheet_id text not null references sheets(id) on delete cascade,
  seq bigint not null,
  kind text not null,
  name text,
  state jsonb not null,
  editors text[] not null default '{}',
  created_by text,
  created_at timestamptz not null default now()
);

create index versions_sheet on versions(sheet_id, seq desc);
