-- Every indexed column, and what its index can answer. Feeds task/term/view-catalog-derive.ts.
--
--   psql "$DATABASE_URL" -At -F$'\t' -f task/term/view-catalog-derive.sql > index.tsv
--
-- Read-only. Six columns, in the order the script reads them: form, site, kind, sort, bond, like.
SELECT
  t.relname                                   AS form,
  a.attname                                   AS site,
  am.amname                                   AS kind,
  (am.amname = 'btree')                       AS sort,
  EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = t.oid
      AND c.contype = 'f'
      AND a.attnum = ANY (c.conkey)
  )                                           AS bond,
  (am.amname IN ('gin', 'gist')
    OR o.opcname LIKE '%pattern_ops')         AS "like"
FROM pg_index i
JOIN pg_class t   ON t.oid = i.indrelid
JOIN pg_class ix  ON ix.oid = i.indexrelid
JOIN pg_am am     ON am.oid = ix.relam
JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
LEFT JOIN LATERAL unnest(i.indclass) WITH ORDINALITY AS c(oid, ord) ON c.ord = k.ord
LEFT JOIN pg_opclass o ON o.oid = c.oid
WHERE n.nspname = 'public'
  AND a.attnum > 0
  AND NOT a.attisdropped
ORDER BY t.relname, a.attname;
