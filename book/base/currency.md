# Currency (`seed currency`)

Currency in Seed handles money values with precision. Define currencies
with `seed currency`, create money values with `make money`, and format
for display. All arithmetic uses fixed-point to avoid floating-point
rounding errors.

## Currency Definition

Define a currency with its code, symbol, and decimal places.

```tree
seed currency
  seed code, <USD>
  seed symbol, <$>
  seed decimals, mark 2

seed currency
  seed code, <JPY>
  seed symbol, <>
  seed decimals, mark 0

seed currency
  seed code, <BTC>
  seed symbol, <>
  seed decimals, mark 8
```

**`seed code`** is the ISO 4217 code (or custom for crypto).
**`seed symbol`** is the display symbol.
**`seed decimals`** sets precision.

## Creating Money Values

Create money with `make money`.

```tree
save price, make money
  bind amount, mark 1999
  bind currency, <USD>

save tip, make money
  bind amount, mark 500
  bind currency, <USD>

save yen-price, make money
  bind amount, mark 15000
  bind currency, <JPY>
```

**Amounts are in smallest unit.** For USD, `mark 1999` means $19.99.
For JPY, `mark 15000` means 15,000 yen. This avoids floating-point
issues entirely.

## Money Arithmetic

Add, subtract, and multiply money values.

```tree
task calculate-total
  take subtotal, like money
  take tax-rate, like f64

  save tax, call multiply-money
    bind value, read subtotal
    bind factor, read tax-rate

  save total, call add-money
    bind a, read subtotal
    bind b, read tax

  send back, read total
```

```tree
task split-bill
  take total, like money
  take people, like u32

  save share, call divide-money
    bind value, read total
    bind divisor, read people

  send back, read share
```

**`call add-money`** and **`call subtract-money`** require matching
currencies. Mismatched currencies raise an error at runtime.

**`call multiply-money`** scales by a factor.
**`call divide-money`** splits with proper rounding.

## Formatting Money

Format money for display with `call format-money`.

```tree
task show-price
  take price, like money

  save display, call format-money
    bind value, read price
    bind locale, <en-US>

  show read display
```

Output: `$19.99` for USD, `15,000` for JPY.

```tree
task show-detailed
  take price, like money

  save display, call format-money
    bind value, read price
    bind locale, <de-DE>
    bind show-code, wave true

  show read display
```

Output: `19,99 USD` for German locale with code display.

## Exchange Conversion

Convert between currencies with an exchange rate.

```tree
task convert-to-eur
  take usd-amount, like money
  take rate, like f64

  save eur, call convert-money
    bind value, read usd-amount
    bind to, <EUR>
    bind rate, read rate

  send back, read eur
```

```tree
task price-in-currencies
  take base-price, like money
  take rates, like map
    like text
    like f64

  save results, make list
    like money

  walk list, read rates
    hook next
      take site, name entry
      save converted, call convert-money
        bind value, read base-price
        bind to, read entry/key
        bind rate, read entry/value
      call push
        bind list, read results
        bind value, read converted

  send back, read results
```

**`call convert-money`** creates a new money value in the target
currency. The rate is a simple multiplier. Rounding follows the
target currency's decimal setting.

## Comparison

Compare money values with standard predicates.

```tree
task is-affordable
  take price, like money
  take budget, like money

  save within-budget, call is-maximum
    bind a, read budget
    bind b, read price

  send back, read within-budget
```

**`is-above`** means amount a is more than b.
**`is-maximum`** means a is greater than or equal to b.
Both require matching currencies.

## Keyword Reference

| Keyword | Purpose |
|---------|---------|
| `seed currency` | Define a currency type |
| `seed code` | ISO 4217 currency code |
| `seed symbol` | Display symbol |
| `seed decimals` | Number of decimal places |
| `make money` | Create a money value |
| `bind amount` | Set amount in smallest unit |
| `bind currency` | Set currency code |
| `call add-money` | Add two money values |
| `call subtract-money` | Subtract money values |
| `call multiply-money` | Scale by a factor |
| `call divide-money` | Divide with rounding |
| `call format-money` | Format for display |
| `call convert-money` | Convert between currencies |
| `bind locale` | Set display locale |
| `bind show-code` | Show currency code in output |
| `bind rate` | Exchange rate multiplier |
