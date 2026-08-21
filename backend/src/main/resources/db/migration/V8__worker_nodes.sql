-- Worker nodes for cluster scheduling. Agents may move because JuiceFS holds /work.

CREATE TABLE worker_nodes (
  id text PRIMARY KEY,
  hostname text NOT NULL,
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline')),
  running_agents integer NOT NULL DEFAULT 0,
  juicefs_ok boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agents
  ADD COLUMN node_id text REFERENCES worker_nodes (id);
