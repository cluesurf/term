# Date and Time (`seed date-format`)

Date and time in Seed covers formatting, durations, time zones, and
arithmetic. Use `seed date-format` for display patterns, `make duration`
for time spans, and `make time` for specific moments. All dates are
timezone-aware by default.

## Date Formatting

Define reusable date format patterns with `seed date-format`.

```tree
seed date-format
  name short-date
  like <YYYY-MM-DD>

seed date-format
  name full-date
  like <MMMM D, YYYY>

seed date-format
  name timestamp
  like <YYYY-MM-DD HH:mm:ss>
```

**`like`** sets the format pattern. Standard tokens: `YYYY` (year),
`MM` (month), `DD` (day), `HH` (hour), `mm` (minute), `ss` (second).

Use a format in code:

```tree
task show-date
  take date, like time
  save formatted, call format-time
    bind value, read date
    bind format, <YYYY-MM-DD>
  show read formatted
```

## Duration Creation

Create time spans with `make duration`.

```tree
save timeout, make duration
  bind seconds, mark 30

save work-day, make duration
  bind hours, mark 8

save sprint, make duration
  bind days, mark 14

save long-pause, make duration
  bind hours, mark 2
  bind minutes, mark 30
```

Durations combine multiple units. They represent a fixed span
independent of calendar dates.

## Time Construction

Create specific moments with `make time`.

```tree
save now, call get-time

save deadline, make time
  bind year, mark 2026
  bind month, mark 12
  bind day, mark 31
  bind hours, mark 23
  bind minutes, mark 59
  bind zone, <UTC>

save morning, make time
  bind year, mark 2026
  bind month, mark 3
  bind day, mark 15
  bind hours, mark 9
  bind minutes, mark 0
  bind zone, <America/New_York>
```

**`bind zone`** sets the timezone using IANA timezone names.
All times store internally as UTC. The zone affects display only.

## Timezone Conversion

Convert between timezones with `call convert-zone`.

```tree
task show-meeting-times
  take meeting-time, like time

  save eastern, call convert-zone
    bind value, read meeting-time
    bind zone, <America/New_York>

  save pacific, call convert-zone
    bind value, read meeting-time
    bind zone, <America/Los_Angeles>

  save tokyo, call convert-zone
    bind value, read meeting-time
    bind zone, <Asia/Tokyo>
```

Conversion does not change the instant. It changes how the time
displays.

## Date Arithmetic

Add or subtract durations from times.

```tree
task schedule-reminder
  take event-time, like time

  save one-day, make duration
    bind days, mark 1

  save reminder, call subtract-time
    bind value, read event-time
    bind amount, read one-day

  save follow-up, call add-time
    bind value, read event-time
    bind amount, make duration
      bind hours, mark 2

  send back, make schedule
    bind reminder, read reminder
    bind follow-up, read follow-up
```

**`call add-time`** moves forward. **`call subtract-time`** moves
backward. Both take a time and a duration.

## Relative Time

Get human-readable relative time strings.

```tree
task show-relative
  take then, like time
  take now, like time

  save relative, call format-relative
    bind value, read then
    bind base, read now

  show read relative
```

Output: `3 hours ago`, `in 2 days`, `just now`.

## Comparing Times

Use standard comparison predicates.

```tree
task is-overdue
  take deadline, like time
  take now, like time

  save overdue, call is-above
    bind a, read now
    bind b, read deadline

  send back, read overdue
```

**`is-above`** means "a is after b" for times.
**`is-below`** means "a is before b".

## Difference Between Times

Calculate the span between two moments.

```tree
task time-until
  take start, like time
  take end, like time

  save diff, call diff-time
    bind a, read end
    bind b, read start

  save hours, call get-hours
    bind value, read diff

  send back, read hours
```

**`call diff-time`** returns a duration. Extract parts with
`get-hours`, `get-minutes`, `get-seconds`, `get-days`.

## Keyword Reference

| Keyword | Purpose |
|---------|---------|
| `seed date-format` | Define a named date format pattern |
| `make duration` | Create a time span |
| `make time` | Create a specific moment |
| `bind hours` | Set hours component |
| `bind minutes` | Set minutes component |
| `bind seconds` | Set seconds component |
| `bind days` | Set days component |
| `bind zone` | Set IANA timezone |
| `call format-time` | Format a time with a pattern |
| `call convert-zone` | Change display timezone |
| `call add-time` | Add duration to time |
| `call subtract-time` | Subtract duration from time |
| `call diff-time` | Get duration between two times |
| `call format-relative` | Get human-readable relative string |
| `call get-time` | Get current time |
