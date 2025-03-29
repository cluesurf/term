## StarTree Hello World Example

You can do "log info" with the short show command.

    show <hello world>

To log, you would do:

    load @cluesurf/wolf
      find show

    call show
      text <hello world>
      term kink

Should print

    show <hello world>
      time <2023/07/10 04:32:01 pm utc>
      sort kink
      deck <@cluesurf/star>
      term process-tag

You also have:

    show dive # trace
    show hint # debug
    show show # info
    show tell # warning
    show kink # error
    show bust # critical

An error then shows as:

    kink <I'm an error>
      code 1234
