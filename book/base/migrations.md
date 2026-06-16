# Migrations (`seed migrate`)

Migrations in Seed define database schema changes with reversible
up/down steps. Each migration has a name, a `hook up` for applying
changes, and a `hook down` for reverting. The system tracks which
migrations have run and applies them in order.

## Create Table

Create a new table with columns.

```tree
seed migrate
  name <create-users>

  hook up
    make table, <user>
      link id, like uuid
        mark primary
      link email, like text
        mark unique
      link name, like text
      link created-at, like timestamp
        base call get-time

  hook down
    toss table, <user>
```

**`make table`** creates a new table. Each **`link`** is a column.
**`mark primary`** sets the primary key.
**`mark unique`** adds a unique constraint.
**`base`** sets a default value.

**`toss table`** drops the table entirely. The `hook down` undoes
what `hook up` did.

## Add Columns

Add columns to an existing table with `mold table`.

```tree
seed migrate
  name <add-user-profile-fields>

  hook up
    mold table, <user>
      link avatar-url, like text
        need false
      link bio, like text
        need false
      link phone, like text
        need false

  hook down
    mold table, <user>
      toss link, <avatar-url>
      toss link, <bio>
      toss link, <phone>
```

**`mold table`** alters an existing table.
New **`link`** entries inside `mold table` add columns.
**`toss link`** removes a column.

Use `need false` for nullable columns. This avoids conflicts with
existing rows.

## Add Index

Create indexes for query performance.

```tree
seed migrate
  name <add-user-indexes>

  hook up
    make index, <idx-user-email>
      bind table, <user>
      bind link, <email>
      mark unique

    make index, <idx-user-created>
      bind table, <user>
      bind link, <created-at>

  hook down
    toss index, <idx-user-email>
    toss index, <idx-user-created>
```

**`make index`** creates a named index.
**`bind table`** and **`bind link`** specify where.
**`mark unique`** makes it a unique index.
**`toss index`** drops the index.

### Composite Index

```tree
seed migrate
  name <add-composite-index>

  hook up
    make index, <idx-order-user-date>
      bind table, <order>
      bind links
        link user-id
        link created-at

  hook down
    toss index, <idx-order-user-date>
```

**`bind links`** (plural) takes multiple column references for
composite indexes.

## Rename Column

Rename a column without losing data.

```tree
seed migrate
  name <rename-user-name-to-display-name>

  hook up
    mold table, <user>
      mold link, <name>
        name <display-name>

  hook down
    mold table, <user>
      mold link, <display-name>
        name <name>
```

**`mold link`** modifies an existing column.
**`name`** changes the column name.

## Change Column Type

Alter a column's type or constraints.

```tree
seed migrate
  name <change-price-precision>

  hook up
    mold table, <product>
      mold link, <price>
        like f64

  hook down
    mold table, <product>
      mold link, <price>
        like f32
```

## Drop Table

Remove a table with safety.

```tree
seed migrate
  name <drop-legacy-sessions>

  hook up
    toss table, <legacy-session>

  hook down
    make table, <legacy-session>
      link id, like uuid
        mark primary
      link user-id, like uuid
      link token, like text
      link expires-at, like timestamp
```

The `hook down` recreates the table structure. Data is lost on drop
but the schema can be restored.

## Foreign Keys

Define relationships between tables.

```tree
seed migrate
  name <create-posts>

  hook up
    make table, <post>
      link id, like uuid
        mark primary
      link title, like text
      link body, like text
      link author-id, like uuid
        bind ref, <user>
        bind ref-link, <id>
        bind on-delete, <cascade>
      link created-at, like timestamp
        base call get-time

  hook down
    toss table, <post>
```

**`bind ref`** sets the referenced table.
**`bind ref-link`** sets the referenced column.
**`bind on-delete`** controls cascade behavior: `cascade`, `set-null`,
`restrict`, `no-action`.

## Multiple Steps

A single migration can have multiple operations.

```tree
seed migrate
  name <create-order-system>

  hook up
    make table, <order>
      link id, like uuid
        mark primary
      link user-id, like uuid
        bind ref, <user>
        bind ref-link, <id>
      link status, like text
        base <pending>
      link total, like i64
      link created-at, like timestamp

    make table, <order-item>
      link id, like uuid
        mark primary
      link order-id, like uuid
        bind ref, <order>
        bind ref-link, <id>
        bind on-delete, <cascade>
      link product-id, like uuid
      link quantity, like u32
      link price, like i64

    make index, <idx-order-user>
      bind table, <order>
      bind link, <user-id>

    make index, <idx-order-item-order>
      bind table, <order-item>
      bind link, <order-id>

  hook down
    toss table, <order-item>
    toss table, <order>
```

Drop tables in reverse order to respect foreign key constraints.

## Keyword Reference

| Keyword | Purpose |
|---------|---------|
| `seed migrate` | Declare a migration block |
| `name` | Migration identifier |
| `hook up` | Forward migration steps |
| `hook down` | Rollback migration steps |
| `make table` | Create a new table |
| `toss table` | Drop a table |
| `mold table` | Alter an existing table |
| `link` | Define a column |
| `toss link` | Drop a column |
| `mold link` | Alter a column |
| `make index` | Create an index |
| `toss index` | Drop an index |
| `mark primary` | Primary key constraint |
| `mark unique` | Unique constraint |
| `like` | Column data type |
| `base` | Default value |
| `need false` | Nullable column |
| `bind ref` | Foreign key target table |
| `bind ref-link` | Foreign key target column |
| `bind on-delete` | Cascade behavior on delete |
