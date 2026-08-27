-- Drop the homemade kross-node inventory. agents.node_id remains as the last Kubernetes node name.

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_node_id_fkey;
DROP TABLE IF EXISTS worker_nodes;
