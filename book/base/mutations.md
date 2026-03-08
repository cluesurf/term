# Mutations

Database operations beyond `find` (SELECT). Covers schema creation,
alteration, data manipulation, permissions, and transactions.

## Naming Convention

Names in Seed use kebab-case. When emitting SQL, kebab-case is
automatically converted to snake_case. When reading from SQL,
snake_case is converted back to kebab-case.

```tree
name user-email-idx
```

Becomes `user_email_idx` in SQL. And `user_email_idx` from SQL becomes
`user-email-idx` in Seed.

If you need a name that does not follow this convention (underscores
in specific positions, mixed case, etc.), use a string literal:

```tree
name <user_email_idx>
```

String literal names are passed through to SQL unchanged.

## Create Table (`make table`)

```tree
make table, name user
  link id, like bigint
    mark primary
  link name, like text
  link email, like text
    mark unique
  link age, like integer
    hold is-minimum
      bind a, read self/age
      bind b, 0
  link role, like text
    base <user>
  link team-id, like bigint
    mark foreign
      base team, name id
  link created-at, like timestamp
    base call now
  link deleted-at, like timestamp
    need false
```

```sql
CREATE TABLE user (
  id BIGINT PRIMARY KEY,
  name TEXT,
  email TEXT UNIQUE,
  age INTEGER CHECK (age >= 0),
  role TEXT DEFAULT 'user',
  team_id BIGINT REFERENCES team(id),
  created_at TIMESTAMP DEFAULT now(),
  deleted_at TIMESTAMP
);
```

### Column Constraints

| Seed | SQL |
| --- | --- |
| `mark primary` | `PRIMARY KEY` |
| `mark unique` | `UNIQUE` |
| `mark foreign` + `base <table>, name <col>` | `REFERENCES table(col)` |
| `need true` | `NOT NULL` (default) |
| `need false` | nullable (no NOT NULL) |
| `base <value>` | `DEFAULT <value>` |
| `hold <predicate>` | `CHECK (...)` |

### Composite Primary Key

```tree
make table, name order-item
  link order-id, like bigint
  link product-id, like bigint
  link quantity, like integer
  mark primary
    name order-id
    name product-id
```

```sql
CREATE TABLE order_item (
  order_id BIGINT,
  product_id BIGINT,
  quantity INTEGER,
  PRIMARY KEY (order_id, product_id)
);
```

## Create Index (`make index`)

```tree
make index, name user-email-idx
  base user
    link email
```

```sql
CREATE INDEX user_email_idx ON user (email);
```

### Unique Index

```tree
make index, name user-email-unique-idx
  mark unique
  base user
    link email
```

```sql
CREATE UNIQUE INDEX user_email_unique_idx ON user (email);
```

### Composite Index

```tree
make index, name order-customer-date-idx
  base order
    link customer-id
    link created-at
```

```sql
CREATE INDEX order_customer_date_idx ON "order" (customer_id, created_at);
```

### Partial Index

```tree
make index, name active-user-email-idx
  base user
    link email
  hold is-equal
    bind a, read self/active
    bind b, term true
```

```sql
CREATE INDEX active_user_email_idx ON user (email)
WHERE active = true;
```

## Create View (`make view`)

```tree
make view, name active-users
  base user
  hold is-equal
    bind a, read self/active
    bind b, term true
```

```sql
CREATE VIEW active_users AS
SELECT * FROM user WHERE active = true;
```

### View with Joins and Aggregation

```tree
make view, name customer-summary
  base customer
  bond order
    hold is-equal
      bind a, read order/customer-id
      bind b, read customer/id
  send name, read customer/name
  send email, read customer/email
  send order-count
    call count
      bind a, read order/id
  send total-spent
    call sum
      bind a, read order/total
  fold customer/id
  fold customer/name
  fold customer/email
```

```sql
CREATE VIEW customer_summary AS
SELECT
  c.name,
  c.email,
  COUNT(o.id) AS order_count,
  SUM(o.total) AS total_spent
FROM customer c
JOIN "order" o ON o.customer_id = c.id
GROUP BY c.id, c.name, c.email;
```

## Create Materialized View (`make materialized-view`)

Materialized views store the query result on disk for fast reads.
Refresh manually.

```tree
make materialized-view, name order-totals
  base order
  send user-id
  send total-spent
    call sum
      bind a, read self/total
  send order-count
    call count
      bind a, read self/id
  fold user-id
```

```sql
CREATE MATERIALIZED VIEW order_totals AS
SELECT
  user_id,
  SUM(total) AS total_spent,
  COUNT(id) AS order_count
FROM "order"
GROUP BY user_id;
```

Refresh it:

```tree
call refresh
  bind view, term order-totals
```

```sql
REFRESH MATERIALIZED VIEW order_totals;
```

Refresh concurrently (requires a unique index):

```tree
call refresh
  bind view, term order-totals
  mark concurrent
```

```sql
REFRESH MATERIALIZED VIEW CONCURRENTLY order_totals;
```

## Create Sequence (`make sequence`)

```tree
make sequence, name user-id-seq
```

```sql
CREATE SEQUENCE user_id_seq;
```

With options:

```tree
make sequence, name invoice-number-seq
  bind start, 1000
  bind step, 1
  bind min, 1000
  bind max, 9999999
  bind cycle, term true
```

```sql
CREATE SEQUENCE invoice_number_seq
START WITH 1000
INCREMENT BY 1
MINVALUE 1000
MAXVALUE 9999999
CYCLE;
```

## Create Enum Type (`make enum`)

```tree
make enum, name user-status
  term active
  term inactive
  term suspended
  term deleted
```

```sql
CREATE TYPE user_status AS ENUM (
  'active', 'inactive', 'suspended', 'deleted'
);
```

## Create Function (`make function`)

```tree
make function, name calculate-tax
  take amount, like number
  like number
  send back
    call multiply
      bind a, read amount
      bind b, 0.2
```

```sql
CREATE FUNCTION calculate_tax(amount numeric)
RETURNS numeric
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN amount * 0.2;
END;
$$;
```

### Function with Multiple Params

```tree
make function, name apply-discount
  take price, like number
  take rate, like number
  take min-price, like number
  like number
  save discounted
    call multiply
      bind a, read price
      bind b
        call subtract
          bind a, 1
          bind b, read rate
  send back
    call greatest
      bind a, read discounted
      bind b, read min-price
```

```sql
CREATE FUNCTION apply_discount(
  price numeric,
  rate numeric,
  min_price numeric
)
RETURNS numeric
LANGUAGE plpgsql
AS $$
DECLARE
  discounted numeric;
BEGIN
  discounted := price * (1 - rate);
  RETURN GREATEST(discounted, min_price);
END;
$$;
```

## Create Trigger (`make trigger`)

```tree
make trigger, name update-timestamp
  base user
  hook before-update
    call set-updated-at
```

```sql
CREATE TRIGGER update_timestamp
BEFORE UPDATE ON user
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
```

### Trigger Hooks

| Seed | SQL |
| --- | --- |
| `hook before-insert` | `BEFORE INSERT` |
| `hook after-insert` | `AFTER INSERT` |
| `hook before-update` | `BEFORE UPDATE` |
| `hook after-update` | `AFTER UPDATE` |
| `hook before-delete` | `BEFORE DELETE` |
| `hook after-delete` | `AFTER DELETE` |

### Conditional Trigger

Only fire when specific columns change:

```tree
make trigger, name audit-email-change
  hook after-update
    base user
      link email
    call log-email-change
```

```sql
CREATE TRIGGER audit_email_change
AFTER UPDATE OF email ON user
FOR EACH ROW
EXECUTE FUNCTION log_email_change();
```

### Trigger with Condition

```tree
make trigger, name notify-large-order
  hook after-insert, base order
    hold is-above
      bind a, read self/total
      bind b, 1000
    call send-large-order-alert
```

```sql
CREATE TRIGGER notify_large_order
AFTER INSERT ON "order"
FOR EACH ROW
WHEN (NEW.total > 1000)
EXECUTE FUNCTION send_large_order_alert();
```

## Alter Table (`mold table`)

### Add Column

```tree
mold table, name user
  make column, name age
    like integer
```

```sql
ALTER TABLE user ADD COLUMN age INTEGER;
```

Add with default and not null:

```tree
mold table, name user
  make column, name active
    like boolean
    base true
    need true
```

```sql
ALTER TABLE user ADD COLUMN active BOOLEAN NOT NULL DEFAULT true;
```

### Drop Column

```tree
mold table, name user
  toss column, name age
```

```sql
ALTER TABLE user DROP COLUMN age;
```

### Rename Column

```tree
mold table, name user
  mold column, name name
    bind name, term full-name
```

```sql
ALTER TABLE user RENAME COLUMN name TO full_name;
```

### Change Column Type

```tree
mold table, name user
  mold column, name age
    bind like, term bigint
```

```sql
ALTER TABLE user ALTER COLUMN age TYPE BIGINT;
```

### Set Default

```tree
mold table, name user
  mold column, name created-at
    bind base, call now
```

```sql
ALTER TABLE user ALTER COLUMN created_at SET DEFAULT now();
```

### Drop Default

```tree
mold table, name user
  mold column, name created-at
    toss base
```

```sql
ALTER TABLE user ALTER COLUMN created_at DROP DEFAULT;
```

### Set NOT NULL

```tree
mold table, name user
  mold column, name email
    need true
```

```sql
ALTER TABLE user ALTER COLUMN email SET NOT NULL;
```

### Drop NOT NULL

```tree
mold table, name user
  mold column, name email
    need false
```

```sql
ALTER TABLE user ALTER COLUMN email DROP NOT NULL;
```

### Add Constraint: Primary Key

```tree
mold table, name user
  make constraint, name user-pk
    mark primary
      name id
```

```sql
ALTER TABLE user ADD CONSTRAINT user_pk PRIMARY KEY (id);
```

### Add Constraint: Foreign Key

```tree
mold table, name order
  make constraint, name order-user-fk
    mark foreign
      name user-id
      base user, name id
```

```sql
ALTER TABLE "order"
ADD CONSTRAINT order_user_fk
FOREIGN KEY (user_id) REFERENCES user(id);
```

Foreign key with cascade:

```tree
mold table, name order
  make constraint, name order-user-fk
    mark foreign
      name user-id
      base user, name id
      hook delete, term cascade
      hook update, term cascade
```

```sql
ALTER TABLE "order"
ADD CONSTRAINT order_user_fk
FOREIGN KEY (user_id) REFERENCES user(id)
ON DELETE CASCADE ON UPDATE CASCADE;
```

### Add Constraint: Unique

```tree
mold table, name user
  make constraint, name user-email-unique
    mark unique
      name email
```

```sql
ALTER TABLE user ADD CONSTRAINT user_email_unique UNIQUE (email);
```

Composite unique:

```tree
mold table, name team-member
  make constraint, name one-role-per-team
    mark unique
      name team-id
      name user-id
```

```sql
ALTER TABLE team_member
ADD CONSTRAINT one_role_per_team UNIQUE (team_id, user_id);
```

### Add Constraint: Check

```tree
mold table, name user
  make constraint, name age-check
    hold is-minimum
      bind a, read self/age
      bind b, 0
```

```sql
ALTER TABLE user ADD CONSTRAINT age_check CHECK (age >= 0);
```

Complex check:

```tree
mold table, name event
  make constraint, name valid-date-range
    hold is-below
      bind a, read self/start-date
      bind b, read self/end-date
```

```sql
ALTER TABLE event
ADD CONSTRAINT valid_date_range CHECK (start_date < end_date);
```

### Drop Constraint

```tree
mold table, name user
  toss constraint, name age-check
```

```sql
ALTER TABLE user DROP CONSTRAINT age_check;
```

### Rename Table

```tree
mold table, name user
  bind name, term account
```

```sql
ALTER TABLE user RENAME TO account;
```

### Set Owner

```tree
mold table, name user
  bind owner, term admin
```

```sql
ALTER TABLE user OWNER TO admin;
```

## Drop (`toss`)

### Drop Table

```tree
toss table, name user
```

```sql
DROP TABLE user;
```

With cascade (drops dependent objects):

```tree
toss table, name user
  mark cascade
```

```sql
DROP TABLE user CASCADE;
```

If exists:

```tree
toss table, name user
  mark safe
```

```sql
DROP TABLE IF EXISTS user;
```

### Drop Index

```tree
toss index, name user-email-idx
```

```sql
DROP INDEX user_email_idx;
```

### Drop View

```tree
toss view, name active-users
```

```sql
DROP VIEW active_users;
```

### Drop Sequence

```tree
toss sequence, name user-id-seq
```

```sql
DROP SEQUENCE user_id_seq;
```

### Drop Function

```tree
toss function, name calculate-tax
```

```sql
DROP FUNCTION calculate_tax;
```

### Drop Trigger

```tree
toss trigger, name update-timestamp
  base user
```

```sql
DROP TRIGGER update_timestamp ON user;
```

### Drop Enum

```tree
toss enum, name user-status
```

```sql
DROP TYPE user_status;
```

## Insert (`save row`)

### Single Row

```tree
save row, base user
  make user
    bind name, <Alice>
    bind email, <alice@example.com>
```

```sql
INSERT INTO user (name, email)
VALUES ('Alice', 'alice@example.com');
```

### Multiple Rows

```tree
save row, base role
  make role
    bind name, <admin>
  make role
    bind name, <user>
  make role
    bind name, <guest>
```

```sql
INSERT INTO role (name) VALUES ('admin'), ('user'), ('guest');
```

### Insert with Returning

```tree
save row, base user
  make user
    bind name, <Alice>
    bind email, <alice@example.com>
  send id
  send created-at
```

```sql
INSERT INTO user (name, email)
VALUES ('Alice', 'alice@example.com')
RETURNING id, created_at;
```

### Insert from Select

```tree
save row, base archive-order
  find old-orders
    base order
    hold is-below
      bind a, read self/created-at
      bind b, read cutoff
```

```sql
INSERT INTO archive_order
SELECT * FROM "order" WHERE created_at < $1;
```

### Upsert (Insert or Update on Conflict)

```tree
save row, base user
  make user
    bind email, <alice@example.com>
    bind name, <Alice>
    bind login-count, 1
  hook conflict, name email
    bind name, <Alice>
    bind login-count
      call add
        bind a, read self/login-count
        bind b, 1
```

```sql
INSERT INTO user (email, name, login_count)
VALUES ('alice@example.com', 'Alice', 1)
ON CONFLICT (email) DO UPDATE SET
  name = 'Alice',
  login_count = user.login_count + 1;
```

### Upsert: Do Nothing

```tree
save row, base user
  make user
    bind email, <alice@example.com>
    bind name, <Alice>
  hook conflict, name email
    mark skip
```

```sql
INSERT INTO user (email, name)
VALUES ('alice@example.com', 'Alice')
ON CONFLICT (email) DO NOTHING;
```

## Update (`save row` with `hold`)

When `save row` includes a `hold` filter, it becomes an UPDATE.

### Simple Update

```tree
save row, base user
  bind active, term true
  hold is-equal
    bind a, read self/email-confirmed
    bind b, term true
```

```sql
UPDATE user SET active = true WHERE email_confirmed = true;
```

### Update with Computed Value

```tree
save row, base product
  bind price
    call multiply
      bind a, read self/price
      bind b, 1.1
  hold is-equal
    bind a, read self/category
    bind b, <electronics>
```

```sql
UPDATE product SET price = price * 1.1 WHERE category = 'electronics';
```

### Update with Returning

```tree
save row, base user
  bind active, term false
  hold is-equal
    bind a, read self/id
    bind b, read user-id
  send id
  send name
  send email
```

```sql
UPDATE user SET active = false WHERE id = $1
RETURNING id, name, email;
```

### Backfill Column

```tree
save row, base user
  bind age
    call extract
      bind part, term year
      bind value
        call age
          bind a, read self/birthday
```

```sql
UPDATE user SET age = extract(year from age(birthday));
```

### Update with Join

```tree
save row, base order
  bind status, <shipped>
  bond shipment
    hold is-equal
      bind a, read shipment/order-id
      bind b, read order/id
  hold is-equal
    bind a, read shipment/status
    bind b, <dispatched>
```

```sql
UPDATE "order" o
SET status = 'shipped'
FROM shipment s
WHERE s.order_id = o.id
  AND s.status = 'dispatched';
```

## Delete (`toss row`)

### Simple Delete

```tree
toss row, base session
  hold is-below
    bind a, read self/expired-at
    bind b, call now
```

```sql
DELETE FROM session WHERE expired_at < now();
```

### Delete with Returning

```tree
toss row, base user
  hold is-equal
    bind a, read self/id
    bind b, read user-id
  send id
  send email
```

```sql
DELETE FROM user WHERE id = $1 RETURNING id, email;
```

### Delete All Rows

```tree
toss row, base session
```

```sql
DELETE FROM session;
```

### Truncate (Fast Delete All)

```tree
call truncate
  bind table, term session
```

```sql
TRUNCATE TABLE session;
```

With cascade and restart identity:

```tree
call truncate
  bind table, term session
  mark cascade
  mark restart-identity
```

```sql
TRUNCATE TABLE session CASCADE RESTART IDENTITY;
```

## Permissions (`save role` / `toss role`)

### Grant Select

```tree
save role, name app-user
  base user
  task select
```

```sql
GRANT SELECT ON user TO app_user;
```

### Grant Multiple Permissions

```tree
save role, name app-user
  base user
  task select
  task insert
  task update
```

```sql
GRANT SELECT, INSERT, UPDATE ON user TO app_user;
```

### Grant on Specific Columns

```tree
save role, name app-user
  base user
    link email
    link name
  task update
```

```sql
GRANT UPDATE (email, name) ON user TO app_user;
```

### Grant on All Tables

```tree
save role, name app-user
  case all
  task select
  task insert
  task update
  task delete
```

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES TO app_user;
```

### Revoke Permission

```tree
toss role, name guest-user
  base user
  task insert
```

```sql
REVOKE INSERT ON user FROM guest_user;
```

### Revoke All

```tree
toss role, name guest-user
  base user
  task select
  task insert
  task update
  task delete
```

```sql
REVOKE SELECT, INSERT, UPDATE, DELETE ON user FROM guest_user;
```

## Transactions

### Basic Transaction

```tree
call begin

save row, base account
  bind balance
    call subtract
      bind a, read self/balance
      bind b, read amount
  hold is-equal
    bind a, read self/id
    bind b, read from-id

save row, base account
  bind balance
    call add
      bind a, read self/balance
      bind b, read amount
  hold is-equal
    bind a, read self/id
    bind b, read to-id

call commit
```

```sql
BEGIN;

UPDATE account SET balance = balance - $1 WHERE id = $2;
UPDATE account SET balance = balance + $1 WHERE id = $3;

COMMIT;
```

### Rollback

```tree
call begin

save row, base inventory
  bind quantity
    call subtract
      bind a, read self/quantity
      bind b, read amount
  hold is-equal
    bind a, read self/product-id
    bind b, read product-id

call rollback
```

```sql
BEGIN;
UPDATE inventory SET quantity = quantity - $1 WHERE product_id = $2;
ROLLBACK;
```

### Savepoints

```tree
call begin

save row, base user
  bind name, <Alice>
  hold is-equal
    bind a, read self/id
    bind b, 1

call savepoint, name before-email

save row, base user
  bind email, <new@example.com>
  hold is-equal
    bind a, read self/id
    bind b, 1

call rollback-to, name before-email

call commit
```

```sql
BEGIN;
UPDATE user SET name = 'Alice' WHERE id = 1;
SAVEPOINT before_email;
UPDATE user SET email = 'new@example.com' WHERE id = 1;
ROLLBACK TO before_email;
COMMIT;
```

## Keyword Summary

| Keyword | Purpose | SQL equivalent |
| --- | --- | --- |
| **Schema creation** | | |
| `make table` | Create table | `CREATE TABLE` |
| `make index` | Create index | `CREATE INDEX` |
| `make view` | Create view | `CREATE VIEW` |
| `make materialized-view` | Create materialized view | `CREATE MATERIALIZED VIEW` |
| `make sequence` | Create sequence | `CREATE SEQUENCE` |
| `make enum` | Create enum type | `CREATE TYPE ... AS ENUM` |
| `make function` | Create function | `CREATE FUNCTION` |
| `make trigger` | Create trigger | `CREATE TRIGGER` |
| **Schema alteration** | | |
| `mold table` | Alter table | `ALTER TABLE` |
| `make column` | Add column | `ADD COLUMN` |
| `mold column` | Alter column | `ALTER COLUMN` |
| `toss column` | Drop column | `DROP COLUMN` |
| `make constraint` | Add constraint | `ADD CONSTRAINT` |
| `toss constraint` | Drop constraint | `DROP CONSTRAINT` |
| **Column constraints** | | |
| `mark primary` | Primary key | `PRIMARY KEY` |
| `mark unique` | Unique constraint | `UNIQUE` |
| `mark foreign` | Foreign key | `REFERENCES` |
| `need true` / `need false` | Nullability | `NOT NULL` / nullable |
| `base <value>` | Default value | `DEFAULT` |
| `hold <predicate>` | Check constraint | `CHECK (...)` |
| **Data manipulation** | | |
| `save row` (no `hold`) | Insert | `INSERT INTO` |
| `save row` (with `hold`) | Update | `UPDATE ... WHERE` |
| `toss row` | Delete | `DELETE FROM` |
| `hook conflict` | Upsert | `ON CONFLICT DO UPDATE` |
| `mark skip` | Skip on conflict | `ON CONFLICT DO NOTHING` |
| `send <col>` | Returning clause | `RETURNING` |
| **Drop** | | |
| `toss table` | Drop table | `DROP TABLE` |
| `toss index` | Drop index | `DROP INDEX` |
| `toss view` | Drop view | `DROP VIEW` |
| `toss sequence` | Drop sequence | `DROP SEQUENCE` |
| `toss function` | Drop function | `DROP FUNCTION` |
| `toss trigger` | Drop trigger | `DROP TRIGGER` |
| `toss enum` | Drop enum type | `DROP TYPE` |
| `mark cascade` | Cascade drop | `CASCADE` |
| `mark safe` | If exists | `IF EXISTS` |
| **Permissions** | | |
| `save role` | Grant permission | `GRANT` |
| `toss role` | Revoke permission | `REVOKE` |
| **Transactions** | | |
| `call begin` | Start transaction | `BEGIN` |
| `call commit` | Commit transaction | `COMMIT` |
| `call rollback` | Rollback transaction | `ROLLBACK` |
| `call savepoint` | Create savepoint | `SAVEPOINT` |
| `call rollback-to` | Rollback to savepoint | `ROLLBACK TO` |
| `call truncate` | Fast delete all | `TRUNCATE` |
| `call refresh` | Refresh materialized view | `REFRESH MATERIALIZED VIEW` |
