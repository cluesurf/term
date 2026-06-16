# Formatting (`call format-*`)

Formatting in Seed provides locale-aware display of numbers, byte
sizes, phone numbers, percentages, and custom patterns. All format
functions return text strings ready for display. Locale support follows
CLDR conventions.

## Number Formatting

Format numbers with locale-specific separators and precision.

```tree
save price, call format-number
  bind value, mark 1234567
  bind locale, <en-US>

show read price
```

Output: `1,234,567`

```tree
save euro-price, call format-number
  bind value, mark 1234567.89
  bind locale, <de-DE>
  bind precision, mark 2

show read euro-price
```

Output: `1.234.567,89`

**`bind locale`** controls separators and grouping.
**`bind precision`** sets decimal places.

### Compact Numbers

```tree
save followers, call format-number
  bind value, mark 1500000
  bind locale, <en-US>
  bind compact, wave true

show read followers
```

Output: `1.5M`

```tree
save views, call format-number
  bind value, mark 42300
  bind locale, <en-US>
  bind compact, wave true

show read views
```

Output: `42.3K`

## Byte Size Formatting

Format byte counts as human-readable sizes.

```tree
save small, call format-bytes
  bind value, mark 1024

show read small
```

Output: `1 KB`

```tree
save large, call format-bytes
  bind value, mark 1073741824
  bind precision, mark 2

show read large
```

Output: `1.00 GB`

```tree
save exact, call format-bytes
  bind value, mark 1536000
  bind binary, wave true
  bind precision, mark 1

show read exact
```

Output: `1.5 GiB`

**`bind binary`** switches between SI (KB = 1000) and binary
(KiB = 1024) units. Default is SI.

## Phone Number Formatting

Format phone numbers for display.

```tree
save us-phone, call format-phone
  bind value, <2125551234>
  bind country, <US>

show read us-phone
```

Output: `(212) 555-1234`

```tree
save uk-phone, call format-phone
  bind value, <442071234567>
  bind country, <GB>
  bind international, wave true

show read uk-phone
```

Output: `+44 20 7123 4567`

```tree
save raw, call format-phone
  bind value, <+81312345678>
  bind country, <JP>

show read raw
```

Output: `03-1234-5678`

**`bind country`** sets the country code for formatting rules.
**`bind international`** forces international format with country prefix.

## Percentage Formatting

Format decimal values as percentages.

```tree
save rate, call format-percent
  bind value, mark 0.156
  bind precision, mark 1

show read rate
```

Output: `15.6%`

```tree
save change, call format-percent
  bind value, mark -0.032
  bind precision, mark 2
  bind sign, wave true

show read change
```

Output: `-3.20%`

**`bind sign`** forces showing `+` for positive values.

```tree
save growth, call format-percent
  bind value, mark 0.5
  bind locale, <de-DE>

show read growth
```

Output: `50 %` (German locale uses space before percent sign).

## Ordinal Formatting

Format numbers as ordinals.

```tree
save first, call format-ordinal
  bind value, mark 1

save third, call format-ordinal
  bind value, mark 3

save twenty-second, call format-ordinal
  bind value, mark 22

show read first
show read third
show read twenty-second
```

Output: `1st`, `3rd`, `22nd`

## Padding and Alignment

Pad values to a fixed width.

```tree
save padded, call format-pad
  bind value, <42>
  bind width, mark 6
  bind fill, <0>
  bind align, <right>

show read padded
```

Output: `000042`

```tree
save label, call format-pad
  bind value, <hello>
  bind width, mark 10
  bind fill, < >
  bind align, <left>

show read label
```

Output: `hello     `

## Combining Formats

Build display strings by composing format calls.

```tree
task format-invoice-line
  take name, like text
  take quantity, like u32
  take price, like f64

  save qty, call format-number
    bind value, read quantity
    bind locale, <en-US>

  save cost, call format-number
    bind value, read price
    bind locale, <en-US>
    bind precision, mark 2

  save line, call join-text
    bind parts, make list
      like text
      call push
        bind value, read name
      call push
        bind value, <  x>
      call push
        bind value, read qty
      call push
        bind value, <  $>
      call push
        bind value, read cost

  send back, read line
```

## Keyword Reference

| Keyword | Purpose |
|---------|---------|
| `call format-number` | Format a number with locale rules |
| `call format-bytes` | Format byte count as human size |
| `call format-phone` | Format phone number for display |
| `call format-percent` | Format decimal as percentage |
| `call format-ordinal` | Format number as ordinal (1st, 2nd) |
| `call format-pad` | Pad a value to fixed width |
| `bind locale` | Set locale for formatting |
| `bind precision` | Set decimal places |
| `bind compact` | Use compact notation (1.5M) |
| `bind binary` | Use binary (KiB) vs SI (KB) units |
| `bind country` | Set country for phone formatting |
| `bind international` | Force international phone format |
| `bind sign` | Force sign display on positive values |
| `bind width` | Target width for padding |
| `bind fill` | Fill character for padding |
| `bind align` | Alignment direction (left, right, center) |
