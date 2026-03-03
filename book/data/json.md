# JSON in TermTree

```
load @cluesurf/moon/json
  find site # object
  find list # array

make site
  save key, <value>
  save key2
    make site
      save nested, <value>
  save list1
    make list
      save <foo>
      save <bar>
```
