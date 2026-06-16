# Serialization (`seed wire`)

Serialization in Seed uses `seed wire` to define how forms map to
wire formats like JSON, msgpack, and protobuf. Each field gets a wire
name, type hint, and optional transform. This keeps your internal
naming clean while matching external API contracts.

## Basic JSON Mapping

Map form fields to camelCase JSON keys with `name`.

```tree
form user
  link first-name, like text
  link last-name, like text
  link email-address, like text

seed wire
  like json
  link first-name
    name <firstName>
  link last-name
    name <lastName>
  link email-address
    name <emailAddress>
```

**`name`** sets the wire-format key. Without it, the field name is
used as-is in kebab-case.

## Msgpack Binary Format

Msgpack uses integer keys for compact binary encoding.

```tree
form sensor-reading
  link device-id, like text
  link temperature, like f64
  link timestamp, like u64

seed wire
  like msgpack
  link device-id
    name mark 1
  link temperature
    name mark 2
  link timestamp
    name mark 3
```

Integer keys reduce payload size. Good for high-throughput streams
and IoT data.

## Custom Serializer with `mill`

Apply transforms during serialization and deserialization.

```tree
form event
  link id, like text
  link created-at, like timestamp
  link tags, like list
    like text

seed wire
  like json
  link id
    name <id>
  link created-at
    name <createdAt>
    mill timestamp-to-iso
  link tags
    name <tags>
    mill comma-split
```

**`mill`** references a named transform. `timestamp-to-iso` converts
timestamps to ISO 8601 strings on output and parses them on input.
`comma-split` converts between arrays and comma-separated strings.

## Nested Objects

Map nested forms with inline `seed wire` blocks.

```tree
form order
  link id, like text
  link customer, like customer
  link items, like list
    like order-item

form customer
  link full-name, like text
  link phone, like text

form order-item
  link product-id, like text
  link quantity, like u32
  link unit-price, like f64

seed wire
  like json
  link id
    name <orderId>
  link customer
    name <customer>
    seed wire
      link full-name
        name <fullName>
      link phone
        name <phone>
  link items
    name <lineItems>
    seed wire
      link product-id
        name <productId>
      link quantity
        name <qty>
      link unit-price
        name <unitPrice>
```

Nested `seed wire` blocks define the mapping for child objects.
Array items use the same nested mapping.

## Protobuf Field Numbers

Protobuf uses integer field numbers like msgpack.

```tree
form log-entry
  link level, like u8
  link message, like text
  link source, like text
  link trace-id, like text
    need false

seed wire
  like protobuf
  link level
    name mark 1
  link message
    name mark 2
  link source
    name mark 3
  link trace-id
    name mark 4
```

## Multi-Format Support

A single form can have multiple wire mappings.

```tree
form metric
  link name, like text
  link value, like f64
  link unit, like text

seed wire
  like json
  link name
    name <metricName>
  link value
    name <metricValue>
  link unit
    name <unit>

seed wire
  like msgpack
  link name
    name mark 1
  link value
    name mark 2
  link unit
    name mark 3
```

The runtime picks the right mapping based on content type.

## Keyword Reference

| Keyword | Purpose |
|---------|---------|
| `seed wire` | Declare a serialization mapping block |
| `like json` | Target JSON format |
| `like msgpack` | Target msgpack binary format |
| `like protobuf` | Target protobuf format |
| `link` | Reference a form field to map |
| `name` | Set the wire-format key (text for JSON, integer for binary) |
| `mill` | Apply a named transform during serialize/deserialize |
| `need false` | Mark a field as optional in the wire format |

## Composition with Validation

Combine `seed wire` with `mill` validation to enforce constraints
on deserialized data.

```tree
form signup-request
  link username, like text
  link email, like text
  link age, like u32

seed wire
  like json
  link username
    name <username>
  link email
    name <email>
  link age
    name <age>

mill signup-request
  link username, like text
    need true
    bind min, mark 3
    bind max, mark 20
  link email, like text
    need true
  link age, like u32
    bind min, mark 13
    bind max, mark 150
```

Wire mapping handles naming. Mill handles validation. They work
together but stay separate.
