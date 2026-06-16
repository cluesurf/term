# Seeding (`seed seed`)

Seeding in Seed populates databases with test and development data.
Define seed blocks with `seed seed`, generate fake data with built-in
helpers, and control execution order with `hook step`. Seeds are
idempotent and environment-aware.

## Basic Seed

Create simple records with `seed seed`.

```tree
seed seed
  name <default-roles>

  hook step
    call make-record
      bind table, <role>
      bind data
        bind name, <admin>
        bind level, mark 100

    call make-record
      bind table, <role>
      bind data
        bind name, <editor>
        bind level, mark 50

    call make-record
      bind table, <role>
      bind data
        bind name, <viewer>
        bind level, mark 10
```

**`seed seed`** declares a seed block.
**`name`** identifies the seed for tracking.
**`hook step`** contains the operations to run.
**`call make-record`** inserts a row into the specified table.

## Fake Data Helpers

Generate realistic test data with fake data functions.

```tree
seed seed
  name <test-users>

  hook step
    walk size
      bind base, mark 0
      bind head, mark 10
      hook next
        take slot, name i
        call make-record
          bind table, <user>
          bind data
            bind name, call fake-name
            bind email, call fake-email
            bind phone, call fake-phone
            bind avatar, call fake-avatar-url
            bind created-at, call fake-past-date
              bind days, mark 365
```

**`call fake-name`** generates a random full name.
**`call fake-email`** generates a random email address.
**`call fake-phone`** generates a random phone number.
**`call fake-past-date`** generates a random date within N days ago.

### Available Fake Data Functions

| Function | Output |
|----------|--------|
| `call fake-name` | Full name |
| `call fake-first-name` | First name |
| `call fake-last-name` | Last name |
| `call fake-email` | Email address |
| `call fake-phone` | Phone number |
| `call fake-address` | Street address |
| `call fake-city` | City name |
| `call fake-country` | Country name |
| `call fake-zip` | Postal code |
| `call fake-avatar-url` | Avatar image URL |
| `call fake-text` | Paragraph of text |
| `call fake-sentence` | Single sentence |
| `call fake-uuid` | UUID string |
| `call fake-past-date` | Random past date |
| `call fake-future-date` | Random future date |
| `call fake-number` | Random number in range |
| `call fake-pick` | Random item from a list |

## Related Data

Seed data with foreign key relationships.

```tree
seed seed
  name <users-with-posts>

  hook step
    walk size
      bind base, mark 0
      bind head, mark 5
      hook next
        take slot, name i

        save user, call make-record
          bind table, <user>
          bind data
            bind name, call fake-name
            bind email, call fake-email

        walk size
          bind base, mark 0
          bind head, mark 3
          hook next
            take slot, name j
            call make-record
              bind table, <post>
              bind data
                bind title, call fake-sentence
                bind body, call fake-text
                bind author-id, read user/id
                bind created-at, call fake-past-date
                  bind days, mark 90
```

**`call make-record`** returns the created record. Use `read user/id`
to reference the generated ID in child records.

## Conditional Seeding

Run seeds only in specific environments.

```tree
seed seed
  name <dev-admin-user>
  bind env, <development>

  hook step
    call make-record
      bind table, <user>
      bind data
        bind name, <Dev Admin>
        bind email, <admin@localhost>
        bind role, <admin>
```

```tree
seed seed
  name <staging-test-data>
  bind env, <staging>

  hook step
    walk size
      bind base, mark 0
      bind head, mark 100
      hook next
        take slot, name i
        call make-record
          bind table, <user>
          bind data
            bind name, call fake-name
            bind email, call fake-email
```

**`bind env`** restricts the seed to a specific environment.
Without it, the seed runs in all environments.

## Bulk Generation

Generate large datasets efficiently.

```tree
seed seed
  name <load-test-data>
  bind env, <development>

  hook step
    call make-batch
      bind table, <event>
      bind count, mark 10000
      bind data
        take slot, name i
        bind type, call fake-pick
          bind from, make list
            like text
            call push
              bind value, <click>
            call push
              bind value, <view>
            call push
              bind value, <purchase>
        bind user-id, call fake-uuid
        bind timestamp, call fake-past-date
          bind days, mark 30
        bind value, call fake-number
          bind min, mark 1
          bind max, mark 1000
```

**`call make-batch`** inserts many records in a single transaction.
**`bind count`** sets how many records to generate.
The `bind data` block receives the iteration index and returns
field values for each record.

## Ordered Steps

Control execution order with multiple `hook step` blocks.

```tree
seed seed
  name <full-setup>

  hook step
    call make-record
      bind table, <category>
      bind data
        bind name, <Electronics>
        bind slug, <electronics>

  hook step
    call make-record
      bind table, <category>
      bind data
        bind name, <Books>
        bind slug, <books>

  hook step
    save electronics, call find-record
      bind table, <category>
      bind where
        bind slug, <electronics>

    walk size
      bind base, mark 0
      bind head, mark 5
      hook next
        take slot, name i
        call make-record
          bind table, <product>
          bind data
            bind name, call fake-sentence
            bind price, call fake-number
              bind min, mark 100
              bind max, mark 100000
            bind category-id, read electronics/id
```

Steps run in order. Later steps can reference data from earlier steps
using `call find-record`.

## Cleanup

Remove seeded data.

```tree
seed seed
  name <cleanup-test-data>
  bind env, <test>

  hook step
    call wipe-table, <order-item>
    call wipe-table, <order>
    call wipe-table, <post>
    call wipe-table, <user>
    call wipe-table, <role>
```

**`call wipe-table`** deletes all rows from a table. Order matters
for foreign key constraints. Delete child tables first.

## Keyword Reference

| Keyword | Purpose |
|---------|---------|
| `seed seed` | Declare a seed block |
| `name` | Seed identifier |
| `hook step` | Execution step (runs in order) |
| `bind env` | Restrict to environment |
| `call make-record` | Insert a single record |
| `call make-batch` | Insert many records |
| `call find-record` | Look up existing record |
| `call wipe-table` | Delete all rows from table |
| `bind table` | Target table name |
| `bind data` | Record field values |
| `bind count` | Number of records for batch |
| `call fake-*` | Generate fake data |
