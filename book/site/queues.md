# Queues (`seed queue`)

Declare job queues, workers, and pub/sub channels. Queues handle
background processing with retry logic, dead letter routing, and
priority ordering.

## Basic Queue

Define a queue with `seed queue`. Add a worker task to process jobs.

```tree
seed queue, name email-queue
  seed workers, mark 3

task process-email
  seed queue, text <email-queue>
  take job, like hash
    link to, like text
    link subject, like text
    link template, like text

  call send-email
    bind to, read job/to
    bind subject, read job/subject
    bind template, read job/template
    halt kink
```

Enqueue a job from a route handler:

```tree
dock /users
  task post
    take body
      like hash
        link name, like text
        link email, like text

    save user
      call make-user
        bind name, read name
        bind email, read email

    call enqueue
      bind queue, text <email-queue>
      bind data
        make job
          bind to, read user/email
          bind subject, text <Welcome>
          bind template, text <welcome>

    send json
      seed code, mark 201
      read user
```

## Worker with Retry

Configure retry behavior with `seed retry`. Set `seed max` for
maximum attempts and `seed delay` for backoff in milliseconds.

```tree
seed queue, name payment-queue
  seed workers, mark 5
  seed retry
    seed max, mark 3
    seed delay, mark 1000
    seed backoff, text <exponential>

task process-payment
  seed queue, text <payment-queue>
  take job, like hash
    link order-id, like text
    link amount, like u32
    link method, like text

  call charge-payment
    bind order-id, read job/order-id
    bind amount, read job/amount
    bind method, read job/method
    halt kink

  call update-order-status
    bind order-id, read job/order-id
    bind status, text <paid>
```

## Priority Queue

Assign priority levels to jobs. Lower numbers run first.

```tree
seed queue, name task-queue
  seed workers, mark 4
  seed priority, wave true

task process-task
  seed queue, text <task-queue>
  take job, like hash
    link action, like text
    link data, like hash
    link priority, like u32

  fork case, read job/action
    case send-alert
      call send-alert
        bind data, read job/data
    case generate-report
      call generate-report
        bind data, read job/data
    case cleanup
      call run-cleanup
        bind data, read job/data
```

Enqueue with priority:

```tree
call enqueue
  bind queue, text <task-queue>
  bind priority, mark 1
  bind data
    make job
      bind action, text <send-alert>
      bind data
        make alert-data
          bind message, text <Critical error>
          bind level, text <high>

call enqueue
  bind queue, text <task-queue>
  bind priority, mark 10
  bind data
    make job
      bind action, text <cleanup>
      bind data
        make cleanup-data
          bind older-than, text <30d>
```

## Dead Letter Queue

Failed jobs that exceed retry limits go to a dead letter queue.
Configure with `seed dead-letter`.

```tree
seed queue, name import-queue
  seed workers, mark 2
  seed retry
    seed max, mark 5
    seed delay, mark 2000
    seed backoff, text <exponential>
  seed dead-letter, text <import-dlq>

seed queue, name import-dlq
  seed workers, mark 1

task process-import
  seed queue, text <import-queue>
  take job, like hash
    link file-url, like text
    link user-id, like text

  save data
    call download-file
      bind url, read job/file-url
      halt kink
  call parse-and-import
    bind data, read data
    bind user-id, read job/user-id
    halt kink

task process-import-dlq
  seed queue, text <import-dlq>
  take job, like hash
    link file-url, like text
    link user-id, like text
    link error, like text
    link attempts, like u32

  call notify-admin
    bind text
      call concat
        bind a, text <Import failed after >
        bind b
          call to-text
            bind value, read job/attempts
        bind c, text < attempts: >
        bind d, read job/error
  call mark-import-failed
    bind user-id, read job/user-id
    bind file-url, read job/file-url
```

## Delayed Jobs

Schedule jobs to run after a delay.

```tree
call enqueue
  bind queue, text <email-queue>
  bind delay, mark 300000
  bind data
    make job
      bind to, read user/email
      bind subject, text <Reminder>
      bind template, text <reminder>
```

## Scheduled Jobs (Cron)

Run jobs on a recurring schedule with `seed cron`.

```tree
seed queue, name cron-queue

task daily-cleanup
  seed queue, text <cron-queue>
  seed cron, text <0 0 * * *>

  call delete-expired-sessions
  call purge-old-logs
    bind older-than, text <30d>

task hourly-sync
  seed queue, text <cron-queue>
  seed cron, text <0 * * * *>

  save users
    call find-users-needing-sync
  walk list, read users
    hook next
      take site, name user
      call sync-user-data
        bind user-id, read user/id
        halt kink
```

## Pub/Sub Pattern

Publish events and subscribe multiple consumers. Use `seed topic`
for pub/sub channels separate from task queues.

```tree
seed topic, name user-events

task on-user-created
  seed subscribe, text <user-events>
  seed filter, text <user.created>
  take event, like hash
    link user-id, like text
    link email, like text

  call send-email
    bind name, text <welcome>
    bind to, read event/email
  call create-default-settings
    bind user-id, read event/user-id

task on-user-created-analytics
  seed subscribe, text <user-events>
  seed filter, text <user.created>
  take event, like hash
    link user-id, like text

  call track-signup
    bind user-id, read event/user-id
    bind timestamp, call now
```

Publish an event:

```tree
dock /users
  task post
    take body
      like hash
        link name, like text
        link email, like text

    save user
      call make-user
        bind name, read name
        bind email, read email

    call publish
      bind topic, text <user-events>
      bind event, text <user.created>
      bind data
        make event-data
          bind user-id, read user/id
          bind email, read user/email

    send json
      seed code, mark 201
      read user
```

## Batch Processing

Process jobs in batches for efficiency.

```tree
seed queue, name batch-queue
  seed workers, mark 2
  seed batch
    seed size, mark 100
    seed timeout, mark 5000

task process-batch
  seed queue, text <batch-queue>
  take jobs, like list

  save records
    call list-map
      bind list, read jobs
      bind task
        like task
          take item, like hash
          send back
            make record
              bind id, read item/id
              bind value, read item/value

  call bulk-insert
    bind records, read records
    halt kink
```

## Full Example

A complete queue system with multiple queues, retry, dead letters,
and pub/sub.

```tree
seed queue, name order-queue
  seed workers, mark 5
  seed retry
    seed max, mark 3
    seed delay, mark 1000
    seed backoff, text <exponential>
  seed dead-letter, text <order-dlq>

seed queue, name order-dlq
  seed workers, mark 1

seed queue, name notification-queue
  seed workers, mark 3
  seed retry
    seed max, mark 2
    seed delay, mark 500

seed topic, name order-events

task process-order
  seed queue, text <order-queue>
  take job, like hash
    link order-id, like text
    link items, like list
    link customer-id, like text

  call validate-inventory
    bind items, read job/items
    halt kink
  call charge-customer
    bind customer-id, read job/customer-id
    bind items, read job/items
    halt kink
  call fulfill-order
    bind order-id, read job/order-id
    halt kink

  call publish
    bind topic, text <order-events>
    bind event, text <order.completed>
    bind data
      make event-data
        bind order-id, read job/order-id
        bind customer-id, read job/customer-id

task on-order-completed
  seed subscribe, text <order-events>
  seed filter, text <order.completed>
  take event, like hash
    link order-id, like text
    link customer-id, like text

  call enqueue
    bind queue, text <notification-queue>
    bind data
      make job
        bind to, read event/customer-id
        bind template, text <order-complete>
        bind order-id, read event/order-id

task process-order-dlq
  seed queue, text <order-dlq>
  take job, like hash

  call notify-admin
    bind text, text <Order processing failed>
    bind data, read job
  call refund-customer
    bind order-id, read job/order-id
    halt kink
```

## Feature Summary

| Feature | Syntax | Example |
|---|---|---|
| Queue definition | `seed queue, name x` | `seed queue, name email-queue` |
| Worker count | `seed workers` | `seed workers, mark 5` |
| Worker task | `seed queue, text <x>` on task | `seed queue, text <email-queue>` |
| Retry config | `seed retry` | `seed max, mark 3` |
| Retry delay | `seed delay` | `seed delay, mark 1000` |
| Backoff strategy | `seed backoff` | `seed backoff, text <exponential>` |
| Dead letter queue | `seed dead-letter` | `seed dead-letter, text <dlq>` |
| Priority | `seed priority` | `seed priority, wave true` |
| Enqueue job | `call enqueue` | `bind queue, text <x>` |
| Delayed job | `bind delay` on enqueue | `bind delay, mark 300000` |
| Cron schedule | `seed cron` | `seed cron, text <0 * * * *>` |
| Pub/sub topic | `seed topic, name x` | `seed topic, name events` |
| Subscribe | `seed subscribe` | `seed subscribe, text <events>` |
| Event filter | `seed filter` | `seed filter, text <user.created>` |
| Publish event | `call publish` | `bind topic, text <events>` |
| Batch processing | `seed batch` | `seed size, mark 100` |
