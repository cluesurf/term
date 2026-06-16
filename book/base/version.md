# Versioning (`make version`)

Versioning in Seed handles semantic version values. Parse, compare,
bump, and check ranges. Versions follow the semver 2.0 spec with
support for pre-release tags and build metadata.

## Creating a Version

Create a version with `make version`.

```tree
save v, make version
  bind major, mark 2
  bind minor, mark 3
  bind patch, mark 4
```

This represents `2.3.4`.

Parse a version from a string:

```tree
save v, call parse-version
  bind value, <1.5.12>
```

**`call parse-version`** accepts standard semver strings. It returns
a version value with `major`, `minor`, and `patch` fields.

## Bumping Versions

Bump a version by kind with `call bump-version`.

```tree
save current, make version
  bind major, mark 1
  bind minor, mark 4
  bind patch, mark 2

save next-patch, call bump-version
  bind value, read current
  bind kind, <patch>

save next-minor, call bump-version
  bind value, read current
  bind kind, <minor>

save next-major, call bump-version
  bind value, read current
  bind kind, <major>
```

Results: `1.4.3`, `1.5.0`, `2.0.0`.

**`bind kind`** accepts `patch`, `minor`, or `major`.
Minor bump resets patch to 0. Major bump resets both minor and patch.

## Version Comparison

Compare versions with `call compare-version`.

```tree
save a, call parse-version
  bind value, <2.1.0>

save b, call parse-version
  bind value, <2.3.0>

save result, call compare-version
  bind a, read a
  bind b, read b
```

Returns `mark -1` if a < b, `mark 0` if equal, `mark 1` if a > b.

Use standard predicates for simple checks:

```tree
task is-newer
  take current, like version
  take minimum, like version

  save newer, call is-above
    bind a, read current
    bind b, read minimum

  send back, read newer
```

## Range Checking

Check if a version satisfies a range.

```tree
save v, call parse-version
  bind value, <1.5.3>

save in-range, call check-version-range
  bind value, read v
  bind range, <>=1.0.0 <2.0.0>

fork test
  hook test, read in-range
  hook hold
    show <version is compatible>
  hook miss
    show <version is out of range>
```

**`bind range`** supports semver range syntax:
- `>=1.0.0 <2.0.0` (explicit range)
- `^1.2.3` (compatible with, same major)
- `~1.2.3` (approximately, same minor)
- `1.2.x` (wildcard patch)

## Pre-release Tags

Create versions with pre-release identifiers.

```tree
save alpha, make version
  bind major, mark 2
  bind minor, mark 0
  bind patch, mark 0
  bind pre, <alpha.1>

save beta, make version
  bind major, mark 2
  bind minor, mark 0
  bind patch, mark 0
  bind pre, <beta.3>

save rc, make version
  bind major, mark 2
  bind minor, mark 0
  bind patch, mark 0
  bind pre, <rc.1>
```

Represents: `2.0.0-alpha.1`, `2.0.0-beta.3`, `2.0.0-rc.1`.

Pre-release versions sort before the release version.
`2.0.0-alpha.1 < 2.0.0-beta.3 < 2.0.0-rc.1 < 2.0.0`.

## Build Metadata

Add build metadata (ignored in comparisons).

```tree
save v, make version
  bind major, mark 1
  bind minor, mark 0
  bind patch, mark 0
  bind build, <20260312.abc123>
```

Represents: `1.0.0+20260312.abc123`.

**`bind build`** metadata is for informational purposes. It does not
affect version ordering.

## Formatting Versions

Convert a version to a display string.

```tree
save v, make version
  bind major, mark 3
  bind minor, mark 1
  bind patch, mark 0
  bind pre, <beta.2>

save text, call format-version
  bind value, read v

show read text
```

Output: `3.1.0-beta.2`

## Extracting Parts

Read individual version components.

```tree
task show-parts
  take v, like version

  show read v/major
  show read v/minor
  show read v/patch

  fork test
    hook test, read v/pre
    hook hold
      show read v/pre
```

## Keyword Reference

| Keyword | Purpose |
|---------|---------|
| `make version` | Create a version value |
| `bind major` | Major version number |
| `bind minor` | Minor version number |
| `bind patch` | Patch version number |
| `bind pre` | Pre-release tag |
| `bind build` | Build metadata |
| `bind kind` | Bump type (patch, minor, major) |
| `call parse-version` | Parse version from string |
| `call bump-version` | Increment version by kind |
| `call compare-version` | Compare two versions (-1, 0, 1) |
| `call check-version-range` | Test if version satisfies range |
| `call format-version` | Convert version to string |
| `bind range` | Semver range expression |
