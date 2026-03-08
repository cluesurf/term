# Queries (`find`)

Define named database queries with `find`. A `find` block declares a
query name, accepts parameters with `take`, specifies the source table,
selects columns, applies filters, and controls ordering and limits.

## Basic Query

```tree
find active-users, base user
  send name
  send email
  hold is-equal
    bind a, read self/status
    bind b, <active>
```

This produces:

```sql
SELECT name, email FROM user WHERE status = 'active'
```

## Parameters (`take`)

Queries accept runtime parameters with `take`:

```tree
find users-by-role, base user
  take role, like text
  take limit, like u64
  send name
  send email
  send role
  hold is-equal
    bind a, read self/role # `self/role` is the record row field
    bind b, read role # `role` is the passed in parameter `role`
  size {limit}
```

```sql
SELECT name, email, role FROM user WHERE role = $1 LIMIT $2
```

## Selecting Columns (`take`)

Select specific columns:

```tree
find order-summary, base order
  take id
  take total
  take created-at
```

Select all columns:

```tree
find all-products, base product
```

Alias a column:

```tree
find user-names
  base user
  send given, read self/first-name
  send family, read self/last-name
```

## Filtering (`test`)

### Simple Equality

```tree
find product-by-sku
  take sku, like text
  base product
  hold is-equal
    bind a, read self/sku
    bind b, read sku
```

### Comparison Operators

```tree
find expensive-items
  base product
  take floor, like u64
  hold is-above
    bind a, read self/price
    bind b, read floor
```

```tree
find recent-orders
  base order
  take cutoff, like timestamp
  hold is-above
    bind a, read self/created-at
    bind b, read cutoff
```

### Combined Conditions (`meet and`)

```tree
find active-premium-users
  take min-spend, like u64
  base user
  meet and
    hold is-equal
      bind a, read self/status
      bind b, <active>
    hold is-equal
      bind a, read self/tier
      bind b, <premium>
    hold is-above
      bind a, read self/total-spend
      bind b, read min-spend
```

```sql
SELECT * FROM user
WHERE status = 'active'
  AND tier = 'premium'
  AND total_spend > $1
```

### Or Conditions (`meet or`)

```tree
find flagged-orders
  base order
  meet or
    hold is-equal
      bind a, read self/status
      bind b, <cancelled>
    hold is-equal
      bind a, read self/status
      bind b, <refunded>
    hold is-above
      bind a, read self/total
      bind b, 10000
```

```sql
SELECT * FROM order
WHERE status = 'cancelled'
   OR status = 'refunded'
   OR total > 10000
```

### Nested Logic

Combine `meet and` and `meet or` for complex conditions:

```tree
find complex-user-search
  base user
  take role, like text
  take min-age, like u64
  meet and
    test is-equal
      bind a, read self/active
      bind b, term true
    meet or
      test is-equal
        bind a, read self/role
        bind b, read role
      test is-equal
        bind a, read self/role
        bind b, <admin>
    test is-minimum
      bind a, read self/age
      bind b, read min-age
```

```sql
SELECT * FROM user
WHERE active = true
  AND (role = $1 OR role = 'admin')
  AND age >= $2
```

## Null Checks

```tree
find unassigned-tickets
  base ticket
  hold is-missing
    bind a, read self/assigned-to
```

```tree
find assigned-tickets
  base ticket
  hold is-present
    bind a, read self/assigned-to
```

```sql
SELECT * FROM ticket WHERE assigned_to IS NULL
SELECT * FROM ticket WHERE assigned_to IS NOT NULL
```

## Pattern Matching

```tree
find search-users
  take term, like text
  base user
  hold has-match
    bind a, read self/name
    bind b, read term
```

```sql
SELECT * FROM user WHERE name LIKE $1
```

## Membership (`call has-item`)

```tree
find users-in-roles
  take roles, like list
  base user
  hold has-item
    bind list, read roles
    bind item, read self/role
```

```sql
SELECT * FROM user WHERE role IN ($1)
```

## Ordering (`sort`)

```tree
find newest-orders
  base order
  sort rise, name created-at
  size 50
```

```tree
find cheapest-products
  base product
  sort rise, name price
  size 20
```

Multiple sort columns:

```tree
find user-directory
  base user
  sort rise, name last-name
  sort rise, name first-name
```

```sql
SELECT * FROM user ORDER BY last_name ASC, first_name ASC
```

## Limit and Offset (`head`, `head`)

```tree
find paginated-products
  take page, like u64
  take size, like u64
  base product
  sort rise, name name
  size read size
  bind offset
    call multiply
      bind a, read page
      bind b, read size
```

```sql
SELECT * FROM product ORDER BY name ASC LIMIT $1 OFFSET ($2 * $1)
```

## Joins (`join`)

### Inner Join

```tree
find order-details
  base order
  take order-id, like u64
  bond order-item, name item
    hold is-equal
      bind a, read item/order-id
      bind b, read order/id
  bond product
    hold is-equal
      bind a, read product/id
      bind b, read item/product-id
  hold is-equal
    bind a, read order/id
    bind b, read order-id
  send order-id, read order/id
  send product-name, read product/name
  send quantity, read item/quantity
  send price, read item/price
```

```sql
SELECT o.id, p.name, oi.quantity, oi.price
FROM "order" o
JOIN order_item oi ON oi.order_id = o.id
JOIN product p ON p.id = oi.product_id
WHERE o.id = $1
```

### Left Join

```tree
find users-with-orders
  base user
  send name, read user/name
  send total, read order/total
  bond order, like left
    hold is-equal
      bind a, read order/user-id
      bind b, read user/id
```

```sql
SELECT u.name, o.total
FROM user u
LEFT JOIN "order" o ON o.user_id = u.id
```

## Aggregation (`fold`)

```tree
find category-totals
  base product
  send category
  send total
    call sum # all function calls in `find` are native sql calls
      bind a, read self/price
  send product-count
    call count
      bind a, read self/id
  fold category
```

```sql
SELECT category, SUM(price) AS total, COUNT(id) AS product_count
FROM product
GROUP BY category
```

### Aggregate Filtering (`hold <term>`)

```tree
find popular-categories
  base product
  take min-count, like u64
  send category
  send product-count
    call count
      bind a, read id
  fold category
  hold is-minimum
    bind a, read product-count
    bind b, read min-count
```

```sql
SELECT category, COUNT(id) AS product_count
FROM product
GROUP BY category
HAVING COUNT(id) >= $1
```

**Note**: `HAVING` and `WHERE` are both done with `hold` term in seed. But `hold` that come _after_ `fold` is considered after `GROUP BY`, so becomes `having`, but any `hold` _before_ `fold` becomes `WHERE` (or hold without any `fold` is also `WHERE`).

## Subqueries

```tree
find above-average-orders
  base order
  hold is-above
    bind a, read self/total
    bind b
      find average-total
        base order
        send total
          call average
            bind a, read self/total
```

```sql
SELECT * FROM "order"
WHERE total > (SELECT AVG(total) FROM "order")
```

## Full Example

A complex query combining multiple features:

```tree
find dashboard-report
  base project

  take team-id, like u64
  take start-date, like timestamp
  take end-date, like timestamp
  take min-revenue, like u64

  send project-name, name project/name
  send task-count
    call count
      bind a, read task/id
  send total-revenue
    call sum
      bind a, read task/revenue

  bond task
    hold is-equal
      bind a, read task/project-id
      bind b, read project/id
  bond user
    hold is-equal
      bind a, read user/id
      bind b, read task/assigned-to
  meet and
    hold is-equal
      bind a, read project/team-id
      bind b, read team-id
    hold is-minimum
      bind a, read task/created-at
      bind b, read start-date
    hold is-maximum
      bind a, read task/created-at
      bind b, read end-date
  fold project-name
  hold is-minimum
    bind a, read total-revenue
    bind b, read min-revenue
  sort fall, name total-revenue
  size 25
```

```sql
SELECT
  p.name,
  COUNT(t.id) AS task_count,
  SUM(t.revenue) AS total_revenue
FROM project p
JOIN task t ON t.project_id = p.id
JOIN user u ON u.id = t.assigned_to
WHERE p.team_id = $1
  AND t.created_at >= $2
  AND t.created_at <= $3
GROUP BY p.name
HAVING SUM(t.revenue) >= $4
ORDER BY total_revenue DESC
LIMIT 25
```

## Keyword Summary

| Keyword | Purpose | SQL equivalent |
| --- | --- | --- |
| `find <name>` | Define a named query | (query name) |
| `take <name>` | Query parameter | `$1`, `$2`, etc. |
| `base <table>` | Source table | `FROM` |
| `take <column>` | Select column | `SELECT` |
| `take <column>, name <alias>` | Alias column | `AS` |
| `meet and` | All conditions must match | `AND` |
| `meet or` | Any condition can match | `OR` |
| `join <table>` | Inner join | `JOIN` |
| `join <table>, left` | Left join | `LEFT JOIN` |
| `sort <column>, rise` | Order ascending | `ORDER BY ASC` |
| `sort <column>, fall` | Order descending | `ORDER BY DESC` |
| `size <n>` | Limit results | `LIMIT` |
| `head <n>` | Offset results | `OFFSET` |
| `fold <column>` | Group by | `GROUP BY` |
| `hold <term>` | Filter groups | `HAVING` |
| `call sum` | Sum aggregate | `SUM()` |
| `call count` | Count aggregate | `COUNT()` |
| `call average` | Average aggregate | `AVG()` |
| `hold is-equal` | Equality check | `=` |
| `hold is-above` | Greater than | `>` |
| `hold is-below` | Less than | `<` |
| `hold is-minimum` | Greater than or equal | `>=` |
| `hold is-maximum` | Less than or equal | `<=` |
| `hold is-void` | Null check | `IS NULL` |
| `hold is-present` | Not null check | `IS NOT NULL` |
| `hold has-match` | Pattern match | `LIKE` |
| `hold has-item` | Membership hold | `IN` |

## Multi-Dimensional Report

```tree
find sales-by-category
  base product

  take min-products, like u64
  take min-orders, like u64
  take min-revenue, like u64
  take min-avg-value, like u64

  send category, read product/category
  send brand, read product/brand
  send country, read customer/country
  send product-count
    call count-distinct
      bind a, read product/id
  send order-count
    call count-distinct
      bind a, read order-item/id
  send total-units
    call sum
      bind a, read order-item/quantity
  send total-revenue
    call sum
      bind a, read order-item/total-price
  send avg-order-value
    call average
      bind a, read order-item/total-price

  bond order-item
    hold is-equal
      bind a, read order-item/product-id
      bind b, read product/id
  bond customer
    hold is-equal
      bind a, read customer/id
      bind b, read order-item/customer-id

  fold product/category
  fold product/brand
  fold customer/country

  meet and
    hold is-minimum
      bind a, read product-count
      bind b, read min-products
    hold is-minimum
      bind a, read order-count
      bind b, read min-orders
    hold is-minimum
      bind a, read total-revenue
      bind b, read min-revenue
    hold is-minimum
      bind a, read avg-order-value
      bind b, read min-avg-value

  sort fall, name total-revenue
  sort fall, name total-units
```

```sql
SELECT
  p.category,
  p.brand,
  c.country,
  COUNT(DISTINCT p.id) AS product_count,
  COUNT(DISTINCT o.id) AS order_count,
  SUM(o.quantity) AS total_units,
  SUM(o.total_price) AS total_revenue,
  AVG(o.total_price) AS avg_order_value
FROM product p
JOIN order_item o ON o.product_id = p.id
JOIN customer c ON c.id = o.customer_id
GROUP BY
  p.category,
  p.brand,
  c.country
HAVING
  COUNT(DISTINCT p.id) >= $1
  AND COUNT(DISTINCT o.id) >= $2
  AND SUM(o.total_price) >= $3
  AND AVG(o.total_price) >= $4
ORDER BY total_revenue DESC, total_units DESC;
```

## Negation (`miss`)

Negate any condition with `miss`. It wraps a single condition or a
group of conditions.

### Simple Negation

Find inactive users (where `active` is not true):

```tree
find inactive-users
  base user
  miss
    hold is-equal
      bind a, read self/active
      bind b, wave true
```

```sql
SELECT * FROM user WHERE NOT active
```

### Negating a Group

Find orders that are neither cancelled nor refunded:

```tree
find open-orders
  base order
  miss
    meet or
      hold is-equal
        bind a, read self/status
        bind b, <cancelled>
      hold is-equal
        bind a, read self/status
        bind b, <refunded>
```

```sql
SELECT * FROM order
WHERE NOT (status = 'cancelled' OR status = 'refunded')
```

### NOT LIKE

Find users whose email is not from a test domain:

```tree
find real-users
  base user
  miss
    hold has-match
      bind a, read self/email
      bind b, <%@test.com>
```

```sql
SELECT * FROM user WHERE email NOT LIKE '%@test.com'
```

### NOT IN

Find users not in a blacklist:

```tree
find allowed-users
  take blocked-ids, like list
  base user
  hold is-item-missing
    bind list, read blocked-ids
    bind item, read self/id
```

```sql
SELECT * FROM user WHERE id NOT IN ($1)
```

### Soft-Deleted Records

Find records that have been soft-deleted (deleted_at is not null):

```tree
find deleted-accounts
  base account
  hold is-present
    bind a, read self/deleted-at
```

Find records that have not been soft-deleted:

```tree
find live-accounts
  base account
  hold is-missing
    bind a, read self/deleted-at
```

```sql
SELECT * FROM account WHERE deleted_at IS NOT NULL
SELECT * FROM account WHERE deleted_at IS NULL
```

## Distinct (`sift <column>`)

Use `sift <name>` to eliminate duplicate rows.

### Distinct Select

Find all unique roles in the system:

```tree
find unique-roles
  base user
  sift role
```

```sql
SELECT DISTINCT role FROM user
```

### Distinct on Multiple Columns

Find unique department and role combinations:

```tree
find unique-positions
  base employee

  sift department
  sift role

  sort rise, name department
  sort rise, name role
```

```sql
SELECT DISTINCT department, role
FROM employee
ORDER BY department ASC, role ASC
```

### COUNT DISTINCT in Aggregation

Count unique customers per product category:

```tree
find category-reach
  base order-item
  bond product
    hold is-equal
      bind a, read product/id
      bind b, read order-item/product-id
  send category, read product/category
  send unique-customers
    call count-distinct
      bind a, read order-item/customer-id
  send total-orders
    call count
      bind a, read order-item/id
  fold product/category
  sort fall, name unique-customers
```

```sql
SELECT
  p.category,
  COUNT(DISTINCT oi.customer_id) AS unique_customers,
  COUNT(oi.id) AS total_orders
FROM order_item oi
JOIN product p ON p.id = oi.product_id
GROUP BY p.category
ORDER BY unique_customers DESC
```

## Exists (`hold is-present`)

Use `hold is-present` to check whether a correlated subquery returns any rows.
Use `hold is-missing` to negate it.

### Users Who Have Placed Orders

```tree
find customers-with-orders
  base user
  hold is-present
    find user-order
      base order
      hold is-equal
        bind a, read self/user-id
        bind b, read user/id
```

```sql
SELECT * FROM user
WHERE EXISTS (
  SELECT 1 FROM "order" o WHERE o.user_id = user.id
)
```

### Users Who Have Never Ordered

```tree
find customers-without-orders
  base user
  hold is-missing
    find user-order
      base order
      hold is-equal
        bind a, read self/user-id
        bind b, read user/id
```

```sql
SELECT * FROM user
WHERE NOT EXISTS (
  SELECT 1 FROM "order" o WHERE o.user_id = user.id
)
```

### Employees With No Direct Reports

```tree
find individual-contributors
  base employee
  hold is-missing
    find direct-report
      base employee, name report
      hold is-equal
        bind a, read report/manager-id
        bind b, read employee/id
```

```sql
SELECT * FROM employee
WHERE NOT EXISTS (
  SELECT 1 FROM employee report WHERE report.manager_id = employee.id
)
```

### Products Ordered in the Last 30 Days

```tree
find recently-ordered-products
  take since, like timestamp
  base product
  hold is-present
    find recent-order
      base order-item
      bond order
        hold is-equal
          bind a, read order/id
          bind b, read order-item/order-id
      meet and
        hold is-equal
          bind a, read order-item/product-id
          bind b, read product/id
        hold is-minimum
          bind a, read order/created-at
          bind b, read since
```

```sql
SELECT * FROM product
WHERE EXISTS (
  SELECT 1
  FROM order_item oi
  JOIN "order" o ON o.id = oi.order_id
  WHERE oi.product_id = product.id
    AND o.created_at >= $1
)
```

## Set Operations (`mesh`)

Combine multiple queries with `mesh`. The mode controls how results
are merged.

### Union (deduplicated)

Get all people from both customers and suppliers:

```tree
find all-contacts
  mesh union
    find customer-contacts
      base customer
      send name
      send email
      send phone
    find supplier-contacts
      base supplier
      send name
      send email
      send phone
```

```sql
SELECT name, email, phone FROM customer
UNION
SELECT name, email, phone FROM supplier
```

### Union All (keep duplicates)

Combine transaction logs from two tables into a single timeline:

```tree
find all-transactions
  mesh union-all
    find credit-transactions
      base credit
      send amount
      send created-at
      send description
      sort rise, name created-at
    find debit-transactions
      base debit
      send amount
      send created-at
      send description
      sort rise, name created-at
```

```sql
SELECT amount, created_at, description FROM credit
UNION ALL
SELECT amount, created_at, description FROM debit
ORDER BY created_at ASC
```

### Intersect

Find users who are both customers and newsletter subscribers:

```tree
find engaged-customers
  mesh intersect
    find customer-emails
      base customer
      send email
    find subscriber-emails
      base newsletter-subscriber
      send email
```

```sql
SELECT email FROM customer
INTERSECT
SELECT email FROM newsletter_subscriber
```

### Except

Find products in the catalog that have never been ordered:

```tree
find never-ordered-products
  mesh except
    find all-product-ids
      base product
      send id
    find ordered-product-ids
      base order-item
      send product-id, name id
```

```sql
SELECT id FROM product
EXCEPT
SELECT product_id AS id FROM order_item
```

## Conditional Expressions (`fork case`)

Use `fork case` inside `send` to produce computed columns with
conditional logic. Each `hook test` is a WHEN clause. `hook miss` is
the ELSE.

### Bucketing Orders by Size

```tree
find order-buckets
  base order
  send id
  send total
  send bucket
    fork case
      hook test
        hold is-minimum
          bind a, read self/total
          bind b, 1000
      hook hold
        <large>
      hook test
        hold is-minimum
          bind a, read self/total
          bind b, 100
      hook hold
        <medium>
      hook miss
        <small>
```

```sql
SELECT
  id,
  total,
  CASE
    WHEN total >= 1000 THEN 'large'
    WHEN total >= 100 THEN 'medium'
    ELSE 'small'
  END AS bucket
FROM "order"
```

### Conditional Sort Priority

Sort active items first, then everything else by name:

```tree
find prioritized-tasks
  base task
  send name
  send status
  sort rise, name priority
    fork case
      hook test
        hold is-equal
          bind a, read self/status
          bind b, <active>
      hook hold
        0
      hook miss
        1
  sort rise, name name
```

```sql
SELECT name, status
FROM task
ORDER BY
  CASE WHEN status = 'active' THEN 0 ELSE 1 END ASC,
  name ASC
```

### User-Friendly Status Labels

```tree
find order-display
  base order
  send id
  send label
    fork case
      hook test
        hold is-equal
          bind a, read self/status
          bind b, <pending>
      hook hold
        <Awaiting Payment>
      hook test
        hold is-equal
          bind a, read self/status
          bind b, <shipped>
      hook hold
        <On the Way>
      hook test
        hold is-equal
          bind a, read self/status
          bind b, <delivered>
      hook hold
        <Completed>
      hook miss
        <Unknown>
```

```sql
SELECT
  id,
  CASE
    WHEN status = 'pending' THEN 'Awaiting Payment'
    WHEN status = 'shipped' THEN 'On the Way'
    WHEN status = 'delivered' THEN 'Completed'
    ELSE 'Unknown'
  END AS label
FROM "order"
```

## Window Functions (`over`)

Use `over` to define a window for aggregate or ranking functions.
`fold` inside `over` is PARTITION BY. `sort` inside `over` is the
window ORDER BY.

### Row Number with Partition

Get the most recent order per customer:

```tree
find latest-order-per-customer
  base order
  send id
  send customer-id
  send total
  send created-at
  send rank
    call row-number
      over
        fold customer-id
        sort fall, name created-at
```

```sql
SELECT
  id,
  customer_id,
  total,
  created_at,
  ROW_NUMBER() OVER (
    PARTITION BY customer_id ORDER BY created_at DESC
  ) AS rank
FROM "order"
```

Use as a subquery to get only the first row per partition:

```tree
find most-recent-orders
  base
    find ranked-orders
      base order
      send id
      send customer-id
      send total
      send created-at
      send rank
        call row-number
          over
            fold customer-id
            sort fall, name created-at
  hold is-equal
    bind a, read self/rank
    bind b, 1
```

```sql
SELECT * FROM (
  SELECT
    id, customer_id, total, created_at,
    ROW_NUMBER() OVER (
      PARTITION BY customer_id ORDER BY created_at DESC
    ) AS rank
  FROM "order"
) sub
WHERE rank = 1
```

### Running Total

Calculate a running total of revenue per customer:

```tree
find customer-running-total
  base order
  send customer-id
  send created-at
  send total
  send running-total
    call sum
      bind a, read self/total
      over
        fold customer-id
        sort rise, name created-at
```

```sql
SELECT
  customer_id,
  created_at,
  total,
  SUM(total) OVER (
    PARTITION BY customer_id ORDER BY created_at ASC
  ) AS running_total
FROM "order"
```

### Lag / Lead (Previous and Next Values)

Compare each order's total to the previous order for the same
customer:

```tree
find order-comparison
  base order
  send customer-id
  send created-at
  send total
  send previous-total
    call lag
      bind a, read self/total
      over
        fold customer-id
        sort rise, name created-at
  send change
    call subtract
      bind a, read self/total
      bind b
        call lag
          bind a, read self/total
          over
            fold customer-id
            sort rise, name created-at
```

```sql
SELECT
  customer_id,
  created_at,
  total,
  LAG(total) OVER (
    PARTITION BY customer_id ORDER BY created_at ASC
  ) AS previous_total,
  total - LAG(total) OVER (
    PARTITION BY customer_id ORDER BY created_at ASC
  ) AS change
FROM "order"
```

### Percent of Group Total

Calculate each product's share of its category revenue:

```tree
find category-share
  base product
  send name
  send category
  send price
  send category-total
    call sum
      bind a, read self/price
      over
        fold category
  send share
    call divide
      bind a, read self/price
      bind b
        call sum
          bind a, read self/price
          over
            fold category
```

```sql
SELECT
  name,
  category,
  price,
  SUM(price) OVER (PARTITION BY category) AS category_total,
  price / SUM(price) OVER (PARTITION BY category) AS share
FROM product
```

## Common Table Expressions (`with`)

Use `with` to define named subqueries that can be referenced in the
main query. Each `find` inside `with` becomes a CTE.

### Simple CTE

Filter recent orders, then query the filtered set:

```tree
find high-value-recent-orders
  with
    find recent-orders
      base order
      take cutoff, like timestamp
      hold is-minimum
        bind a, read self/created-at
        bind b, read cutoff
  base recent-orders
  hold is-above
    bind a, read self/total
    bind b, 100
  sort fall, name total
```

```sql
WITH recent_orders AS (
  SELECT * FROM "order" WHERE created_at >= $1
)
SELECT * FROM recent_orders
WHERE total > 100
ORDER BY total DESC
```

### Multiple CTEs

Build a funnel analysis with stages:

```tree
find conversion-funnel
  load visitors
    base page-view
    take start-date, like timestamp
    take end-date, like timestamp
    sift user-id
    hold is-minimum
      bind a, read self/created-at
      bind b, read start-date
    hold is-maximum
      bind a, read self/created-at
      bind b, read end-date
  load signups
    base registration
    take start-date, like timestamp
    take end-date, like timestamp
    send user-id
    hold is-minimum
      bind a, read self/created-at
      bind b, read start-date
    hold is-maximum
      bind a, read self/created-at
      bind b, read end-date
  load purchasers
    base order
    take start-date, like timestamp
    take end-date, like timestamp
    sift user-id
    hold is-minimum
      bind a, read self/created-at
      bind b, read start-date
    hold is-maximum
      bind a, read self/created-at
      bind b, read end-date

  base visitors

  send stage, <visited>
  send count
    call count
      bind a, read visitors/user-id
```

```sql
WITH visitors AS (
  SELECT DISTINCT user_id
  FROM page_view
  WHERE created_at >= $1 AND created_at <= $2
),
signups AS (
  SELECT user_id
  FROM registration
  WHERE created_at >= $1 AND created_at <= $2
),
purchasers AS (
  SELECT DISTINCT user_id
  FROM "order"
  WHERE created_at >= $1 AND created_at <= $2
)
SELECT
  'visited' AS stage,
  COUNT(user_id) AS count
FROM visitors
```

### CTE Referencing Another CTE

Calculate month-over-month growth:

```tree
find monthly-growth
  load monthly-revenue
    base order
    send month
      call date-trunc
        bind unit, <month>
        bind a, read self/created-at
    send revenue
      call sum
        bind a, read self/total
    fold month
  load with-previous
    base monthly-revenue
    send month
    send revenue
    send previous-revenue
      call lag
        bind a, read self/revenue
        over
          sort rise, name month
  base with-previous

  hold is-present
    bind a, read self/previous-revenue

  send month
  send revenue
  send previous-revenue
  send growth-rate
    call divide
      bind a
        call subtract
          bind a, read self/revenue
          bind b, read self/previous-revenue
      bind b, read self/previous-revenue

  sort rise, name month
```

```sql
WITH monthly_revenue AS (
  SELECT
    DATE_TRUNC('month', created_at) AS month,
    SUM(total) AS revenue
  FROM "order"
  GROUP BY month
),
with_previous AS (
  SELECT
    month,
    revenue,
    LAG(revenue) OVER (ORDER BY month ASC) AS previous_revenue
  FROM monthly_revenue
)
SELECT
  month,
  revenue,
  previous_revenue,
  (revenue - previous_revenue) / previous_revenue AS growth_rate
FROM with_previous
WHERE previous_revenue IS NOT NULL
ORDER BY month ASC
```

## Recursive Queries (`nest <term>`)

Use `nest <term>` for recursive CTEs. The first `find` inside is the
base case (anchor). The second `find` references the CTE name and
is the recursive step.

### Org Chart Traversal

Find all reports under a manager, at any depth:

```tree
find all-reports
  take manager-id, like u64

  nest team-tree
    mesh union-all
      find a
        base employee
        hold is-equal
          bind a, read self/manager-id
          bind b, read manager-id
      find b
        base employee
        bond team-tree
          hold is-equal
            bind a, read employee/manager-id
            bind b, read team-tree/id

  send id
  send name
  send manager-id

  sort rise, name name
```

```sql
WITH RECURSIVE team_tree AS (
  SELECT id, name, manager_id
  FROM employee
  WHERE manager_id = $1
  UNION ALL
  SELECT e.id, e.name, e.manager_id
  FROM employee e
  JOIN team_tree tt ON e.manager_id = tt.id
)
SELECT id, name, manager_id
FROM team_tree
ORDER BY name ASC
```

### Category Tree with Depth

Walk a nested category hierarchy and track depth:

```tree
find category-tree
  take root-id, like u64
  nest tree
    mesh union-all
      find a
        base category
        send id
        send name
        send parent-id
        send depth, 0
        hold is-equal
          bind a, read self/id
          bind b, read root-id
      find b
        base category
        bond tree
          hold is-equal
            bind a, read category/parent-id
            bind b, read tree/id
        send id, read category/id
        send name, read category/name
        send parent-id, read category/parent-id
        send depth
          call add
            bind a, read tree/depth
            bind b, 1

  sort rise, name depth
  sort rise, name name
```

```sql
WITH RECURSIVE tree AS (
  SELECT id, name, parent_id, 0 AS depth
  FROM category
  WHERE id = $1
  UNION ALL
  SELECT c.id, c.name, c.parent_id, t.depth + 1
  FROM category c
  JOIN tree t ON c.parent_id = t.id
)
SELECT id, name, parent_id, depth
FROM tree
ORDER BY depth ASC, name ASC
```

### Bill of Materials (Exploded Parts List)

Recursively expand an assembly into all its component parts:

```tree
find exploded-parts
  take assembly-id, like u64
  nest parts
    mesh union
      find a
        base component
        send part-id, read self/child-id
        send quantity, read self/quantity
        send depth, 1
        hold is-equal
          bind a, read self/parent-id
          bind b, read assembly-id
      find b
        base component
        bond parts
          hold is-equal
            bind a, read component/parent-id
            bind b, read b/part-id
        send part-id, read component/child-id
        send quantity
          call multiply
            bind a, read b/quantity
            bind b, read component/quantity
        send depth
          call add
            bind a, read b/depth
            bind b, 1

  bond product
    hold is-equal
      bind a, read product/id
      bind b, read parts/part-id

  send part-name, read product/name
  send total-quantity, read parts/quantity
  send depth, read parts/depth

  sort rise, name depth
  sort rise, name part-name
```

```sql
WITH RECURSIVE parts AS (
  SELECT child_id AS part_id, quantity, 1 AS depth
  FROM component
  WHERE parent_id = $1
  UNION ALL
  SELECT c.child_id, p.quantity * c.quantity, p.depth + 1
  FROM component c
  JOIN parts p ON c.parent_id = p.part_id
)
SELECT pr.name AS part_name, p.total_quantity, p.depth
FROM parts p
JOIN product pr ON pr.id = p.part_id
ORDER BY depth ASC, part_name ASC
```

## Keyword Summary

| Keyword | Purpose | SQL equivalent |
| --- | --- | --- |
| `find <name>` | Define a named query | (query name) |
| `take <name>` | Query parameter | `$1`, `$2`, etc. |
| `base <table>` | Source table | `FROM` |
| `send <column>` | Select column | `SELECT` |
| `send <name>, name <alias>` | Alias column | `AS` |
| `hold <predicate>` | Filter condition | `WHERE` / `HAVING` |
| `miss` | Negate condition | `NOT` |
| `meet and` | All conditions must match | `AND` |
| `meet or` | Any condition can match | `OR` |
| `bond <table>` | Inner join | `JOIN` |
| `bond <table>, like left` | Left join | `LEFT JOIN` |
| `sort rise, name <col>` | Order ascending | `ORDER BY ... ASC` |
| `sort fall, name <col>` | Order descending | `ORDER BY ... DESC` |
| `size <n>` | Limit results | `LIMIT` |
| `bind offset` | Offset results | `OFFSET` |
| `fold <column>` | Group by | `GROUP BY` |
| `sift <column>` | Eliminate duplicates | `DISTINCT` |
| `hold is-present` | Correlated subquery exists | `EXISTS` |
| `hold is-missing` | Correlated subquery not exists | `NOT EXISTS` |
| `mesh union` | Combine and deduplicate | `UNION` |
| `mesh union-all` | Combine keeping duplicates | `UNION ALL` |
| `mesh intersect` | Keep common rows | `INTERSECT` |
| `mesh except` | Subtract rows | `EXCEPT` |
| `fork case` | Conditional expression | `CASE WHEN ... END` |
| `over` | Window frame | `OVER (...)` |
| `load` | Common table expression | `WITH ... AS` |
| `nest <term>` | Recursive CTE | `WITH RECURSIVE ... AS` |
| `call sum` | Sum aggregate | `SUM()` |
| `call count` | Count aggregate | `COUNT()` |
| `call count-distinct` | Count unique values | `COUNT(DISTINCT ...)` |
| `call average` | Average aggregate | `AVG()` |
| `call row-number` | Row numbering | `ROW_NUMBER()` |
| `call lag` | Previous row value | `LAG()` |
| `call lead` | Next row value | `LEAD()` |
| `call is-equal` | Equality check | `=` |
| `call is-above` | Greater than | `>` |
| `call is-below` | Less than | `<` |
| `call is-minimum` | Greater than or equal | `>=` |
| `call is-maximum` | Less than or equal | `<=` |
| `call is-missing` | Null check | `IS NULL` |
| `call is-present` | Not null check | `IS NOT NULL` |
| `call has-match` | Pattern match | `LIKE` |
| `call has-item` | Membership test | `IN` |
