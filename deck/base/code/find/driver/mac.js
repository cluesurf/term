// The find driver for macOS (spec section 9 and 10.1): JXA, run as `osascript -l JavaScript <this file>`. One JSON
// request per line on standard input, one answer per line on standard output, matched by `id`. It stops when standard
// input closes.
//
// For now it answers for the `iterm` tool only: the sessions of iTerm2 as `pane`s, found by their `name` (the `title`
// property), typed into with iTerm2's `write` (AppleScript's `write text`). A handle is the session's unique id.
//
// Nothing in a request is ever evaluated: a line is parsed as DATA, every test and every text is compared or passed on
// as a string argument to an Apple event, and no script source is built from one (decision 002). The one place text is
// composed is the `plan` answer, which is printed for a person and never run.
//
// Consent (research/native-lowering.md section 1): Apple Events to iTerm2 need Automation consent for the process that
// runs this file. Without it every op that reaches iTerm2 answers
// `{"ok":false,"error":{"kind":"denied","need":"automation iTerm2"}}`.
ObjC.import('Foundation')
ObjC.import('AppKit')

var TOOL = 'iterm'
var BUNDLE = 'com.googlecode.iterm2'
var PARTS = ['base', 'link', 'have', 'lack']

// an error that goes back to the engine as `{kind, detail}`
function refusal(kind, detail, need) {
  var error = { kind: kind, detail: detail }

  if (need) {
    error.need = need
  }

  return error
}

// whether iTerm2 is running: asked of the system, never by addressing the app, which would start it
function running() {
  return Number($.NSRunningApplication.runningApplicationsWithBundleIdentifier(BUNDLE).count) > 0
}

// a failed Apple event, as the error to answer
function nativeError(cause) {
  var text = String(cause && cause.message ? cause.message : cause)

  if (text.indexOf('-1743') >= 0 || text.indexOf('Not authorized') >= 0) {
    return refusal(
      'denied',
      'allow it in System Settings > Privacy & Security > Automation, for the app running this driver, under iTerm2',
      'automation iTerm2',
    )
  }

  return refusal('native', text)
}

// every session of iTerm2 in order, each `{id, name}`
function sessions() {
  var out = []
  var seen = {}

  if (!running()) {
    return out
  }

  var app = Application('iTerm2')
  var windows = app.windows() || []

  for (var w = 0; w < windows.length; w++) {
    var tabs = windows[w].tabs() || []

    for (var t = 0; t < tabs.length; t++) {
      var all = tabs[t].sessions
      var ids = all.id() || []
      var names = all.name() || []

      for (var s = 0; s < ids.length; s++) {
        // a window that changed place during the walk can show twice: a session counts once
        if (!seen[ids[s]]) {
          seen[ids[s]] = true
          out.push({ id: ids[s], name: names[s] })
        }
      }
    }
  }

  return out
}

// the live session object of an id, or undefined when it is gone
function sessionOf(id) {
  if (!running()) {
    return undefined
  }

  // one walk holds the objects and their ids together: the order of windows follows the focus, so an index taken from
  // an earlier walk can name another window by now
  var windows = Application('iTerm2').windows() || []

  for (var w = 0; w < windows.length; w++) {
    var tabs = windows[w].tabs() || []

    for (var t = 0; t < tabs.length; t++) {
      var live = tabs[t].sessions() || []

      for (var s = 0; s < live.length; s++) {
        if (live[s].id() === id) {
          return live[s]
        }
      }
    }
  }

  return undefined
}

function same(a, b) {
  return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b)
}

// the value of a property of a session. Only `title` is read here, as the session's `name`
function propertyOf(one, name) {
  if (name === 'title') {
    return one.name
  }

  throw refusal('cannot', 'iterm has no property ' + name + ' on a pane')
}

// whether a session holds one test the driver executes: `have` and `lack` over a property
function holds(test, one) {
  if (test.form === 'have') {
    return same(propertyOf(one, test.name), test.value)
  }

  if (test.form === 'lack') {
    return !same(propertyOf(one, test.name), test.value)
  }

  throw refusal('cannot', 'iterm does not execute ' + test.form)
}

function handleOf(one) {
  return { tool: TOOL, id: one.id, kind: 'pane' }
}

function stepKind(step) {
  if (step.kind !== 'pane') {
    throw refusal('cannot', 'iterm finds panes, not ' + step.kind)
  }

  if (step.like !== '' || step.turn !== '' || step.depth !== '') {
    throw refusal('cannot', 'iterm has no relation ' + (step.like || step.turn || step.depth))
  }
}

function find(message) {
  var query = message.query

  if (message.from && message.from.length > 0) {
    throw refusal('cannot', 'iterm panes hold nothing to find below them')
  }

  if (query.path.length > 0) {
    throw refusal('cannot', 'iterm finds panes at its top, with no step below one')
  }

  stepKind(query.base)

  var hits = sessions().filter(function (one) {
    return query.base.test.every(function (test) {
      return holds(test, one)
    })
  })

  if (message.limit > 0) {
    hits = hits.slice(0, message.limit)
  }

  return { hits: hits.map(handleOf) }
}

function read(message) {
  var found = sessions().filter(function (one) {
    return one.id === message.handle.id
  })[0]

  if (!found) {
    throw refusal('gone', message.handle.id)
  }

  return { value: propertyOf(found, message.name) }
}

// `run`: the line is the string argument of one `write` Apple event, and iTerm2 adds the line ending
function call(message) {
  if (message.name !== 'run') {
    throw refusal('cannot', 'iterm has no capability ' + message.name + ' on a pane')
  }

  var target = sessionOf(message.handle.id)

  if (!target) {
    throw refusal('gone', message.handle.id)
  }

  var line = message.take && message.take.length > 0 ? message.take[0] : ''

  target.write({ text: String(line) })

  return { value: null }
}

// AppleScript string syntax, for the printed plan only
function quoted(text) {
  return '"' + String(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"'
}

// what `term find --plan` prints (research/native-lowering.md section 4): the AppleScript that does what this driver
// does. It is text for a person, never run
function plan(message) {
  var tests = message.query.base.test.map(function (test) {
    var left = test.name === 'title' ? 'name of s' : 'missing value'

    return (test.form === 'lack' ? 'not (' : '(') + left + ' is ' + quoted(test.value) + ')'
  })
  var condition = tests.length > 0 ? tests.join(' and ') : 'true'
  var lines = [
    'tell application "iTerm2"',
    '  set hits to {}',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      repeat with s in sessions of t',
    '        if ' + condition + ' then set end of hits to s',
    '      end repeat',
    '    end repeat',
    '  end repeat',
    '  -- 0 hits: not found. 2 or more: ambiguous. Both raise before any write.',
  ]

  for (var at = 0; at < (message.call || []).length; at++) {
    var one = message.call[at]

    if (one.name === 'run') {
      lines.push('  tell item 1 of hits to write text ' + quoted(one.take[0]))
    }
  }

  lines.push('end tell')

  return { text: lines.join('\n') }
}

function answer(message) {
  if (message.op === 'hello') {
    return { tool: TOOL, version: 1, kinds: [], part: PARTS }
  }

  if (message.op === 'find') {
    return find(message)
  }

  if (message.op === 'read') {
    return read(message)
  }

  if (message.op === 'call') {
    return call(message)
  }

  if (message.op === 'plan') {
    return plan(message)
  }

  if (message.op === 'drop') {
    return {}
  }

  throw refusal('cannot', 'no op ' + message.op)
}

function reply(stdout, value) {
  stdout.writeData($(JSON.stringify(value) + '\n').dataUsingEncoding($.NSUTF8StringEncoding))
}

function handle(stdout, line) {
  var message

  try {
    message = JSON.parse(line)
  } catch (cause) {
    return
  }

  try {
    var body = answer(message)
    var out = { id: message.id, ok: true }

    for (var key in body) {
      out[key] = body[key]
    }

    reply(stdout, out)
  } catch (cause) {
    var error = cause && cause.kind ? cause : nativeError(cause)

    reply(stdout, { id: message.id, ok: false, error: error })
  }
}

function run() {
  var stdin = $.NSFileHandle.fileHandleWithStandardInput
  var stdout = $.NSFileHandle.fileHandleWithStandardOutput
  var pending = $.NSMutableData.alloc.init

  for (;;) {
    var chunk = stdin.availableData

    if (Number(chunk.length) === 0) {
      break
    }

    pending.appendData(chunk)

    // the whole of what is pending as text. It is nothing while a character is cut in two between two chunks, and
    // then more is read before anything is decided
    var decoded = $.NSString.alloc.initWithDataEncoding(pending, $.NSUTF8StringEncoding)

    var all = ObjC.unwrap(decoded)

    if (all === undefined || all === null) {
      continue
    }

    var parts = String(all).split('\n')
    var rest = parts.pop()

    pending = $.NSMutableData.dataWithData($(rest).dataUsingEncoding($.NSUTF8StringEncoding))

    for (var at = 0; at < parts.length; at++) {
      handle(stdout, parts[at])
    }
  }
}
