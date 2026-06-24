# Dates and durations

Term's date and time types are pure integer arithmetic, so they give the identical answer on every backend. There are two types. A **plain-date** is a calendar date (year, month, day) with no time zone. A **duration** is a span of elapsed time, held as a whole number of nanoseconds.

Maps to: `java.time.LocalDate` plus `java.time.Duration`, or the `temporal` proposal's `PlainDate` plus `Duration`.

## Cheatsheet

### plain-date

A `plain-date` form with three fields and methods that read or shift it.

| Name | Kind | Does |
| --- | --- | --- |
| `plain-date` | form | fields `year`, `month` (1-12), `day` (1-31) |
| `from-parts` | task | build a date from year, month, day |
| `to-day-number` | method | days since the 1970-01-01 epoch |
| `from-day-number` | task | the inverse: a date from an epoch day count |
| `day-of-week` | method | 0 (Sunday) through 6 (Saturday) |
| `add-days` | method | shift by a whole number of days (may be negative) |
| `is-leap-year` | task | whether a year has 366 days |
| `days-in-month` | task | the length of a given month in a given year |

### duration

A `duration` form over a nanosecond count, with `from-*` builders, `to-*` readers, and combiners.

| Name | Kind | Does |
| --- | --- | --- |
| `from-nanoseconds` / `from-milliseconds` / `from-seconds` / `from-minutes` / `from-hours` / `from-days` | task | build a span from a unit count |
| `to-nanoseconds` / `to-milliseconds` / `to-seconds` / `to-minutes` / `to-hours` / `to-days` | method | read the span back in a coarser unit (truncating) |
| `plus` | method | add two spans |
| `minus` | method | subtract two spans |
| `negate` | method | flip the sign |
| `absolute` | method | the magnitude, dropping the sign |
| `is-zero` | method | whether the span is empty |

The combiners are named `plus` and `minus` rather than `add` and `subtract`, because `add` and `subtract` are the `number` arithmetic primitives.

## Building a date

```tree
load @cluesurf/base/code/plain-date
  find plain-date
  find from-parts

# new year's day, 2026
host new-year
  call from-parts
    code 2026
    code 1
    code 1
```

`from-parts` takes the three components in order. The result is an ordinary `plain-date` value, so you can read its fields with `/`.

```tree
call write-line
  read new-year/year       # 2026
```

## Date arithmetic

Shift a date by a number of days with `add-days`. A negative count moves backward. The math runs through the epoch day-number, so it crosses month and year boundaries correctly.

```tree
# the day after new year
host next-day
  call add-days
    read new-year
    code 1

# a week earlier
host last-week
  call add-days
    read new-year
    call subtract
      code 0
      code 7
```

To find the number of days between two dates, take the difference of their epoch day-numbers.

```tree
task days-between
  take start, like plain-date
  take finish, like plain-date
  like number
  send back
    call subtract
      call to-day-number
        read finish
      call to-day-number
        read start
```

## Day of the week and calendar facts

```tree
host weekday
  call day-of-week
    read new-year        # 0 = Sunday ... 6 = Saturday

host leap
  call is-leap-year
    code 2028            # true

host february-length
  call days-in-month
    code 2028
    code 2               # 29
```

## Durations

Build a span from any unit, combine spans, and read the result back in whatever unit you want. Reading down to a coarser unit truncates.

```tree
load @cluesurf/base/code/duration
  find duration
  find from-hours
  find from-minutes

# eight and a half hours
host shift
  call plus
    call from-hours
      code 8
    call from-minutes
      code 30

host as-minutes
  call to-minutes
    read shift            # 510
```

`minus`, `negate`, and `absolute` compose spans the same way.

```tree
task time-left
  take total, like duration
  take spent, like duration
  like duration
  send back
    call absolute
      call minus
        read total
        read spent
```

## Why integers

Both types avoid floating point on purpose. A `plain-date` converts to and from an epoch day-number with exact integer (floor) division, and a `duration` is a single nanosecond count. The result is that the same program produces the same answer whether it runs on Rust, the JVM, Swift, or in a browser. There is no platform clock skew and no rounding drift.

Time zones, wall-clock times, and a live system clock are a layer above these two pure types. See the [standard library overview](readme.md) for the clock module.
