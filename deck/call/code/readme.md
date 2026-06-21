# Term CLI

This is the first prototype of the CLI tool for base.

## Future Commands

```bash
# link local repo to global dependency store
seed link deck
seed link
# link globally linked dependency to local project
seed link deck @foo/bar
seed link @foo/bar
# remove a symlink
seed toss deck link <deck>
seed toss link <deck>
# run project tests
seed test deck
seed test
# install defined packages
seed load deck
seed load
# install defined decks without dev(work)/test
seed load deck --like base
# install packages
seed save deck @foo/bar
seed save @foo/bar
# install packages globally
seed save deck <deck> --slot base
# check if decks are installed
seed seek
# create a new package
seed cast deck
seed cast
# build/compile the package
seed make deck
seed make
# watch the directory and recompile
seed make --ride
# start a repl for the current deck
seed walk deck
seed walk
# apply configuration like terraform
seed bind deck
seed bind
# create a user account
seed cast mind
# update user profile property
seed save mind <name> <value>
# read user profile data
seed read mind
# read user profile value
seed read mind <name>
# create an org/namespace
seed cast host
# update host profile property
seed save host <name> <value>
# change the default registry from base.link to something else
seed save hold <url>
# change the org registry
seed save hold <host> <url>
# login
seed dock mind
# logout
seed void mind
# publish a package
seed host deck
seed host
# bump patch version
seed move mark 3
seed move mark
# bump minor version
seed move mark 2
# bump major version
seed move mark 1
# show dependency tree
seed show deck tree
# run the code
seed boot deck
seed boot
# clean artifacts
seed wash deck
# make documentation, hosted in ./hint/code
seed make code book
# generate markdown from book
seed make book --like md
seed make book
# generate pdf from book
seed make book --like pdf
# remove package from manifest
seed toss deck <deck>
seed toss <deck>
# add owner to package
seed link deck mind <mind>
# remove owner
seed toss deck mind <mind>
# show info about this deck
seed note deck
# show info about a deck
seed note deck <deck>
seed note <deck>
# show info and problems about current deck
# shows TODOs as well, and stats.
seed note
# show file sizes
seed note deck file size
seed note file size
seed note size
# list outdated decks
seed diff deck
# see if module is outdated
seed diff deck <deck>
# term version
seed show mark
# show basic information about term and operating system for debugging help
seed show
# show intro helper menu
base
# show source location of deck
seed show deck link
# open deck in editor
seed show deck <deck>
# execute an arbitrary task
seed <name>
# execute arbitrary task from another repo
seed <name> <deck>
# run the make command of another repo
seed make @foo/bar
# deprecate a deck version
seed void deck my-thing@"< 0.2.3" "critical bug fixed in v0.2.3"
# switch to a different version of base
seed move self <version>
# set the default version to use
seed bind self <version>
# install the latest term itself
seed save self
# install a specific version of term itself
seed save self <version>
# check if the term has a new version
seed diff self
# list installed versions of base
seed list self
# where term is located itself, and other things
seed show self
# start development server
seed work
# plan a terraform configuration
seed brew site
seed brew
# read config value
seed read <name>
# terraform bind
seed bind site
# load db console
seed bind base
# create Database
seed make base
# drop database
seed toss base
# load seed data
seed seed base
# clear logs
seed wash tail
# run migrations
seed bind term head
seed bind base
# rollback migrations
seed bind term back
# generate UI component
seed make dock
# custom commands
seed call <command>
```

Since you can add your own commands to `base`, the convention is:

```bash
seed <verb> <...objects> <...options>
```

```bash
seed test view
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
