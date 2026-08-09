PRAGMA foreign_keys = ON;

CREATE TABLE nodes (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT,
    normalized_name TEXT UNIQUE,
    content TEXT,
    CHECK (
        (name IS NULL AND normalized_name IS NULL)
        OR
        (name IS NOT NULL AND length(trim(name)) > 0 AND normalized_name IS NOT NULL)
    )
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
