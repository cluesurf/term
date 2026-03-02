# Term CLI

This is the first prototype of the CLI tool for base.

## Future Commands

```bash
# link local repo to global dependency store
term link deck
term link
# link globally linked dependency to local project
term link deck @foo/bar
term link @foo/bar
# remove a symlink
term toss deck link <deck>
term toss link <deck>
# run project tests
term test deck
term test
# install defined packages
term load deck
term load
# install defined decks without dev(work)/test
term load deck --like base
# install packages
term save deck @foo/bar
term save @foo/bar
# install packages globally
term save deck <deck> --slot base
# check if decks are installed
term seek
# create a new package
term cast deck
term cast
# build/compile the package
term make deck
term make
# watch the directory and recompile
term make --ride
# start a repl for the current deck
term walk deck
term walk
# apply configuration like terraform
term bind deck
term bind
# create a user account
term cast mind
# update user profile property
term save mind <name> <value>
# read user profile data
term read mind
# read user profile value
term read mind <name>
# create an org/namespace
term cast host
# update host profile property
term save host <name> <value>
# change the default registry from base.link to something else
term save hold <url>
# change the org registry
term save hold <host> <url>
# login
term dock mind
# logout
term void mind
# publish a package
term host deck
term host
# bump patch version
term move mark 3
term move mark
# bump minor version
term move mark 2
# bump major version
term move mark 1
# show dependency tree
term show deck tree
# run the code
term boot deck
term boot
# clean artifacts
term wash deck
# make documentation, hosted in ./hint/code
term make code book
# generate markdown from book
term make book --like md
term make book
# generate pdf from book
term make book --like pdf
# remove package from manifest
term toss deck <deck>
term toss <deck>
# add owner to package
term link deck mind <mind>
# remove owner
term toss deck mind <mind>
# show info about this deck
term note deck
# show info about a deck
term note deck <deck>
term note <deck>
# show info and problems about current deck
# shows TODOs as well, and stats.
term note
# show file sizes
term note deck file size
term note file size
term note size
# list outdated decks
term diff deck
# see if module is outdated
term diff deck <deck>
# term version
term show mark
# show basic information about term and operating system for debugging help
term show
# show intro helper menu
base
# show source location of deck
term show deck link
# open deck in editor
term show deck <deck>
# execute an arbitrary task
term <name>
# execute arbitrary task from another repo
term <name> <deck>
# run the make command of another repo
term make @foo/bar
# deprecate a deck version
term void deck my-thing@"< 0.2.3" "critical bug fixed in v0.2.3"
# switch to a different version of base
term move self <version>
# set the default version to use
term bind self <version>
# install the latest term itself
term save self
# install a specific version of term itself
term save self <version>
# check if the term has a new version
term diff self
# list installed versions of base
term list self
# where term is located itself, and other things
term show self
# start development server
term work
# plan a terraform configuration
term brew site
term brew
# read config value
term read <name>
# terraform bind
term bind site
# load db console
term bind base
# create Database
term make base
# drop database
term toss base
# load seed data
term seed base
# clear logs
term wash tail
# run migrations
term bind term head
term bind base
# rollback migrations
term bind term back
# generate UI component
term make dock
# custom commands
term call <command>
```

Since you can add your own commands to `base`, the convention is:

```bash
term <verb> <...objects> <...options>
```

```bash
term test view
```

## Generic Options

All commands can take these options:

| short | long     | description                      | takes                  | default               |
| :---- | :------- | :------------------------------- | :--------------------- | :-------------------- |
| `-h`  | `--hint` | help menu                        |                        |                       |
| `-b`  | `--back` | what to send back in the command | `json`, `link`, `line` | `line` (command line) |

## User Profile Settings

The `hook` is a slug, and can only contain `[a-z-]`.

| property | value                     |
| :------- | :------------------------ |
| hook     | example                   |
| name     | Example User              |
| email    | me@example.com (verified) |
| mfa      | yes/no                    |
| homepage |                           |
| freenode |                           |
| discord  |                           |
| x        |                           |
| github   |                           |
| created  | 2015-02-26T01:38:35.892Z  |
| updated  | 2017-10-02T21:29:45.922Z  |

## Host Profile Settings

| property | value                       |
| :------- | :-------------------------- |
| hook     | example                     |
| name     | Example Host                |
| email    | team@example.com (verified) |
| status   | unverified                  |
| homepage |                             |
| twitter  |                             |
| github   |                             |
| vercel   |                             |
| created  | 2015-02-26T01:38:35.892Z    |
| updated  | 2017-10-02T21:29:45.922Z    |

## JS2Tree

- https://github.com/lancejpollard/normalize-ast.js
- https://github.com/lancejpollard/js2link.js
