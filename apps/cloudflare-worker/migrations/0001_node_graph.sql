PRAGMA foreign_keys = ON;

CREATE TABLE nodes (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    normalized_name TEXT NOT NULL UNIQUE,
    content TEXT
) STRICT;

CREATE TABLE node_references (
    source_node_id TEXT NOT NULL,
    target_node_id TEXT NOT NULL,
    PRIMARY KEY (source_node_id, target_node_id),
    FOREIGN KEY (source_node_id) REFERENCES nodes (id) ON DELETE RESTRICT,
    FOREIGN KEY (target_node_id) REFERENCES nodes (id) ON DELETE RESTRICT
) STRICT;

CREATE INDEX node_references_by_target
    ON node_references (target_node_id, source_node_id);
