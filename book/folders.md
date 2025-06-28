# Folder Structure in TermTree

The "index" file for a folder is called `term.tree` (you'll notice many
of those in the repo already). This is how we name it, like `index.js`.
Then you can name files whatever you want so long as it's a lowercase
alphabetic, hyphen, or number character.

## Libraries

In libraries it is common to use this convention:

```
/bind # configuration
/code # main library code
/deck # custom packages
/hold # tmp folder
/line # executable
/link # dependencies
/make # output builds
/note # guides
/task # dev helpers
/test # tests
```

## Applications

In applications it is common to use this convention:

```
/back # backend
/bind # configuration
/book # guides
/deck # custom packages
/face # frontend
/file # public directory
/flow # logs
/hold # tmp folder
/hook # api
/host # shared
/line # command line processing
/link # dependencies
/make # output builds
/task # dev helpers
/test # tests
```

### Example Version

```
/back # backend
  /note # mailers
  /work # jobs
  /time # cron jobs
  /task # handle API calls
  /hook # REST and webhook handlers
/bind # configuration
  /lock.tree# commit this
  /role.tree
  /text.tree# copy
  /kink.tree# errors
  /form # schema
    /user
  /rule # policies/permissions
  /take.tree# query allowance
  /vibe.tree# global styles
  /base # database
    /seed # seeding data
    /move # migrations
  /site # infrastructure
    /hold.tree# don't commit this
    /move # migrations
  /host # env variables, don't commit
    /test.tree
    /term.tree
    /work.tree# dev
    /beat.tree# prod
/book # guides
/deck # custom packages
/face # frontend
  /dock # ui components
  /vibe # styles/themes
  /wall # pages
    /host
      /term.tree
      /case.tree
      /deck
        /term.tree
        /case.tree
  /text # copy
/file # public directory
  /text # fonts
  /view # images
/hook # api
  /take
  /save
  /task # queries
/line # command line processing
/link
  /hint.tree
  /head
  /tree
/make
  /javascript
    /browser
    /node
/flow # logs
  /work.tree# dev logs
  /test.tree# test logs
  /ride.tree# prod logs
/task # dev helpers
/test
/host # shared
  /tree
/term.tree # commit this
/hold # scratchpad/tmp folder
```
