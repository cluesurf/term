# Units (`make measure`)

Units in Seed handle physical measurements with type-safe conversions.
Create measurements with `make measure`, convert between units with
`call convert-unit`, and define custom units. The system prevents
mixing incompatible dimensions at compile time.

## Creating Measurements

Create a measurement with `make measure`.

```tree
save height, make measure
  bind value, mark 180
  bind unit, <cm>

save weight, make measure
  bind value, mark 75
  bind unit, <kg>

save temp, make measure
  bind value, mark 72
  bind unit, <fahrenheit>
```

**`bind value`** is the numeric amount.
**`bind unit`** is the unit identifier.

## Unit Conversion

Convert between compatible units with `call convert-unit`.

```tree
task feet-to-meters
  take length, like measure

  save result, call convert-unit
    bind value, read length
    bind to, <m>

  send back, read result
```

```tree
task temperature-convert
  save body-temp, make measure
    bind value, mark 98.6
    bind unit, <fahrenheit>

  save celsius, call convert-unit
    bind value, read body-temp
    bind to, <celsius>

  save kelvin, call convert-unit
    bind value, read body-temp
    bind to, <kelvin>
```

**`call convert-unit`** returns a new measure in the target unit.
Converting between incompatible dimensions (length to weight) raises
a compile-time error.

## Built-in Unit Categories

### Length

```tree
save a, make measure
  bind value, mark 1
  bind unit, <km>

save b, call convert-unit
  bind value, read a
  bind to, <mi>

save c, call convert-unit
  bind value, read a
  bind to, <m>

save d, call convert-unit
  bind value, read a
  bind to, <ft>
```

Supported: `mm`, `cm`, `m`, `km`, `in`, `ft`, `yd`, `mi`.

### Weight

```tree
save a, make measure
  bind value, mark 1
  bind unit, <kg>

save b, call convert-unit
  bind value, read a
  bind to, <lb>

save c, call convert-unit
  bind value, read a
  bind to, <g>

save d, call convert-unit
  bind value, read a
  bind to, <oz>
```

Supported: `mg`, `g`, `kg`, `lb`, `oz`, `ton`.

### Temperature

```tree
save boiling, make measure
  bind value, mark 100
  bind unit, <celsius>

save f, call convert-unit
  bind value, read boiling
  bind to, <fahrenheit>

save k, call convert-unit
  bind value, read boiling
  bind to, <kelvin>
```

Supported: `celsius`, `fahrenheit`, `kelvin`.

### Volume

Supported: `ml`, `l`, `gal`, `qt`, `pt`, `cup`, `fl-oz`.

### Data Size

Supported: `b`, `kb`, `mb`, `gb`, `tb`, `pb`.

## Compound Units

Express rates and compound measurements.

```tree
save speed, make measure
  bind value, mark 60
  bind unit, <mi/h>

save density, make measure
  bind value, mark 1000
  bind unit, <kg/m3>

save flow, make measure
  bind value, mark 5
  bind unit, <l/min>
```

Compound units use `/` to separate numerator and denominator.

Convert compound units:

```tree
save mph, make measure
  bind value, mark 60
  bind unit, <mi/h>

save kph, call convert-unit
  bind value, read mph
  bind to, <km/h>
```

## Arithmetic with Measures

Add and subtract compatible measurements.

```tree
task total-length
  take a, like measure
  take b, like measure

  save total, call add-measure
    bind a, read a
    bind b, read b

  send back, read total
```

```tree
task scale-recipe
  take flour, like measure
  take factor, like f64

  save scaled, call multiply-measure
    bind value, read flour
    bind factor, read factor

  send back, read scaled
```

**`call add-measure`** auto-converts to the first operand's unit.
**`call multiply-measure`** scales the value, keeps the unit.

## Custom Unit Definitions

Define project-specific units.

```tree
seed unit
  name <story-point>
  seed dimension, <effort>

seed unit
  name <pixel>
  seed dimension, <length>
  seed ratio, mark 1
  seed base, <px>

seed unit
  name <rem>
  seed dimension, <length>
  seed ratio, mark 16
  seed base, <px>
```

**`seed dimension`** groups compatible units.
**`seed ratio`** and **`seed base`** define how to convert to the
base unit of that dimension.

## Keyword Reference

| Keyword | Purpose |
|---------|---------|
| `make measure` | Create a measurement value |
| `bind value` | Set numeric amount |
| `bind unit` | Set unit identifier |
| `call convert-unit` | Convert to a different unit |
| `bind to` | Target unit for conversion |
| `bind from` | Source unit (when explicit) |
| `call add-measure` | Add two measurements |
| `call subtract-measure` | Subtract measurements |
| `call multiply-measure` | Scale by a factor |
| `seed unit` | Define a custom unit |
| `seed dimension` | Unit dimension category |
| `seed ratio` | Conversion ratio to base unit |
| `seed base` | Base unit for conversions |
