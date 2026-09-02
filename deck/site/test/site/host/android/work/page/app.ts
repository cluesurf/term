// Runtime shim for the `observe-size` dom primitive: wraps ResizeObserver so the .tree side never expresses the
// observer construction + entry extraction. Provided to Seed via <global:resize> (docked `name resize`, so this object
// IS the binding); the dom calls `resize.observeSize`. A namespace object (not a top-level function) so the bundled
// client has no name collisions. `observeSize(el, cb)` calls `cb(width)` on every resize (and once now) with the
// element's current content-box width.
export const resize = {
  observeSize(
    el: HTMLElement,
    cb: (width: number) => void,
  ): ResizeObserver {
    const ro = new ResizeObserver(() => cb(el.clientWidth))
    ro.observe(el)
    cb(el.clientWidth)
    return ro
  },
}


// Runtime shim for the `anchor` dom primitive: wraps @floating-ui/dom so the .tree side never expresses the middleware
// assembly or the autoUpdate loop. Provided to Seed via <global:position>; the build prepends it next to the browser
// dom impl that docks it. `anchor` positions `panel` against `reference` (offset + optional flip + shift), applies
// `position: fixed; left; top`, and keeps it synced on scroll / resize. It returns a cleanup function that stops the
// tracking and is registered with on-cleanup so the overlay tears down with no dangling listeners.
import {
  computePosition,
  offset as offsetMiddleware,
  flip as flipMiddleware,
  shift as shiftMiddleware,
  autoUpdate,
} from '@floating-ui/dom'
import type { Middleware, Placement } from '@floating-ui/dom'

// the namespace the browser dom docks as `<global:position>` (docked `name position`, so this object IS the binding);
// the dom calls `position.anchor`. A namespace object (not a top-level function) to avoid client-bundle collisions.
export const position = {
  anchor(
    reference: HTMLElement,
    panel: HTMLElement,
    placement: string,
    offset: number,
    flip: boolean,
    shift: boolean,
  ): () => void {
    const middleware: Middleware[] = [offsetMiddleware(offset)]

    if (flip) {
      middleware.push(flipMiddleware())
    }

    if (shift) {
      middleware.push(shiftMiddleware({ padding: 8 }))
    }

    const apply = (): void => {
      computePosition(reference, panel, {
        placement: placement as Placement,
        strategy: 'fixed',
        middleware,
      }).then(({ x, y }) => {
        panel.style.position = 'fixed'
        panel.style.left = `${x}px`
        panel.style.top = `${y}px`
      })
    }

    // autoUpdate runs `apply` immediately and on every scroll / resize / layout shift, and returns the cleanup
    return autoUpdate(reference, panel, apply)
  },
}


// Runtime shim for the font-ready registry (the FOUC-prevention typography layer). Wraps the browser
// `document.fonts` FontFaceSet so the `.tree` side never expresses FontFaceSet loading directly. Provided to
// Seed via <global:fontset> (docked `name fontset`, so this object IS the binding); the dom calls
// `fontset.check` / `fontset.watch`. A namespace object (not top-level functions) so the bundled client has no
// name collisions, matching the resize / position runtimes. Named `fontset` (one identifier, like `resize`)
// because a `<global:X>` tag is emitted verbatim as the binding identifier — a hyphen would be invalid JS.
//
// Two operations, because the visibility gate needs both a synchronous "is it ALREADY loaded" answer (warm cache
// -> render at full opacity with no hidden frame) and an async "tell me WHEN it resolves" callback (cold load ->
// hide, then reveal):
//
//   check(family)      -> boolean. Synchronous. True iff the family is loaded and usable RIGHT NOW.
//   watch(family, cb)  -> void.    Resolves the family's load status and calls `cb(status)` exactly once with a
//                                  terminal status ('ready' | 'error' | 'timeout'). A hard timeout guarantees `cb`
//                                  always fires so text is never stuck hidden.

const TIMEOUT_MS = 2000

type FontStatus = 'ready' | 'error' | 'timeout'

// Per-family deadline state (Layer A of the visibility machine). One shared timer per family fires at
// `firstAsk + thresholdMs` and wakes every subscriber on the same tick, so a page with N text nodes of one family
// keeps a single setTimeout, not N. Matches React's `subscribeToFontDeadline`: the FIRST subscriber's threshold
// schedules the timer; once fired, a late subscriber fires on the next microtask.
const firstAskAtByFamily = new Map<string, number>()
const deadlineFiredByFamily = new Set<string>()
const deadlineSubscribersByFamily = new Map<string, Set<() => void>>()
const deadlineTimerByFamily = new Map<
  string,
  ReturnType<typeof setTimeout>
>()

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now()
}

// A CSS font shorthand that names the family. `document.fonts.check` / `.load` need a font shorthand, not a bare
// family name; `1em "<family>"` is the minimal valid one.
function shorthand(family: string): string {
  return `1em "${family}"`
}

export const fontset = {
  // Synchronous: is this family loaded and ready to paint right now? On the server (no FontFaceSet) or for an
  // empty family, report true so text is never hidden where there is nothing to wait for.
  check(family: string): boolean {
    if (typeof document === 'undefined' || !document.fonts || !family) {
      return true
    }
    try {
      return document.fonts.check(shorthand(family))
    } catch {
      // check() throws on a malformed shorthand; treat as "not blocking" rather than hiding text forever.
      return true
    }
  },

  // Async: call `cb` once with the terminal status. `document.fonts.load` forces the family to load and resolves
  // with the matched FontFace list; a timeout backstops a never-resolving load. SSR / no FontFaceSet reports ready.
  watch(family: string, cb: (status: FontStatus) => void): void {
    if (typeof document === 'undefined' || !document.fonts || !family) {
      cb('ready')
      return
    }

    let settled = false
    const done = (status: FontStatus): void => {
      if (settled) {
        return
      }
      settled = true
      cb(status)
    }

    const timer = setTimeout(() => done('timeout'), TIMEOUT_MS)

    document.fonts.load(shorthand(family)).then(
      faces => {
        clearTimeout(timer)
        done(faces.length > 0 ? 'ready' : 'error')
      },
      () => {
        clearTimeout(timer)
        done('error')
      },
    )
  },

  // Fallback deadline: call `cb` once when `firstAsk + thresholdMs` elapses for this family, regardless of load
  // status, so the visibility machine can reveal the fallback face if the real font is slow. One shared timer per
  // family (the FIRST subscriber schedules it); a subscriber arriving after the deadline already fired is called on
  // the next microtask. SSR / no window: never fires (the client re-render drives the real gate).
  deadline(family: string, thresholdMs: number, cb: () => void): void {
    if (typeof window === 'undefined' || !family) {
      return
    }

    if (!firstAskAtByFamily.has(family)) {
      firstAskAtByFamily.set(family, nowMs())
    }

    // Already fired: fire async so every path is uniformly asynchronous.
    if (deadlineFiredByFamily.has(family)) {
      Promise.resolve().then(cb)
      return
    }

    let subscribers = deadlineSubscribersByFamily.get(family)
    if (!subscribers) {
      subscribers = new Set()
      deadlineSubscribersByFamily.set(family, subscribers)
    }
    subscribers.add(cb)

    // Schedule the family-wide timer on the first subscribe.
    if (!deadlineTimerByFamily.has(family)) {
      const firstAsk = firstAskAtByFamily.get(family) ?? nowMs()
      const remaining = Math.max(0, firstAsk + thresholdMs - nowMs())
      const id = setTimeout(() => {
        deadlineFiredByFamily.add(family)
        deadlineTimerByFamily.delete(family)
        const subs = deadlineSubscribersByFamily.get(family)
        if (!subs) {
          return
        }
        // Snapshot before iterating: a subscriber may mutate the set inside its callback.
        for (const sub of Array.from(subs)) {
          try {
            sub()
          } catch (error) {
            console.error(
              `[fontset] deadline subscriber for "${family}" threw`,
              error,
            )
          }
        }
      }, remaining)
      deadlineTimerByFamily.set(family, id)
    }
  },
}


// Runtime shim for the browser `set-title` / `set-meta` dom tasks. Wraps the document-head mutations so the `.tree`
// side never expresses them directly. Provided to Seed via <global:title> (docked `name title`, so this object IS
// the binding); the dom calls `title.set` / `title.setMeta`. A namespace object (like resize / position / fontset)
// so the bundled client has no name collisions.
//
// Why a runtime shim instead of a `.tree` body: the browser impls mutate document-head state (`document.title =`,
// upsert a `<meta>`), and expressing that as a `.tree` member-assignment (`save page/title, ...`) hit a compiler
// drop. A native runtime keeps the browser DOM detail in one clean place and the dom task is a plain method call.

export const title = {
  // set the document title (per-route, from a route's `seed title` directive).
  set(text: string): void {
    if (typeof document !== 'undefined') {
      document.title = text
    }
  },

  // upsert a SEO meta tag live (per-route). og:* / article:* render as `property`, the rest as `name`, matching the
  // SSR document-shell. Reuses the existing element for a key if present, else creates + appends one.
  setMeta(name: string, content: string): void {
    if (typeof document === 'undefined') {
      return
    }
    const attribute =
      name.startsWith('og:') || name.startsWith('article:')
        ? 'property'
        : 'name'
    let element = document.head.querySelector(`meta[${attribute}="${name}"]`)
    if (!element) {
      element = document.createElement('meta')
      element.setAttribute(attribute, name)
      document.head.appendChild(element)
    }
    element.setAttribute('content', content)
  },

  // a resource route's proxy: on the client, nothing to stash (the server streams it); no-op.
  setProxy(): void {},
}

// The lowered route dispatcher calls `setTitle` / `setMeta` / `setProxy` at the top level (from a route's `seed title`
// / `seed description` / proxy directives), as BARE globals -- not through the dom's `set-title` task. On the server the
// node `html` runtime provides these free functions (draining into the SSR <head>); the browser needs the same free
// functions so the client bundle can hydrate. This prelude is concatenated in front of the compiled route code, so
// these top-level helpers are in scope for the route's bare calls, and the bundler retains them because the route
// references them. They delegate to the `title` namespace above so all browser DOM detail stays in one place, matching
// how the node `html` runtime exposes `setTitle` / `setMeta` / `setProxy`.
function setTitle(text: string): void {
  title.set(text)
}

function setMeta(name: string, content: string): void {
  title.setMeta(name, content)
}

function setProxy(): void {
  title.setProxy()
}

declare const resize: any
declare const position: any
declare const fontset: any
declare const title: any

export interface View {
  handle: any
}

export function test(test: number, block: number): void {
  nativeTest(test, block)
}

export interface EventListener {

}

export interface EventListenerObject {

}

export interface EventListenerOrEventListenerObject {

}

export function eventTargetAddEventListener(type: string, callback: number, options: Maybe<number>): void {}

export function eventTargetRemoveEventListener(type: string, callback: number, options: Maybe<number>): void {}

export interface Event {
  bubbles: any
  cancelBubble: any
  cancelable: any
  composed: any
  currentTarget: any
  defaultPrevented: any
  eventPhase: any
  isTrusted: any
  returnValue: any
  srcElement: any
  target: any
  timeStamp: any
  type: any
  atTarget: any
  bubblingPhase: any
  capturingPhase: any
  none: any
}

export interface AbortSignalEventMap {
  abort: any
}

export interface AbortSignal {
  aborted: any
  onabort: any
}

export function abortSignalAddEventListener30<K>(type: K, listener: (a0: AbortSignal, a1: number) => number, options: Maybe<number>): void {}

export function abortSignalAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function abortSignalRemoveEventListener30<K>(type: K, listener: (a0: AbortSignal, a1: number) => number, options: Maybe<number>): void {}

export function abortSignalRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface AnimationEventMap {
  cancel: any
  finish: any
  remove: any
}

export interface PromiseLike<T = any> {

}

export function promiseLikeThen<T, TResult1, TResult2>(onfulfilled: Maybe<number>, onrejected: Maybe<number>): PromiseLike<number> {
  throw new Error("stub: promise-like_then")
}

export interface PromiseForm<T = any> {

}

export function promiseThen<T, TResult1, TResult2>(onfulfilled: Maybe<number>, onrejected: Maybe<number>): PromiseForm<number> {
  throw new Error("stub: promise_then")
}

export interface Animation {
  currentTime: any
  effect: any
  finished: any
  id: any
  oncancel: any
  onfinish: any
  onremove: any
  pending: any
  playState: any
  playbackRate: any
  ready: any
  replaceState: any
  startTime: any
  timeline: any
}

export function animationCancel(): void {}

export function animationFinish(): void {}

export function animationPause(): void {}

export function animationPlay(): void {}

export function animationAddEventListener30<K>(type: K, listener: (a0: Animation, a1: number) => number, options: Maybe<number>): void {}

export function animationAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function animationRemoveEventListener30<K>(type: K, listener: (a0: Animation, a1: number) => number, options: Maybe<number>): void {}

export function animationRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface Keyframe {
  composite: any
  easing: any
  offset: any
}

export interface PropertyIndexedKeyframes {
  composite: any
  easing: any
  offset: any
}

export function animatableAnimate(keyframes: number, options: Maybe<number>): Animation {
  throw new Error("stub: animatable_animate")
}

export function readableStreamGenericReaderCancel(reason: Maybe<number>): PromiseForm<void> {
  throw new Error("stub: readable-stream-generic-reader_cancel")
}

export function writableStreamDefaultWriterAbort<W>(reason: Maybe<number>): PromiseForm<void> {
  throw new Error("stub: writable-stream-default-writer_abort")
}

export function writableStreamDefaultWriterClose<W>(): PromiseForm<void> {
  throw new Error("stub: writable-stream-default-writer_close")
}

export function writableStreamAbort<W>(reason: Maybe<number>): PromiseForm<void> {
  throw new Error("stub: writable-stream_abort")
}

export function writableStreamClose<W>(): PromiseForm<void> {
  throw new Error("stub: writable-stream_close")
}

export function readableStreamCancel<R>(reason: Maybe<number>): PromiseForm<void> {
  throw new Error("stub: readable-stream_cancel")
}

export interface ArrayBuffer {
  byteLength: any
}

export function arrayBufferSlice(begin: number, end: Maybe<number>): ArrayBuffer {
  throw new Error("stub: array-buffer_slice")
}

export interface Blob {
  size: any
  type: any
}

export function blobArrayBuffer(): PromiseForm<ArrayBuffer> {
  throw new Error("stub: blob_array-buffer")
}

export function blobSlice(start: Maybe<number>, end: Maybe<number>, contentType: Maybe<number>): Blob {
  throw new Error("stub: blob_slice")
}

export function blobText(): PromiseForm<string> {
  throw new Error("stub: blob_text")
}

export interface File {
  lastModified: any
  name: any
  webkitRelativePath: any
}

export function dataTransferItemListClear(): void {}

export function dataTransferItemListRemove(index: number): void {}

export function fileListItem(index: number): number {
  throw new Error("stub: file-list_item")
}

export interface ConcatArray<T = any> {
  length: any
}

export function concatArraySlice<T>(start: Maybe<number>, end: Maybe<number>): number {
  throw new Error("stub: concat-array_slice")
}

export interface ReadonlyArray<T = any> {
  length: any
}

export function readonlyArrayConcat10<T>(items: number): number {
  throw new Error("stub: readonly-array_concat__1__0")
}

export function readonlyArrayConcat11<T>(items: number): number {
  throw new Error("stub: readonly-array_concat__1__1")
}

export function readonlyArraySlice<T>(start: Maybe<number>, end: Maybe<number>): number {
  throw new Error("stub: readonly-array_slice")
}

export function readonlyArrayEvery20<T, S>(predicate: (a0: T, a1: number, a2: number) => boolean, thisArg: Maybe<number>): boolean {
  throw new Error("stub: readonly-array_every__2__0")
}

export function readonlyArrayEvery21<T>(predicate: (a0: T, a1: number, a2: number) => number, thisArg: Maybe<number>): boolean {
  throw new Error("stub: readonly-array_every__2__1")
}

export function readonlyArraySome<T>(predicate: (a0: T, a1: number, a2: number) => number, thisArg: Maybe<number>): boolean {
  throw new Error("stub: readonly-array_some")
}

export function readonlyArrayMap<T, U>(callbackfn: (a0: T, a1: number, a2: number) => U, thisArg: Maybe<number>): number {
  throw new Error("stub: readonly-array_map")
}

export function readonlyArrayFilter20<T, S>(predicate: (a0: T, a1: number, a2: number) => boolean, thisArg: Maybe<number>): number {
  throw new Error("stub: readonly-array_filter__2__0")
}

export function readonlyArrayFilter21<T>(predicate: (a0: T, a1: number, a2: number) => number, thisArg: Maybe<number>): number {
  throw new Error("stub: readonly-array_filter__2__1")
}

export function readonlyArrayReduce1<T>(callbackfn: (a0: T, a1: T, a2: number, a3: number) => T): T {
  throw new Error("stub: readonly-array_reduce__1")
}

export function readonlyArrayReduce20<T>(callbackfn: (a0: T, a1: T, a2: number, a3: number) => T, initialValue: T): T {
  throw new Error("stub: readonly-array_reduce__2__0")
}

export function readonlyArrayReduce21<T, U>(callbackfn: (a0: U, a1: T, a2: number, a3: number) => U, initialValue: U): U {
  throw new Error("stub: readonly-array_reduce__2__1")
}

export function readonlyArrayReduceRight1<T>(callbackfn: (a0: T, a1: T, a2: number, a3: number) => T): T {
  throw new Error("stub: readonly-array_reduce-right__1")
}

export function readonlyArrayReduceRight20<T>(callbackfn: (a0: T, a1: T, a2: number, a3: number) => T, initialValue: T): T {
  throw new Error("stub: readonly-array_reduce-right__2__0")
}

export function readonlyArrayReduceRight21<T, U>(callbackfn: (a0: U, a1: T, a2: number, a3: number) => U, initialValue: U): U {
  throw new Error("stub: readonly-array_reduce-right__2__1")
}

export interface DocumentAndElementEventHandlersEventMap {
  copy: any
  cut: any
  paste: any
}

export interface DocumentAndElementEventHandlers {
  oncopy: any
  oncut: any
  onpaste: any
}

export function documentAndElementEventHandlersAddEventListener30<K>(type: K, listener: (a0: DocumentAndElementEventHandlers, a1: number) => number, options: Maybe<number>): void {}

export function documentAndElementEventHandlersAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function documentAndElementEventHandlersRemoveEventListener30<K>(type: K, listener: (a0: DocumentAndElementEventHandlers, a1: number) => number, options: Maybe<number>): void {}

export function documentAndElementEventHandlersRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function cssRuleListItem(index: number): number {
  throw new Error("stub: css-rule-list_item")
}

export function mediaListItem(index: number): number {
  throw new Error("stub: media-list_item")
}

export interface CssStyleSheet {
  cssRules: any
  ownerRule: any
  rules: any
}

export interface CssRule {
  cssText: any
  parentRule: any
  parentStyleSheet: any
  type: any
  charsetRule: any
  fontFaceRule: any
  importRule: any
  keyframesRule: any
  keyframeRule: any
  mediaRule: any
  namespaceRule: any
  pageRule: any
  styleRule: any
  supportsRule: any
}

export function cssStyleDeclarationItem(index: number): string {
  throw new Error("stub: css-style-declaration_item")
}

export interface CustomElementConstructor {

}

export function customElementRegistryGet(name: string): number {
  throw new Error("stub: custom-element-registry_get")
}

export interface External {

}

export interface ScrollRestoration {

}

export function urlSearchParamsAppend(name: string, value: string): void {}

export function urlSearchParamsGet(name: string): number {
  throw new Error("stub: url-search-params_get")
}

export function urlSearchParamsSet(name: string, value: string): void {}

export interface Url {
  hash: any
  host: any
  hostname: any
  href: any
  origin: any
  password: any
  pathname: any
  port: any
  protocol: any
  search: any
  searchParams: any
  username: any
}

export interface History {
  length: any
  scrollRestoration: any
  state: any
}

export function historyReplaceState(data: number, unused: string, url: Maybe<number>): void {}

export function domStringListItem(index: number): number {
  throw new Error("stub: dom-string-list_item")
}

export interface Location {
  ancestorOrigins: any
  hash: any
  host: any
  hostname: any
  href: any
  origin: any
  pathname: any
  port: any
  protocol: any
  search: any
}

export function locationReplace(url: number): void {}

export interface MediaQueryListEventMap {
  change: any
}

export interface MediaQueryList {
  matches: any
  media: any
  onchange: any
}

export function mediaQueryListAddEventListener30<K>(type: K, listener: (a0: MediaQueryList, a1: number) => number, options: Maybe<number>): void {}

export function mediaQueryListAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function mediaQueryListRemoveEventListener30<K>(type: K, listener: (a0: MediaQueryList, a1: number) => number, options: Maybe<number>): void {}

export function mediaQueryListRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface ArrayBufferView {
  buffer: any
  byteLength: any
  byteOffset: any
}

export interface BufferSource {

}

export interface FormDataEntryValue {

}

export function formDataAppend(name: string, value: number, fileName: Maybe<number>): void {}

export function formDataGet(name: string): number {
  throw new Error("stub: form-data_get")
}

export function formDataSet(name: string, value: number, fileName: Maybe<number>): void {}

export interface Clipboard {

}

export interface Credential {
  id: any
  type: any
}

export function credentialsContainerGet(options: Maybe<number>): PromiseForm<number> {
  throw new Error("stub: credentials-container_get")
}

export interface Geolocation {

}

export interface MediaCapabilities {

}

export interface MediaDevicesEventMap {
  devicechange: any
}

export interface MediaStreamTrackEventMap {
  ended: any
  mute: any
  unmute: any
}

export interface MediaStreamTrack {
  contentHint: any
  enabled: any
  id: any
  kind: any
  label: any
  muted: any
  onended: any
  onmute: any
  onunmute: any
  readyState: any
}

export function mediaStreamTrackStop(): void {}

export function mediaStreamTrackAddEventListener30<K>(type: K, listener: (a0: MediaStreamTrack, a1: number) => number, options: Maybe<number>): void {}

export function mediaStreamTrackAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function mediaStreamTrackRemoveEventListener30<K>(type: K, listener: (a0: MediaStreamTrack, a1: number) => number, options: Maybe<number>): void {}

export function mediaStreamTrackRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface MediaStreamEventMap {
  addtrack: any
  removetrack: any
}

export interface MediaStream {
  active: any
  id: any
  onaddtrack: any
  onremovetrack: any
}

export function mediaStreamAddEventListener30<K>(type: K, listener: (a0: MediaStream, a1: number) => number, options: Maybe<number>): void {}

export function mediaStreamAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function mediaStreamRemoveEventListener30<K>(type: K, listener: (a0: MediaStream, a1: number) => number, options: Maybe<number>): void {}

export function mediaStreamRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface MediaDevices {
  ondevicechange: any
}

export function mediaDevicesAddEventListener30<K>(type: K, listener: (a0: MediaDevices, a1: number) => number, options: Maybe<number>): void {}

export function mediaDevicesAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function mediaDevicesRemoveEventListener30<K>(type: K, listener: (a0: MediaDevices, a1: number) => number, options: Maybe<number>): void {}

export function mediaDevicesRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface MediaKeySessionEventMap {
  keystatuseschange: any
  message: any
}

export interface MediaKeyStatus {

}

export function mediaKeyStatusMapGet(keyId: BufferSource): number {
  throw new Error("stub: media-key-status-map_get")
}

export interface MediaKeySession {
  closed: any
  expiration: any
  keyStatuses: any
  onkeystatuseschange: any
  onmessage: any
  sessionId: any
}

export function mediaKeySessionClose(): PromiseForm<void> {
  throw new Error("stub: media-key-session_close")
}

export function mediaKeySessionLoad(sessionId: string): PromiseForm<boolean> {
  throw new Error("stub: media-key-session_load")
}

export function mediaKeySessionRemove(): PromiseForm<void> {
  throw new Error("stub: media-key-session_remove")
}

export function mediaKeySessionUpdate(response: BufferSource): PromiseForm<void> {
  throw new Error("stub: media-key-session_update")
}

export function mediaKeySessionAddEventListener30<K>(type: K, listener: (a0: MediaKeySession, a1: number) => number, options: Maybe<number>): void {}

export function mediaKeySessionAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function mediaKeySessionRemoveEventListener30<K>(type: K, listener: (a0: MediaKeySession, a1: number) => number, options: Maybe<number>): void {}

export function mediaKeySessionRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface MediaKeys {

}

export interface MediaSession {
  metadata: any
  playbackState: any
}

export function mimeTypeArrayItem(index: number): number {
  throw new Error("stub: mime-type-array_item")
}

export function pluginArrayItem(index: number): number {
  throw new Error("stub: plugin-array_item")
}

export interface PermissionDescriptor {
  name: any
}

export interface PermissionStatusEventMap {
  change: any
}

export interface PermissionStatus {
  onchange: any
  state: any
}

export function permissionStatusAddEventListener30<K>(type: K, listener: (a0: PermissionStatus, a1: number) => number, options: Maybe<number>): void {}

export function permissionStatusAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function permissionStatusRemoveEventListener30<K>(type: K, listener: (a0: PermissionStatus, a1: number) => number, options: Maybe<number>): void {}

export function permissionStatusRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface Permissions {

}

export function permissionsQuery(permissionDesc: PermissionDescriptor): PromiseForm<PermissionStatus> {
  throw new Error("stub: permissions_query")
}

export interface MessagePortEventMap {
  message: any
  messageerror: any
}

export interface ImageBitmap {
  height: any
  width: any
}

export function imageBitmapClose(): void {}

export interface Transferable {

}

export interface MessagePort {
  onmessage: any
  onmessageerror: any
}

export function messagePortClose(): void {}

export function messagePortPostMessage20(message: number, transfer: number): void {}

export function messagePortPostMessage21(message: number, options: Maybe<number>): void {}

export function messagePortStart(): void {}

export function messagePortAddEventListener30<K>(type: K, listener: (a0: MessagePort, a1: number) => number, options: Maybe<number>): void {}

export function messagePortAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function messagePortRemoveEventListener30<K>(type: K, listener: (a0: MessagePort, a1: number) => number, options: Maybe<number>): void {}

export function messagePortRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface AbstractWorkerEventMap {
  error: any
}

export interface AbstractWorker {
  onerror: any
}

export function abstractWorkerAddEventListener30<K>(type: K, listener: (a0: AbstractWorker, a1: number) => number, options: Maybe<number>): void {}

export function abstractWorkerAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function abstractWorkerRemoveEventListener30<K>(type: K, listener: (a0: AbstractWorker, a1: number) => number, options: Maybe<number>): void {}

export function abstractWorkerRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface ServiceWorkerEventMap {
  statechange: any
}

export interface ServiceWorker {
  onstatechange: any
  scriptURL: any
  state: any
}

export function serviceWorkerPostMessage20(message: number, transfer: number): void {}

export function serviceWorkerPostMessage21(message: number, options: Maybe<number>): void {}

export function serviceWorkerAddEventListener30<K>(type: K, listener: (a0: ServiceWorker, a1: number) => number, options: Maybe<number>): void {}

export function serviceWorkerAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function serviceWorkerRemoveEventListener30<K>(type: K, listener: (a0: ServiceWorker, a1: number) => number, options: Maybe<number>): void {}

export function serviceWorkerRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface WindowProxy {

}

export interface ServiceWorkerContainerEventMap {
  controllerchange: any
  message: any
  messageerror: any
}

export interface NotificationEventMap {
  click: any
  close: any
  error: any
  show: any
}

export interface Notification {
  body: any
  data: any
  dir: any
  icon: any
  lang: any
  onclick: any
  onclose: any
  onerror: any
  onshow: any
  tag: any
  title: any
}

export function notificationClose(): void {}

export function notificationAddEventListener30<K>(type: K, listener: (a0: Notification, a1: number) => number, options: Maybe<number>): void {}

export function notificationAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function notificationRemoveEventListener30<K>(type: K, listener: (a0: Notification, a1: number) => number, options: Maybe<number>): void {}

export function notificationRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface PushManager {

}

export interface ServiceWorkerRegistrationEventMap {
  updatefound: any
}

export interface ServiceWorkerRegistration {
  active: any
  installing: any
  onupdatefound: any
  pushManager: any
  scope: any
  updateViaCache: any
  waiting: any
}

export function serviceWorkerRegistrationUpdate(): PromiseForm<void> {
  throw new Error("stub: service-worker-registration_update")
}

export function serviceWorkerRegistrationAddEventListener30<K>(type: K, listener: (a0: ServiceWorkerRegistration, a1: number) => number, options: Maybe<number>): void {}

export function serviceWorkerRegistrationAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function serviceWorkerRegistrationRemoveEventListener30<K>(type: K, listener: (a0: ServiceWorkerRegistration, a1: number) => number, options: Maybe<number>): void {}

export function serviceWorkerRegistrationRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface ServiceWorkerContainer {
  controller: any
  oncontrollerchange: any
  onmessage: any
  onmessageerror: any
  ready: any
}

export function serviceWorkerContainerAddEventListener30<K>(type: K, listener: (a0: ServiceWorkerContainer, a1: number) => number, options: Maybe<number>): void {}

export function serviceWorkerContainerAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function serviceWorkerContainerRemoveEventListener30<K>(type: K, listener: (a0: ServiceWorkerContainer, a1: number) => number, options: Maybe<number>): void {}

export function serviceWorkerContainerRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface Navigator {
  clipboard: any
  credentials: any
  doNotTrack: any
  geolocation: any
  maxTouchPoints: any
  mediaCapabilities: any
  mediaDevices: any
  mediaSession: any
  permissions: any
  pointerEnabled: any
  serviceWorker: any
}

export interface ScreenOrientationEventMap {
  change: any
}

export interface ScreenOrientation {
  angle: any
  onchange: any
  type: any
}

export function screenOrientationAddEventListener30<K>(type: K, listener: (a0: ScreenOrientation, a1: number) => number, options: Maybe<number>): void {}

export function screenOrientationAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function screenOrientationRemoveEventListener30<K>(type: K, listener: (a0: ScreenOrientation, a1: number) => number, options: Maybe<number>): void {}

export function screenOrientationRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface Screen {
  availHeight: any
  availWidth: any
  colorDepth: any
  height: any
  orientation: any
  pixelDepth: any
  width: any
}

export function htmlCollectionBaseItem(index: number): number {
  throw new Error("stub: html-collection-base_item")
}

export interface HtmlCollection {

}

export function domTokenListItem(index: number): number {
  throw new Error("stub: dom-token-list_item")
}

export function domTokenListRemove(tokens: number): void {}

export function domTokenListReplace(token: string, newToken: string): boolean {
  throw new Error("stub: dom-token-list_replace")
}

export function domTokenListToggle(token: string, force: Maybe<number>): boolean {
  throw new Error("stub: dom-token-list_toggle")
}

export interface ElementEventMap {
  fullscreenchange: any
  fullscreenerror: any
}

export interface Touch {
  clientX: any
  clientY: any
  force: any
  identifier: any
  pageX: any
  pageY: any
  radiusX: any
  radiusY: any
  rotationAngle: any
  screenX: any
  screenY: any
  target: any
}

export function touchListItem(index: number): number {
  throw new Error("stub: touch-list_item")
}

export interface GlobalEventHandlersEventMap {
  abort: any
  animationcancel: any
  animationend: any
  animationiteration: any
  animationstart: any
  auxclick: any
  beforeinput: any
  blur: any
  canplay: any
  canplaythrough: any
  change: any
  click: any
  close: any
  compositionend: any
  compositionstart: any
  compositionupdate: any
  contextmenu: any
  cuechange: any
  dblclick: any
  drag: any
  dragend: any
  dragenter: any
  dragleave: any
  dragover: any
  dragstart: any
  drop: any
  durationchange: any
  emptied: any
  ended: any
  error: any
  focus: any
  focusin: any
  focusout: any
  formdata: any
  gotpointercapture: any
  input: any
  invalid: any
  keydown: any
  keypress: any
  keyup: any
  load: any
  loadeddata: any
  loadedmetadata: any
  loadstart: any
  lostpointercapture: any
  mousedown: any
  mouseenter: any
  mouseleave: any
  mousemove: any
  mouseout: any
  mouseover: any
  mouseup: any
  pause: any
  play: any
  playing: any
  pointercancel: any
  pointerdown: any
  pointerenter: any
  pointerleave: any
  pointermove: any
  pointerout: any
  pointerover: any
  pointerup: any
  progress: any
  ratechange: any
  reset: any
  resize: any
  scroll: any
  securitypolicyviolation: any
  seeked: any
  seeking: any
  select: any
  selectionchange: any
  selectstart: any
  stalled: any
  submit: any
  suspend: any
  timeupdate: any
  toggle: any
  touchcancel: any
  touchend: any
  touchmove: any
  touchstart: any
  transitioncancel: any
  transitionend: any
  transitionrun: any
  transitionstart: any
  volumechange: any
  waiting: any
  webkitanimationend: any
  webkitanimationiteration: any
  webkitanimationstart: any
  webkittransitionend: any
  wheel: any
}

export interface HtmlElementEventMap {

}

export interface HtmlAnchorElement {
  charset: any
  coords: any
  download: any
  hreflang: any
  name: any
  ping: any
  referrerPolicy: any
  rel: any
  relList: any
  rev: any
  shape: any
  target: any
  text: any
  type: any
}

export function htmlAnchorElementAddEventListener30<K>(type: K, listener: (a0: HtmlAnchorElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlAnchorElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlAnchorElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlAnchorElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlAnchorElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlAreaElement {
  alt: any
  coords: any
  download: any
  noHref: any
  ping: any
  referrerPolicy: any
  rel: any
  relList: any
  shape: any
  target: any
}

export function htmlAreaElementAddEventListener30<K>(type: K, listener: (a0: HtmlAreaElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlAreaElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlAreaElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlAreaElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlAreaElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlMediaElementEventMap {
  encrypted: any
  waitingforkey: any
}

export interface MediaSourceEventMap {
  sourceclose: any
  sourceended: any
  sourceopen: any
}

export interface ReadyState {

}

export interface SourceBufferEventMap {
  abort: any
  error: any
  update: any
  updateend: any
  updatestart: any
}

export function timeRangesEnd(index: number): number {
  throw new Error("stub: time-ranges_end")
}

export function timeRangesStart(index: number): number {
  throw new Error("stub: time-ranges_start")
}

export interface SourceBuffer {
  appendWindowEnd: any
  appendWindowStart: any
  buffered: any
  mode: any
  onabort: any
  onerror: any
  onupdate: any
  onupdateend: any
  onupdatestart: any
  timestampOffset: any
  updating: any
}

export function sourceBufferAbort(): void {}

export function sourceBufferRemove(start: number, end: number): void {}

export function sourceBufferAddEventListener30<K>(type: K, listener: (a0: SourceBuffer, a1: number) => number, options: Maybe<number>): void {}

export function sourceBufferAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function sourceBufferRemoveEventListener30<K>(type: K, listener: (a0: SourceBuffer, a1: number) => number, options: Maybe<number>): void {}

export function sourceBufferRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SourceBufferListEventMap {
  addsourcebuffer: any
  removesourcebuffer: any
}

export interface SourceBufferList {
  length: any
  onaddsourcebuffer: any
  onremovesourcebuffer: any
}

export function sourceBufferListAddEventListener30<K>(type: K, listener: (a0: SourceBufferList, a1: number) => number, options: Maybe<number>): void {}

export function sourceBufferListAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function sourceBufferListRemoveEventListener30<K>(type: K, listener: (a0: SourceBufferList, a1: number) => number, options: Maybe<number>): void {}

export function sourceBufferListRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface MediaSource {
  activeSourceBuffers: any
  duration: any
  onsourceclose: any
  onsourceended: any
  onsourceopen: any
  readyState: any
  sourceBuffers: any
}

export function mediaSourceAddEventListener30<K>(type: K, listener: (a0: MediaSource, a1: number) => number, options: Maybe<number>): void {}

export function mediaSourceAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function mediaSourceRemoveEventListener30<K>(type: K, listener: (a0: MediaSource, a1: number) => number, options: Maybe<number>): void {}

export function mediaSourceRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface RemotePlaybackEventMap {
  connect: any
  connecting: any
  disconnect: any
}

export interface RemotePlayback {
  onconnect: any
  onconnecting: any
  ondisconnect: any
  state: any
}

export function remotePlaybackAddEventListener30<K>(type: K, listener: (a0: RemotePlayback, a1: number) => number, options: Maybe<number>): void {}

export function remotePlaybackAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function remotePlaybackRemoveEventListener30<K>(type: K, listener: (a0: RemotePlayback, a1: number) => number, options: Maybe<number>): void {}

export function remotePlaybackRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface TextTrackCueEventMap {
  enter: any
  exit: any
}

export interface TextTrackCue {
  endTime: any
  id: any
  onenter: any
  onexit: any
  pauseOnExit: any
  startTime: any
  track: any
}

export function textTrackCueAddEventListener30<K>(type: K, listener: (a0: TextTrackCue, a1: number) => number, options: Maybe<number>): void {}

export function textTrackCueAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function textTrackCueRemoveEventListener30<K>(type: K, listener: (a0: TextTrackCue, a1: number) => number, options: Maybe<number>): void {}

export function textTrackCueRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface TextTrackEventMap {
  cuechange: any
}

export interface TextTrack {
  activeCues: any
  cues: any
  id: any
  inBandMetadataTrackDispatchType: any
  kind: any
  label: any
  language: any
  mode: any
  oncuechange: any
}

export function textTrackAddEventListener30<K>(type: K, listener: (a0: TextTrack, a1: number) => number, options: Maybe<number>): void {}

export function textTrackAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function textTrackRemoveEventListener30<K>(type: K, listener: (a0: TextTrack, a1: number) => number, options: Maybe<number>): void {}

export function textTrackRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface TextTrackListEventMap {
  addtrack: any
  change: any
  removetrack: any
}

export interface TextTrackList {
  length: any
  onaddtrack: any
  onchange: any
  onremovetrack: any
}

export function textTrackListAddEventListener30<K>(type: K, listener: (a0: TextTrackList, a1: number) => number, options: Maybe<number>): void {}

export function textTrackListAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function textTrackListRemoveEventListener30<K>(type: K, listener: (a0: TextTrackList, a1: number) => number, options: Maybe<number>): void {}

export function textTrackListRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlMediaElement {
  autoplay: any
  buffered: any
  controls: any
  crossOrigin: any
  currentSrc: any
  currentTime: any
  defaultMuted: any
  defaultPlaybackRate: any
  disableRemotePlayback: any
  duration: any
  ended: any
  error: any
  loop: any
  mediaKeys: any
  muted: any
  networkState: any
  onencrypted: any
  onwaitingforkey: any
  paused: any
  playbackRate: any
  played: any
  preload: any
  readyState: any
  remote: any
  seekable: any
  seeking: any
  src: any
  srcObject: any
  textTracks: any
  volume: any
  haveCurrentData: any
  haveEnoughData: any
  haveFutureData: any
  haveMetadata: any
  haveNothing: any
  networkEmpty: any
  networkIdle: any
  networkLoading: any
  networkNoSource: any
}

export function htmlMediaElementLoad(): void {}

export function htmlMediaElementPause(): void {}

export function htmlMediaElementPlay(): PromiseForm<void> {
  throw new Error("stub: html-media-element_play")
}

export function htmlMediaElementAddEventListener30<K>(type: K, listener: (a0: HtmlMediaElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlMediaElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlMediaElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlMediaElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlMediaElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlAudioElement {

}

export function htmlAudioElementAddEventListener30<K>(type: K, listener: (a0: HtmlAudioElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlAudioElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlAudioElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlAudioElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlAudioElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlBaseElement {
  href: any
  target: any
}

export function htmlBaseElementAddEventListener30<K>(type: K, listener: (a0: HtmlBaseElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlBaseElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlBaseElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlBaseElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlBaseElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface Storage {
  length: any
}

export function storageClear(): void {}

export function storageKey(index: number): number {
  throw new Error("stub: storage_key")
}

export interface WindowEventHandlersEventMap {
  afterprint: any
  beforeprint: any
  beforeunload: any
  gamepadconnected: any
  gamepaddisconnected: any
  hashchange: any
  languagechange: any
  message: any
  messageerror: any
  offline: any
  online: any
  pagehide: any
  pageshow: any
  popstate: any
  rejectionhandled: any
  storage: any
  unhandledrejection: any
  unload: any
}

export interface HtmlBodyElementEventMap {
  orientationchange: any
}

export interface WindowEventHandlers {
  onafterprint: any
  onbeforeprint: any
  onbeforeunload: any
  ongamepadconnected: any
  ongamepaddisconnected: any
  onhashchange: any
  onlanguagechange: any
  onmessage: any
  onmessageerror: any
  onoffline: any
  ononline: any
  onpagehide: any
  onpageshow: any
  onpopstate: any
  onrejectionhandled: any
  onstorage: any
  onunhandledrejection: any
  onunload: any
}

export function windowEventHandlersAddEventListener30<K>(type: K, listener: (a0: WindowEventHandlers, a1: number) => number, options: Maybe<number>): void {}

export function windowEventHandlersAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function windowEventHandlersRemoveEventListener30<K>(type: K, listener: (a0: WindowEventHandlers, a1: number) => number, options: Maybe<number>): void {}

export function windowEventHandlersRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlBodyElement {
  aLink: any
  background: any
  bgColor: any
  link: any
  onorientationchange: any
  text: any
  vLink: any
}

export function htmlBodyElementAddEventListener30<K>(type: K, listener: (a0: HtmlBodyElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlBodyElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlBodyElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlBodyElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlBodyElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function nodeListItem(index: number): number {
  throw new Error("stub: node-list_item")
}

export interface HtmlFormElement {
  acceptCharset: any
  action: any
  autocomplete: any
  elements: any
  encoding: any
  enctype: any
  length: any
  method: any
  name: any
  noValidate: any
  target: any
}

export function htmlFormElementReset(): void {}

export function htmlFormElementSubmit(): void {}

export function htmlFormElementAddEventListener30<K>(type: K, listener: (a0: HtmlFormElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlFormElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlFormElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlFormElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlFormElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlLabelElement {
  control: any
  form: any
  htmlFor: any
}

export function htmlLabelElementAddEventListener30<K>(type: K, listener: (a0: HtmlLabelElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlLabelElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlLabelElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlLabelElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlLabelElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface NodeListOf<TNode = any> {

}

export function nodeListOfItem<TNode>(index: number): TNode {
  throw new Error("stub: node-list-of_item")
}

export interface HtmlButtonElement {
  disabled: any
  form: any
  formAction: any
  formEnctype: any
  formMethod: any
  formNoValidate: any
  formTarget: any
  labels: any
  name: any
  type: any
  validationMessage: any
  validity: any
  value: any
  willValidate: any
}

export function htmlButtonElementAddEventListener30<K>(type: K, listener: (a0: HtmlButtonElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlButtonElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlButtonElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlButtonElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlButtonElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlImageElement {
  align: any
  alt: any
  border: any
  complete: any
  crossOrigin: any
  currentSrc: any
  decoding: any
  height: any
  hspace: any
  isMap: any
  loading: any
  longDesc: any
  lowsrc: any
  name: any
  naturalHeight: any
  naturalWidth: any
  referrerPolicy: any
  sizes: any
  src: any
  srcset: any
  useMap: any
  vspace: any
  width: any
  x: any
  y: any
}

export function htmlImageElementAddEventListener30<K>(type: K, listener: (a0: HtmlImageElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlImageElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlImageElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlImageElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlImageElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgElementEventMap {

}

export interface ArrayLike<T = any> {
  length: any
}

export interface Float32Array {
  bytesPerElement: any
  buffer: any
  byteLength: any
  byteOffset: any
  length: any
}

export function float32ArrayEvery(predicate: (a0: number, a1: number, a2: Float32Array) => number, thisArg: Maybe<number>): boolean {
  throw new Error("stub: float32-array_every")
}

export function float32ArrayFilter(predicate: (a0: number, a1: number, a2: Float32Array) => number, thisArg: Maybe<number>): Float32Array {
  throw new Error("stub: float32-array_filter")
}

export function float32ArrayMap(callbackfn: (a0: number, a1: number, a2: Float32Array) => number, thisArg: Maybe<number>): Float32Array {
  throw new Error("stub: float32-array_map")
}

export function float32ArrayReduce1(callbackfn: (a0: number, a1: number, a2: number, a3: Float32Array) => number): number {
  throw new Error("stub: float32-array_reduce__1")
}

export function float32ArrayReduce20(callbackfn: (a0: number, a1: number, a2: number, a3: Float32Array) => number, initialValue: number): number {
  throw new Error("stub: float32-array_reduce__2__0")
}

export function float32ArrayReduce21<U>(callbackfn: (a0: U, a1: number, a2: number, a3: Float32Array) => U, initialValue: U): U {
  throw new Error("stub: float32-array_reduce__2__1")
}

export function float32ArrayReduceRight1(callbackfn: (a0: number, a1: number, a2: number, a3: Float32Array) => number): number {
  throw new Error("stub: float32-array_reduce-right__1")
}

export function float32ArrayReduceRight20(callbackfn: (a0: number, a1: number, a2: number, a3: Float32Array) => number, initialValue: number): number {
  throw new Error("stub: float32-array_reduce-right__2__0")
}

export function float32ArrayReduceRight21<U>(callbackfn: (a0: U, a1: number, a2: number, a3: Float32Array) => U, initialValue: U): U {
  throw new Error("stub: float32-array_reduce-right__2__1")
}

export function float32ArraySet(array: ArrayLike<number>, offset: Maybe<number>): void {}

export function float32ArraySlice(start: Maybe<number>, end: Maybe<number>): Float32Array {
  throw new Error("stub: float32-array_slice")
}

export function float32ArraySome(predicate: (a0: number, a1: number, a2: Float32Array) => number, thisArg: Maybe<number>): boolean {
  throw new Error("stub: float32-array_some")
}

export interface Float64Array {
  bytesPerElement: any
  buffer: any
  byteLength: any
  byteOffset: any
  length: any
}

export function float64ArrayEvery(predicate: (a0: number, a1: number, a2: Float64Array) => number, thisArg: Maybe<number>): boolean {
  throw new Error("stub: float64-array_every")
}

export function float64ArrayFilter(predicate: (a0: number, a1: number, a2: Float64Array) => number, thisArg: Maybe<number>): Float64Array {
  throw new Error("stub: float64-array_filter")
}

export function float64ArrayMap(callbackfn: (a0: number, a1: number, a2: Float64Array) => number, thisArg: Maybe<number>): Float64Array {
  throw new Error("stub: float64-array_map")
}

export function float64ArrayReduce1(callbackfn: (a0: number, a1: number, a2: number, a3: Float64Array) => number): number {
  throw new Error("stub: float64-array_reduce__1")
}

export function float64ArrayReduce20(callbackfn: (a0: number, a1: number, a2: number, a3: Float64Array) => number, initialValue: number): number {
  throw new Error("stub: float64-array_reduce__2__0")
}

export function float64ArrayReduce21<U>(callbackfn: (a0: U, a1: number, a2: number, a3: Float64Array) => U, initialValue: U): U {
  throw new Error("stub: float64-array_reduce__2__1")
}

export function float64ArrayReduceRight1(callbackfn: (a0: number, a1: number, a2: number, a3: Float64Array) => number): number {
  throw new Error("stub: float64-array_reduce-right__1")
}

export function float64ArrayReduceRight20(callbackfn: (a0: number, a1: number, a2: number, a3: Float64Array) => number, initialValue: number): number {
  throw new Error("stub: float64-array_reduce-right__2__0")
}

export function float64ArrayReduceRight21<U>(callbackfn: (a0: U, a1: number, a2: number, a3: Float64Array) => U, initialValue: U): U {
  throw new Error("stub: float64-array_reduce-right__2__1")
}

export function float64ArraySet(array: ArrayLike<number>, offset: Maybe<number>): void {}

export function float64ArraySlice(start: Maybe<number>, end: Maybe<number>): Float64Array {
  throw new Error("stub: float64-array_slice")
}

export function float64ArraySome(predicate: (a0: number, a1: number, a2: Float64Array) => number, thisArg: Maybe<number>): boolean {
  throw new Error("stub: float64-array_some")
}

export function domMatrixReadOnlyRotate(rotX: Maybe<number>, rotY: Maybe<number>, rotZ: Maybe<number>): DomMatrix {
  throw new Error("stub: dom-matrix-read-only_rotate")
}

export function domMatrixReadOnlyScale(scaleX: Maybe<number>, scaleY: Maybe<number>, scaleZ: Maybe<number>, originX: Maybe<number>, originY: Maybe<number>, originZ: Maybe<number>): DomMatrix {
  throw new Error("stub: dom-matrix-read-only_scale")
}

export function domMatrixReadOnlyTranslate(tx: Maybe<number>, ty: Maybe<number>, tz: Maybe<number>): DomMatrix {
  throw new Error("stub: dom-matrix-read-only_translate")
}

export interface DomMatrix {

}

export interface DomRect {

}

export function svgTransformListClear(): void {}

export interface HtmlOrSvgElement {
  dataset: any
  nonce: any
  tabIndex: any
}

export function htmlOrSvgElementBlur(): void {}

export function htmlOrSvgElementFocus(options: Maybe<number>): void {}

export interface SvgGeometryElement {
  pathLength: any
}

export function svgGeometryElementAddEventListener30<K>(type: K, listener: (a0: SvgGeometryElement, a1: number) => number, options: Maybe<number>): void {}

export function svgGeometryElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgGeometryElementRemoveEventListener30<K>(type: K, listener: (a0: SvgGeometryElement, a1: number) => number, options: Maybe<number>): void {}

export function svgGeometryElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgCircleElement {
  cx: any
  cy: any
  r: any
}

export function svgCircleElementAddEventListener30<K>(type: K, listener: (a0: SvgCircleElement, a1: number) => number, options: Maybe<number>): void {}

export function svgCircleElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgCircleElementRemoveEventListener30<K>(type: K, listener: (a0: SvgCircleElement, a1: number) => number, options: Maybe<number>): void {}

export function svgCircleElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgEllipseElement {
  cx: any
  cy: any
  rx: any
  ry: any
}

export function svgEllipseElementAddEventListener30<K>(type: K, listener: (a0: SvgEllipseElement, a1: number) => number, options: Maybe<number>): void {}

export function svgEllipseElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgEllipseElementRemoveEventListener30<K>(type: K, listener: (a0: SvgEllipseElement, a1: number) => number, options: Maybe<number>): void {}

export function svgEllipseElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgLineElement {
  x1: any
  x2: any
  y1: any
  y2: any
}

export function svgLineElementAddEventListener30<K>(type: K, listener: (a0: SvgLineElement, a1: number) => number, options: Maybe<number>): void {}

export function svgLineElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgLineElementRemoveEventListener30<K>(type: K, listener: (a0: SvgLineElement, a1: number) => number, options: Maybe<number>): void {}

export function svgLineElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgPathElement {

}

export function svgPathElementAddEventListener30<K>(type: K, listener: (a0: SvgPathElement, a1: number) => number, options: Maybe<number>): void {}

export function svgPathElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgPathElementRemoveEventListener30<K>(type: K, listener: (a0: SvgPathElement, a1: number) => number, options: Maybe<number>): void {}

export function svgPathElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgPointListClear(): void {}

export interface SvgPolygonElement {

}

export function svgPolygonElementAddEventListener30<K>(type: K, listener: (a0: SvgPolygonElement, a1: number) => number, options: Maybe<number>): void {}

export function svgPolygonElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgPolygonElementRemoveEventListener30<K>(type: K, listener: (a0: SvgPolygonElement, a1: number) => number, options: Maybe<number>): void {}

export function svgPolygonElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgPolylineElement {

}

export function svgPolylineElementAddEventListener30<K>(type: K, listener: (a0: SvgPolylineElement, a1: number) => number, options: Maybe<number>): void {}

export function svgPolylineElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgPolylineElementRemoveEventListener30<K>(type: K, listener: (a0: SvgPolylineElement, a1: number) => number, options: Maybe<number>): void {}

export function svgPolylineElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgRectElement {
  height: any
  rx: any
  ry: any
  width: any
  x: any
  y: any
}

export function svgRectElementAddEventListener30<K>(type: K, listener: (a0: SvgRectElement, a1: number) => number, options: Maybe<number>): void {}

export function svgRectElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgRectElementRemoveEventListener30<K>(type: K, listener: (a0: SvgRectElement, a1: number) => number, options: Maybe<number>): void {}

export function svgRectElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgLengthListClear(): void {}

export function svgNumberListClear(): void {}

export interface SvgTextContentElement {
  lengthAdjust: any
  textLength: any
  lengthadjustSpacing: any
  lengthadjustSpacingandglyphs: any
  lengthadjustUnknown: any
}

export function svgTextContentElementAddEventListener30<K>(type: K, listener: (a0: SvgTextContentElement, a1: number) => number, options: Maybe<number>): void {}

export function svgTextContentElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgTextContentElementRemoveEventListener30<K>(type: K, listener: (a0: SvgTextContentElement, a1: number) => number, options: Maybe<number>): void {}

export function svgTextContentElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgTextPositioningElement {
  dx: any
  dy: any
  rotate: any
  x: any
  y: any
}

export function svgTextPositioningElementAddEventListener30<K>(type: K, listener: (a0: SvgTextPositioningElement, a1: number) => number, options: Maybe<number>): void {}

export function svgTextPositioningElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgTextPositioningElementRemoveEventListener30<K>(type: K, listener: (a0: SvgTextPositioningElement, a1: number) => number, options: Maybe<number>): void {}

export function svgTextPositioningElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgTextElement {

}

export function svgTextElementAddEventListener30<K>(type: K, listener: (a0: SvgTextElement, a1: number) => number, options: Maybe<number>): void {}

export function svgTextElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgTextElementRemoveEventListener30<K>(type: K, listener: (a0: SvgTextElement, a1: number) => number, options: Maybe<number>): void {}

export function svgTextElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgUseElement {
  height: any
  width: any
  x: any
  y: any
}

export function svgUseElementAddEventListener30<K>(type: K, listener: (a0: SvgUseElement, a1: number) => number, options: Maybe<number>): void {}

export function svgUseElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgUseElementRemoveEventListener30<K>(type: K, listener: (a0: SvgUseElement, a1: number) => number, options: Maybe<number>): void {}

export function svgUseElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgsvgElementEventMap {

}

export interface SvgsvgElement {
  currentScale: any
  currentTranslate: any
  height: any
  width: any
  x: any
  y: any
}

export function svgsvgElementAddEventListener30<K>(type: K, listener: (a0: SvgsvgElement, a1: number) => number, options: Maybe<number>): void {}

export function svgsvgElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgsvgElementRemoveEventListener30<K>(type: K, listener: (a0: SvgsvgElement, a1: number) => number, options: Maybe<number>): void {}

export function svgsvgElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgElement {
  className: any
  ownerSvgElement: any
  viewportElement: any
}

export function svgElementAddEventListener30<K>(type: K, listener: (a0: SvgElement, a1: number) => number, options: Maybe<number>): void {}

export function svgElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgElementRemoveEventListener30<K>(type: K, listener: (a0: SvgElement, a1: number) => number, options: Maybe<number>): void {}

export function svgElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgStringListClear(): void {}

export interface SvgGraphicsElement {
  transform: any
}

export function svgGraphicsElementAddEventListener30<K>(type: K, listener: (a0: SvgGraphicsElement, a1: number) => number, options: Maybe<number>): void {}

export function svgGraphicsElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgGraphicsElementRemoveEventListener30<K>(type: K, listener: (a0: SvgGraphicsElement, a1: number) => number, options: Maybe<number>): void {}

export function svgGraphicsElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgImageElement {
  height: any
  preserveAspectRatio: any
  width: any
  x: any
  y: any
}

export function svgImageElementAddEventListener30<K>(type: K, listener: (a0: SvgImageElement, a1: number) => number, options: Maybe<number>): void {}

export function svgImageElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgImageElementRemoveEventListener30<K>(type: K, listener: (a0: SvgImageElement, a1: number) => number, options: Maybe<number>): void {}

export function svgImageElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlVideoElementEventMap {
  enterpictureinpicture: any
  leavepictureinpicture: any
}

export interface PictureInPictureWindowEventMap {
  resize: any
}

export interface PictureInPictureWindow {
  height: any
  onresize: any
  width: any
}

export function pictureInPictureWindowAddEventListener30<K>(type: K, listener: (a0: PictureInPictureWindow, a1: number) => number, options: Maybe<number>): void {}

export function pictureInPictureWindowAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function pictureInPictureWindowRemoveEventListener30<K>(type: K, listener: (a0: PictureInPictureWindow, a1: number) => number, options: Maybe<number>): void {}

export function pictureInPictureWindowRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlVideoElement {
  disablePictureInPicture: any
  height: any
  onenterpictureinpicture: any
  onleavepictureinpicture: any
  playsInline: any
  poster: any
  videoHeight: any
  videoWidth: any
  width: any
}

export function htmlVideoElementAddEventListener30<K>(type: K, listener: (a0: HtmlVideoElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlVideoElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlVideoElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlVideoElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlVideoElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface OffscreenCanvas {

}

export function canvasPathEllipse(x: number, y: number, radiusX: number, radiusY: number, rotation: number, startAngle: number, endAngle: number, counterclockwise: Maybe<number>): void {}

export function canvasPathRect(x: number, y: number, w: number, h: number): void {}

export interface Uint8ClampedArray {
  bytesPerElement: any
  buffer: any
  byteLength: any
  byteOffset: any
  length: any
}

export function uint8ClampedArrayEvery(predicate: (a0: number, a1: number, a2: Uint8ClampedArray) => number, thisArg: Maybe<number>): boolean {
  throw new Error("stub: uint8-clamped-array_every")
}

export function uint8ClampedArrayFilter(predicate: (a0: number, a1: number, a2: Uint8ClampedArray) => number, thisArg: Maybe<number>): Uint8ClampedArray {
  throw new Error("stub: uint8-clamped-array_filter")
}

export function uint8ClampedArrayMap(callbackfn: (a0: number, a1: number, a2: Uint8ClampedArray) => number, thisArg: Maybe<number>): Uint8ClampedArray {
  throw new Error("stub: uint8-clamped-array_map")
}

export function uint8ClampedArrayReduce1(callbackfn: (a0: number, a1: number, a2: number, a3: Uint8ClampedArray) => number): number {
  throw new Error("stub: uint8-clamped-array_reduce__1")
}

export function uint8ClampedArrayReduce20(callbackfn: (a0: number, a1: number, a2: number, a3: Uint8ClampedArray) => number, initialValue: number): number {
  throw new Error("stub: uint8-clamped-array_reduce__2__0")
}

export function uint8ClampedArrayReduce21<U>(callbackfn: (a0: U, a1: number, a2: number, a3: Uint8ClampedArray) => U, initialValue: U): U {
  throw new Error("stub: uint8-clamped-array_reduce__2__1")
}

export function uint8ClampedArrayReduceRight1(callbackfn: (a0: number, a1: number, a2: number, a3: Uint8ClampedArray) => number): number {
  throw new Error("stub: uint8-clamped-array_reduce-right__1")
}

export function uint8ClampedArrayReduceRight20(callbackfn: (a0: number, a1: number, a2: number, a3: Uint8ClampedArray) => number, initialValue: number): number {
  throw new Error("stub: uint8-clamped-array_reduce-right__2__0")
}

export function uint8ClampedArrayReduceRight21<U>(callbackfn: (a0: U, a1: number, a2: number, a3: Uint8ClampedArray) => U, initialValue: U): U {
  throw new Error("stub: uint8-clamped-array_reduce-right__2__1")
}

export function uint8ClampedArraySet(array: ArrayLike<number>, offset: Maybe<number>): void {}

export function uint8ClampedArraySlice(start: Maybe<number>, end: Maybe<number>): Uint8ClampedArray {
  throw new Error("stub: uint8-clamped-array_slice")
}

export function uint8ClampedArraySome(predicate: (a0: number, a1: number, a2: Uint8ClampedArray) => number, thisArg: Maybe<number>): boolean {
  throw new Error("stub: uint8-clamped-array_some")
}

export interface ImageData {
  data: any
  height: any
  width: any
}

export function canvasTransformRotate(angle: number): void {}

export function canvasTransformScale(x: number, y: number): void {}

export function canvasTransformTransform(a: number, b: number, c: number, d: number, e: number, f: number): void {}

export function canvasTransformTranslate(x: number, y: number): void {}

export interface GLenum {

}

export interface GLint {

}

export interface GLintptr {

}

export interface GLsizei {

}

export interface GLuint {

}

export interface GLbitfield {

}

export function webGlRenderingContextBaseClear(mask: GLbitfield): void {}

export function webGlRenderingContextBaseFinish(): void {}

export function webGlRenderingContextBaseViewport(x: GLint, y: GLint, width: GLsizei, height: GLsizei): void {}

export interface GLsizeiptr {

}

export interface Int32Array {
  bytesPerElement: any
  buffer: any
  byteLength: any
  byteOffset: any
  length: any
}

export function int32ArrayEvery(predicate: (a0: number, a1: number, a2: Int32Array) => number, thisArg: Maybe<number>): boolean {
  throw new Error("stub: int32-array_every")
}

export function int32ArrayFilter(predicate: (a0: number, a1: number, a2: Int32Array) => number, thisArg: Maybe<number>): Int32Array {
  throw new Error("stub: int32-array_filter")
}

export function int32ArrayMap(callbackfn: (a0: number, a1: number, a2: Int32Array) => number, thisArg: Maybe<number>): Int32Array {
  throw new Error("stub: int32-array_map")
}

export function int32ArrayReduce1(callbackfn: (a0: number, a1: number, a2: number, a3: Int32Array) => number): number {
  throw new Error("stub: int32-array_reduce__1")
}

export function int32ArrayReduce20(callbackfn: (a0: number, a1: number, a2: number, a3: Int32Array) => number, initialValue: number): number {
  throw new Error("stub: int32-array_reduce__2__0")
}

export function int32ArrayReduce21<U>(callbackfn: (a0: U, a1: number, a2: number, a3: Int32Array) => U, initialValue: U): U {
  throw new Error("stub: int32-array_reduce__2__1")
}

export function int32ArrayReduceRight1(callbackfn: (a0: number, a1: number, a2: number, a3: Int32Array) => number): number {
  throw new Error("stub: int32-array_reduce-right__1")
}

export function int32ArrayReduceRight20(callbackfn: (a0: number, a1: number, a2: number, a3: Int32Array) => number, initialValue: number): number {
  throw new Error("stub: int32-array_reduce-right__2__0")
}

export function int32ArrayReduceRight21<U>(callbackfn: (a0: U, a1: number, a2: number, a3: Int32Array) => U, initialValue: U): U {
  throw new Error("stub: int32-array_reduce-right__2__1")
}

export function int32ArraySet(array: ArrayLike<number>, offset: Maybe<number>): void {}

export function int32ArraySlice(start: Maybe<number>, end: Maybe<number>): Int32Array {
  throw new Error("stub: int32-array_slice")
}

export function int32ArraySome(predicate: (a0: number, a1: number, a2: Int32Array) => number, thisArg: Maybe<number>): boolean {
  throw new Error("stub: int32-array_some")
}

export interface TexImageSource {

}

export function webGlRenderingContextOverloadsBufferData30(target: GLenum, size: GLsizeiptr, usage: GLenum): void {}

export function webGlRenderingContextOverloadsBufferData31(target: GLenum, data: number, usage: GLenum): void {}

export function webGlRenderingContextOverloadsReadPixels(x: GLint, y: GLint, width: GLsizei, height: GLsizei, format: GLenum, type: GLenum, pixels: number): void {}

export function webGlRenderingContextOverloadsTexImage2D9(target: GLenum, level: GLint, internalformat: GLint, width: GLsizei, height: GLsizei, border: GLint, format: GLenum, type: GLenum, pixels: number): void {}

export function webGlRenderingContextOverloadsTexImage2D6(target: GLenum, level: GLint, internalformat: GLint, format: GLenum, type: GLenum, source: TexImageSource): void {}

export function webGlRenderingContextOverloadsTexSubImage2D9(target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, width: GLsizei, height: GLsizei, format: GLenum, type: GLenum, pixels: number): void {}

export function webGlRenderingContextOverloadsTexSubImage2D7(target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, format: GLenum, type: GLenum, source: TexImageSource): void {}

export interface Uint32Array {
  bytesPerElement: any
  buffer: any
  byteLength: any
  byteOffset: any
  length: any
}

export function uint32ArrayEvery(predicate: (a0: number, a1: number, a2: Uint32Array) => number, thisArg: Maybe<number>): boolean {
  throw new Error("stub: uint32-array_every")
}

export function uint32ArrayFilter(predicate: (a0: number, a1: number, a2: Uint32Array) => number, thisArg: Maybe<number>): Uint32Array {
  throw new Error("stub: uint32-array_filter")
}

export function uint32ArrayMap(callbackfn: (a0: number, a1: number, a2: Uint32Array) => number, thisArg: Maybe<number>): Uint32Array {
  throw new Error("stub: uint32-array_map")
}

export function uint32ArrayReduce1(callbackfn: (a0: number, a1: number, a2: number, a3: Uint32Array) => number): number {
  throw new Error("stub: uint32-array_reduce__1")
}

export function uint32ArrayReduce20(callbackfn: (a0: number, a1: number, a2: number, a3: Uint32Array) => number, initialValue: number): number {
  throw new Error("stub: uint32-array_reduce__2__0")
}

export function uint32ArrayReduce21<U>(callbackfn: (a0: U, a1: number, a2: number, a3: Uint32Array) => U, initialValue: U): U {
  throw new Error("stub: uint32-array_reduce__2__1")
}

export function uint32ArrayReduceRight1(callbackfn: (a0: number, a1: number, a2: number, a3: Uint32Array) => number): number {
  throw new Error("stub: uint32-array_reduce-right__1")
}

export function uint32ArrayReduceRight20(callbackfn: (a0: number, a1: number, a2: number, a3: Uint32Array) => number, initialValue: number): number {
  throw new Error("stub: uint32-array_reduce-right__2__0")
}

export function uint32ArrayReduceRight21<U>(callbackfn: (a0: U, a1: number, a2: number, a3: Uint32Array) => U, initialValue: U): U {
  throw new Error("stub: uint32-array_reduce-right__2__1")
}

export function uint32ArraySet(array: ArrayLike<number>, offset: Maybe<number>): void {}

export function uint32ArraySlice(start: Maybe<number>, end: Maybe<number>): Uint32Array {
  throw new Error("stub: uint32-array_slice")
}

export function uint32ArraySome(predicate: (a0: number, a1: number, a2: Uint32Array) => number, thisArg: Maybe<number>): boolean {
  throw new Error("stub: uint32-array_some")
}

export function webGl2RenderingContextBaseTexImage3D100(target: GLenum, level: GLint, internalformat: GLint, width: GLsizei, height: GLsizei, depth: GLsizei, border: GLint, format: GLenum, type: GLenum, pboOffset: GLintptr): void {}

export function webGl2RenderingContextBaseTexImage3D101(target: GLenum, level: GLint, internalformat: GLint, width: GLsizei, height: GLsizei, depth: GLsizei, border: GLint, format: GLenum, type: GLenum, source: TexImageSource): void {}

export function webGl2RenderingContextBaseTexImage3D102(target: GLenum, level: GLint, internalformat: GLint, width: GLsizei, height: GLsizei, depth: GLsizei, border: GLint, format: GLenum, type: GLenum, srcData: number): void {}

export function webGl2RenderingContextBaseTexImage3D11(target: GLenum, level: GLint, internalformat: GLint, width: GLsizei, height: GLsizei, depth: GLsizei, border: GLint, format: GLenum, type: GLenum, srcData: ArrayBufferView, srcOffset: GLuint): void {}

export function webGl2RenderingContextBaseTexSubImage3D110(target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, zoffset: GLint, width: GLsizei, height: GLsizei, depth: GLsizei, format: GLenum, type: GLenum, pboOffset: GLintptr): void {}

export function webGl2RenderingContextBaseTexSubImage3D111(target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, zoffset: GLint, width: GLsizei, height: GLsizei, depth: GLsizei, format: GLenum, type: GLenum, source: TexImageSource): void {}

export function webGl2RenderingContextBaseTexSubImage3D12(target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, zoffset: GLint, width: GLsizei, height: GLsizei, depth: GLsizei, format: GLenum, type: GLenum, srcData: number, srcOffset: Maybe<number>): void {}

export function webGl2RenderingContextOverloadsBufferData30(target: GLenum, size: GLsizeiptr, usage: GLenum): void {}

export function webGl2RenderingContextOverloadsBufferData31(target: GLenum, srcData: number, usage: GLenum): void {}

export function webGl2RenderingContextOverloadsBufferData5(target: GLenum, srcData: ArrayBufferView, usage: GLenum, srcOffset: GLuint, length: Maybe<number>): void {}

export function webGl2RenderingContextOverloadsReadPixels70(x: GLint, y: GLint, width: GLsizei, height: GLsizei, format: GLenum, type: GLenum, dstData: number): void {}

export function webGl2RenderingContextOverloadsReadPixels71(x: GLint, y: GLint, width: GLsizei, height: GLsizei, format: GLenum, type: GLenum, offset: GLintptr): void {}

export function webGl2RenderingContextOverloadsReadPixels8(x: GLint, y: GLint, width: GLsizei, height: GLsizei, format: GLenum, type: GLenum, dstData: ArrayBufferView, dstOffset: GLuint): void {}

export function webGl2RenderingContextOverloadsTexImage2D90(target: GLenum, level: GLint, internalformat: GLint, width: GLsizei, height: GLsizei, border: GLint, format: GLenum, type: GLenum, pixels: number): void {}

export function webGl2RenderingContextOverloadsTexImage2D6(target: GLenum, level: GLint, internalformat: GLint, format: GLenum, type: GLenum, source: TexImageSource): void {}

export function webGl2RenderingContextOverloadsTexImage2D91(target: GLenum, level: GLint, internalformat: GLint, width: GLsizei, height: GLsizei, border: GLint, format: GLenum, type: GLenum, pboOffset: GLintptr): void {}

export function webGl2RenderingContextOverloadsTexImage2D92(target: GLenum, level: GLint, internalformat: GLint, width: GLsizei, height: GLsizei, border: GLint, format: GLenum, type: GLenum, source: TexImageSource): void {}

export function webGl2RenderingContextOverloadsTexImage2D10(target: GLenum, level: GLint, internalformat: GLint, width: GLsizei, height: GLsizei, border: GLint, format: GLenum, type: GLenum, srcData: ArrayBufferView, srcOffset: GLuint): void {}

export function webGl2RenderingContextOverloadsTexSubImage2D90(target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, width: GLsizei, height: GLsizei, format: GLenum, type: GLenum, pixels: number): void {}

export function webGl2RenderingContextOverloadsTexSubImage2D7(target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, format: GLenum, type: GLenum, source: TexImageSource): void {}

export function webGl2RenderingContextOverloadsTexSubImage2D91(target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, width: GLsizei, height: GLsizei, format: GLenum, type: GLenum, pboOffset: GLintptr): void {}

export function webGl2RenderingContextOverloadsTexSubImage2D92(target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, width: GLsizei, height: GLsizei, format: GLenum, type: GLenum, source: TexImageSource): void {}

export function webGl2RenderingContextOverloadsTexSubImage2D10(target: GLenum, level: GLint, xoffset: GLint, yoffset: GLint, width: GLsizei, height: GLsizei, format: GLenum, type: GLenum, srcData: ArrayBufferView, srcOffset: GLuint): void {}

export interface HtmlCanvasElement {
  height: any
  width: any
}

export function htmlCanvasElementAddEventListener30<K>(type: K, listener: (a0: HtmlCanvasElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlCanvasElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlCanvasElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlCanvasElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlCanvasElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlDataElement {
  value: any
}

export function htmlDataElementAddEventListener30<K>(type: K, listener: (a0: HtmlDataElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlDataElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlDataElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlDataElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlDataElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlCollectionOf<T = any> {

}

export function htmlCollectionOfItem<T>(index: number): number {
  throw new Error("stub: html-collection-of_item")
}

export interface HtmlOptionElement {
  defaultSelected: any
  disabled: any
  form: any
  index: any
  label: any
  selected: any
  text: any
  value: any
}

export function htmlOptionElementAddEventListener30<K>(type: K, listener: (a0: HtmlOptionElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlOptionElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlOptionElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlOptionElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlOptionElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlDataListElement {
  options: any
}

export function htmlDataListElementAddEventListener30<K>(type: K, listener: (a0: HtmlDataListElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlDataListElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlDataListElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlDataListElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlDataListElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlDetailsElement {
  open: any
}

export function htmlDetailsElementAddEventListener30<K>(type: K, listener: (a0: HtmlDetailsElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlDetailsElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlDetailsElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlDetailsElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlDetailsElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlDialogElement {

}

export function htmlDialogElementAddEventListener30<K>(type: K, listener: (a0: HtmlDialogElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlDialogElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlDialogElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlDialogElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlDialogElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlDirectoryElement {
  compact: any
}

export function htmlDirectoryElementAddEventListener30<K>(type: K, listener: (a0: HtmlDirectoryElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlDirectoryElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlDirectoryElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlDirectoryElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlDirectoryElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlDivElement {
  align: any
}

export function htmlDivElementAddEventListener30<K>(type: K, listener: (a0: HtmlDivElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlDivElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlDivElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlDivElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlDivElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlEmbedElement {
  align: any
  height: any
  name: any
  src: any
  type: any
  width: any
}

export function htmlEmbedElementAddEventListener30<K>(type: K, listener: (a0: HtmlEmbedElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlEmbedElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlEmbedElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlEmbedElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlEmbedElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlFieldSetElement {
  disabled: any
  elements: any
  form: any
  name: any
  type: any
  validationMessage: any
  validity: any
  willValidate: any
}

export function htmlFieldSetElementAddEventListener30<K>(type: K, listener: (a0: HtmlFieldSetElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlFieldSetElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlFieldSetElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlFieldSetElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlFieldSetElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlFontElement {
  color: any
  face: any
  size: any
}

export function htmlFontElementAddEventListener30<K>(type: K, listener: (a0: HtmlFontElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlFontElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlFontElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlFontElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlFontElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlFrameElement {
  contentDocument: any
  contentWindow: any
  frameBorder: any
  longDesc: any
  marginHeight: any
  marginWidth: any
  name: any
  noResize: any
  scrolling: any
  src: any
}

export function htmlFrameElementAddEventListener30<K>(type: K, listener: (a0: HtmlFrameElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlFrameElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlFrameElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlFrameElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlFrameElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlFrameSetElementEventMap {

}

export interface HtmlFrameSetElement {
  cols: any
  rows: any
}

export function htmlFrameSetElementAddEventListener30<K>(type: K, listener: (a0: HtmlFrameSetElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlFrameSetElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlFrameSetElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlFrameSetElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlFrameSetElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlHeadElement {

}

export function htmlHeadElementAddEventListener30<K>(type: K, listener: (a0: HtmlHeadElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlHeadElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlHeadElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlHeadElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlHeadElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlHeadingElement {
  align: any
}

export function htmlHeadingElementAddEventListener30<K>(type: K, listener: (a0: HtmlHeadingElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlHeadingElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlHeadingElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlHeadingElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlHeadingElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlHtmlElement {
  version: any
}

export function htmlHtmlElementAddEventListener30<K>(type: K, listener: (a0: HtmlHtmlElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlHtmlElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlHtmlElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlHtmlElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlHtmlElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface DateForm {

}

export interface HtmlInputElement {
  accept: any
  align: any
  alt: any
  autocomplete: any
  capture: any
  checked: any
  defaultChecked: any
  defaultValue: any
  dirName: any
  disabled: any
  files: any
  form: any
  formAction: any
  formEnctype: any
  formMethod: any
  formNoValidate: any
  formTarget: any
  height: any
  indeterminate: any
  labels: any
  list: any
  max: any
  maxLength: any
  min: any
  minLength: any
  multiple: any
  name: any
  pattern: any
  placeholder: any
  readOnly: any
  required: any
  selectionDirection: any
  selectionEnd: any
  selectionStart: any
  size: any
  src: any
  step: any
  type: any
  useMap: any
  validationMessage: any
  validity: any
  value: any
  valueAsDate: any
  valueAsNumber: any
  webkitEntries: any
  webkitdirectory: any
  width: any
  willValidate: any
}

export function htmlInputElementSelect(): void {}

export function htmlInputElementAddEventListener30<K>(type: K, listener: (a0: HtmlInputElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlInputElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlInputElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlInputElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlInputElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlLegendElement {
  align: any
  form: any
}

export function htmlLegendElementAddEventListener30<K>(type: K, listener: (a0: HtmlLegendElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlLegendElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlLegendElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlLegendElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlLegendElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlLinkElement {
  as: any
  charset: any
  crossOrigin: any
  disabled: any
  href: any
  hreflang: any
  imageSizes: any
  imageSrcset: any
  integrity: any
  media: any
  referrerPolicy: any
  rel: any
  relList: any
  rev: any
  sizes: any
  target: any
  type: any
}

export function htmlLinkElementAddEventListener30<K>(type: K, listener: (a0: HtmlLinkElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlLinkElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlLinkElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlLinkElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlLinkElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlMapElement {
  areas: any
  name: any
}

export function htmlMapElementAddEventListener30<K>(type: K, listener: (a0: HtmlMapElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlMapElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlMapElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlMapElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlMapElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlMarqueeElement {
  behavior: any
  bgColor: any
  direction: any
  height: any
  hspace: any
  loop: any
  scrollAmount: any
  scrollDelay: any
  trueSpeed: any
  vspace: any
  width: any
}

export function htmlMarqueeElementStart(): void {}

export function htmlMarqueeElementStop(): void {}

export function htmlMarqueeElementAddEventListener30<K>(type: K, listener: (a0: HtmlMarqueeElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlMarqueeElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlMarqueeElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlMarqueeElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlMarqueeElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlMenuElement {
  compact: any
}

export function htmlMenuElementAddEventListener30<K>(type: K, listener: (a0: HtmlMenuElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlMenuElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlMenuElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlMenuElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlMenuElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlMetaElement {
  content: any
  httpEquiv: any
  name: any
  scheme: any
}

export function htmlMetaElementAddEventListener30<K>(type: K, listener: (a0: HtmlMetaElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlMetaElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlMetaElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlMetaElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlMetaElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlMeterElement {
  high: any
  labels: any
  low: any
  max: any
  min: any
  optimum: any
  value: any
}

export function htmlMeterElementAddEventListener30<K>(type: K, listener: (a0: HtmlMeterElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlMeterElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlMeterElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlMeterElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlMeterElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlModElement {
  cite: any
  dateTime: any
}

export function htmlModElementAddEventListener30<K>(type: K, listener: (a0: HtmlModElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlModElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlModElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlModElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlModElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlObjectElement {
  align: any
  archive: any
  border: any
  code: any
  codeBase: any
  codeType: any
  contentDocument: any
  contentWindow: any
  data: any
  declare: any
  form: any
  height: any
  hspace: any
  name: any
  standby: any
  type: any
  useMap: any
  validationMessage: any
  validity: any
  vspace: any
  width: any
  willValidate: any
}

export function htmlObjectElementAddEventListener30<K>(type: K, listener: (a0: HtmlObjectElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlObjectElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlObjectElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlObjectElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlObjectElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlOptGroupElement {
  disabled: any
  label: any
}

export function htmlOptGroupElementAddEventListener30<K>(type: K, listener: (a0: HtmlOptGroupElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlOptGroupElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlOptGroupElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlOptGroupElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlOptGroupElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlOutputElement {
  defaultValue: any
  form: any
  htmlFor: any
  labels: any
  name: any
  type: any
  validationMessage: any
  validity: any
  value: any
  willValidate: any
}

export function htmlOutputElementAddEventListener30<K>(type: K, listener: (a0: HtmlOutputElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlOutputElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlOutputElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlOutputElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlOutputElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlParagraphElement {
  align: any
}

export function htmlParagraphElementAddEventListener30<K>(type: K, listener: (a0: HtmlParagraphElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlParagraphElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlParagraphElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlParagraphElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlParagraphElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlParamElement {
  name: any
  type: any
  value: any
  valueType: any
}

export function htmlParamElementAddEventListener30<K>(type: K, listener: (a0: HtmlParamElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlParamElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlParamElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlParamElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlParamElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlPictureElement {

}

export function htmlPictureElementAddEventListener30<K>(type: K, listener: (a0: HtmlPictureElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlPictureElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlPictureElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlPictureElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlPictureElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlPreElement {
  width: any
}

export function htmlPreElementAddEventListener30<K>(type: K, listener: (a0: HtmlPreElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlPreElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlPreElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlPreElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlPreElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlProgressElement {
  labels: any
  max: any
  position: any
  value: any
}

export function htmlProgressElementAddEventListener30<K>(type: K, listener: (a0: HtmlProgressElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlProgressElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlProgressElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlProgressElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlProgressElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlQuoteElement {
  cite: any
}

export function htmlQuoteElementAddEventListener30<K>(type: K, listener: (a0: HtmlQuoteElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlQuoteElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlQuoteElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlQuoteElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlQuoteElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlScriptElement {
  async: any
  charset: any
  crossOrigin: any
  defer: any
  event: any
  htmlFor: any
  integrity: any
  noModule: any
  referrerPolicy: any
  src: any
  text: any
  type: any
}

export function htmlScriptElementAddEventListener30<K>(type: K, listener: (a0: HtmlScriptElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlScriptElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlScriptElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlScriptElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlScriptElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlOptionsCollectionRemove(index: number): void {}

export interface HtmlSelectElement {
  autocomplete: any
  disabled: any
  form: any
  labels: any
  length: any
  multiple: any
  name: any
  options: any
  required: any
  selectedIndex: any
  selectedOptions: any
  size: any
  type: any
  validationMessage: any
  validity: any
  value: any
  willValidate: any
}

export function htmlSelectElementItem(index: number): number {
  throw new Error("stub: html-select-element_item")
}

export function htmlSelectElementRemove0(): void {}

export function htmlSelectElementRemove1(index: number): void {}

export function htmlSelectElementAddEventListener30<K>(type: K, listener: (a0: HtmlSelectElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlSelectElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlSelectElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlSelectElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlSelectElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlSlotElement {
  name: any
}

export function htmlSlotElementAddEventListener30<K>(type: K, listener: (a0: HtmlSlotElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlSlotElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlSlotElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlSlotElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlSlotElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlSourceElement {
  media: any
  sizes: any
  src: any
  srcset: any
  type: any
}

export function htmlSourceElementAddEventListener30<K>(type: K, listener: (a0: HtmlSourceElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlSourceElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlSourceElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlSourceElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlSourceElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlSpanElement {

}

export function htmlSpanElementAddEventListener30<K>(type: K, listener: (a0: HtmlSpanElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlSpanElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlSpanElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlSpanElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlSpanElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlStyleElement {
  media: any
  type: any
}

export function htmlStyleElementAddEventListener30<K>(type: K, listener: (a0: HtmlStyleElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlStyleElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlStyleElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlStyleElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlStyleElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlTableCaptionElement {
  align: any
}

export function htmlTableCaptionElementAddEventListener30<K>(type: K, listener: (a0: HtmlTableCaptionElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTableCaptionElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlTableCaptionElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlTableCaptionElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTableCaptionElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlTableCellElement {
  abbr: any
  align: any
  axis: any
  bgColor: any
  cellIndex: any
  ch: any
  chOff: any
  colSpan: any
  headers: any
  height: any
  noWrap: any
  rowSpan: any
  scope: any
  vAlign: any
  width: any
}

export function htmlTableCellElementAddEventListener30<K>(type: K, listener: (a0: HtmlTableCellElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTableCellElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlTableCellElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlTableCellElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTableCellElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlTableColElement {
  align: any
  ch: any
  chOff: any
  span: any
  vAlign: any
  width: any
}

export function htmlTableColElementAddEventListener30<K>(type: K, listener: (a0: HtmlTableColElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTableColElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlTableColElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlTableColElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTableColElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlTableRowElement {
  align: any
  bgColor: any
  cells: any
  ch: any
  chOff: any
  rowIndex: any
  sectionRowIndex: any
  vAlign: any
}

export function htmlTableRowElementAddEventListener30<K>(type: K, listener: (a0: HtmlTableRowElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTableRowElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlTableRowElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlTableRowElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTableRowElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlTableSectionElement {
  align: any
  ch: any
  chOff: any
  rows: any
  vAlign: any
}

export function htmlTableSectionElementAddEventListener30<K>(type: K, listener: (a0: HtmlTableSectionElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTableSectionElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlTableSectionElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlTableSectionElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTableSectionElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlTableElement {
  align: any
  bgColor: any
  border: any
  caption: any
  cellPadding: any
  cellSpacing: any
  frame: any
  rows: any
  rules: any
  summary: any
  tBodies: any
  tFoot: any
  tHead: any
  width: any
}

export function htmlTableElementAddEventListener30<K>(type: K, listener: (a0: HtmlTableElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTableElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlTableElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlTableElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTableElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlTemplateElement {
  content: any
}

export function htmlTemplateElementAddEventListener30<K>(type: K, listener: (a0: HtmlTemplateElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTemplateElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlTemplateElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlTemplateElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTemplateElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlTextAreaElement {
  autocomplete: any
  cols: any
  defaultValue: any
  dirName: any
  disabled: any
  form: any
  labels: any
  maxLength: any
  minLength: any
  name: any
  placeholder: any
  readOnly: any
  required: any
  rows: any
  selectionDirection: any
  selectionEnd: any
  selectionStart: any
  textLength: any
  type: any
  validationMessage: any
  validity: any
  value: any
  willValidate: any
  wrap: any
}

export function htmlTextAreaElementSelect(): void {}

export function htmlTextAreaElementAddEventListener30<K>(type: K, listener: (a0: HtmlTextAreaElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTextAreaElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlTextAreaElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlTextAreaElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTextAreaElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlTimeElement {
  dateTime: any
}

export function htmlTimeElementAddEventListener30<K>(type: K, listener: (a0: HtmlTimeElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTimeElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlTimeElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlTimeElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTimeElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlTitleElement {
  text: any
}

export function htmlTitleElementAddEventListener30<K>(type: K, listener: (a0: HtmlTitleElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTitleElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlTitleElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlTitleElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTitleElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlTrackElement {
  default: any
  kind: any
  label: any
  readyState: any
  src: any
  srclang: any
  track: any
  error: any
  loaded: any
  loading: any
  none: any
}

export function htmlTrackElementAddEventListener30<K>(type: K, listener: (a0: HtmlTrackElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTrackElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlTrackElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlTrackElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlTrackElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlbrElement {
  clear: any
}

export function htmlbrElementAddEventListener30<K>(type: K, listener: (a0: HtmlbrElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlbrElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlbrElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlbrElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlbrElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmldListElement {
  compact: any
}

export function htmldListElementAddEventListener30<K>(type: K, listener: (a0: HtmldListElement, a1: number) => number, options: Maybe<number>): void {}

export function htmldListElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmldListElementRemoveEventListener30<K>(type: K, listener: (a0: HtmldListElement, a1: number) => number, options: Maybe<number>): void {}

export function htmldListElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlhrElement {
  align: any
  color: any
  noShade: any
  size: any
  width: any
}

export function htmlhrElementAddEventListener30<K>(type: K, listener: (a0: HtmlhrElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlhrElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlhrElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlhrElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlhrElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface ReferrerPolicy {

}

export interface HtmliFrameElement {
  align: any
  allow: any
  allowFullscreen: any
  contentDocument: any
  contentWindow: any
  frameBorder: any
  height: any
  longDesc: any
  marginHeight: any
  marginWidth: any
  name: any
  referrerPolicy: any
  sandbox: any
  scrolling: any
  src: any
  srcdoc: any
  width: any
}

export function htmliFrameElementAddEventListener30<K>(type: K, listener: (a0: HtmliFrameElement, a1: number) => number, options: Maybe<number>): void {}

export function htmliFrameElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmliFrameElementRemoveEventListener30<K>(type: K, listener: (a0: HtmliFrameElement, a1: number) => number, options: Maybe<number>): void {}

export function htmliFrameElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlliElement {
  type: any
  value: any
}

export function htmlliElementAddEventListener30<K>(type: K, listener: (a0: HtmlliElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlliElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlliElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlliElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlliElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmloListElement {
  compact: any
  reversed: any
  start: any
  type: any
}

export function htmloListElementAddEventListener30<K>(type: K, listener: (a0: HtmloListElement, a1: number) => number, options: Maybe<number>): void {}

export function htmloListElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmloListElementRemoveEventListener30<K>(type: K, listener: (a0: HtmloListElement, a1: number) => number, options: Maybe<number>): void {}

export function htmloListElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmluListElement {
  compact: any
  type: any
}

export function htmluListElementAddEventListener30<K>(type: K, listener: (a0: HtmluListElement, a1: number) => number, options: Maybe<number>): void {}

export function htmluListElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmluListElementRemoveEventListener30<K>(type: K, listener: (a0: HtmluListElement, a1: number) => number, options: Maybe<number>): void {}

export function htmluListElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlElementTagNameMap {
  a: any
  abbr: any
  address: any
  area: any
  article: any
  aside: any
  audio: any
  b: any
  base: any
  bdi: any
  bdo: any
  blockquote: any
  body: any
  br: any
  button: any
  canvas: any
  caption: any
  cite: any
  code: any
  col: any
  colgroup: any
  data: any
  datalist: any
  dd: any
  del: any
  details: any
  dfn: any
  dialog: any
  dir: any
  div: any
  dl: any
  dt: any
  em: any
  embed: any
  fieldset: any
  figcaption: any
  figure: any
  font: any
  footer: any
  form: any
  frame: any
  frameset: any
  h1: any
  h2: any
  h3: any
  h4: any
  h5: any
  h6: any
  head: any
  header: any
  hgroup: any
  hr: any
  html: any
  i: any
  iframe: any
  img: any
  input: any
  ins: any
  kbd: any
  label: any
  legend: any
  li: any
  link: any
  main: any
  map: any
  mark: any
  marquee: any
  menu: any
  meta: any
  meter: any
  nav: any
  noscript: any
  object: any
  ol: any
  optgroup: any
  option: any
  output: any
  p: any
  param: any
  picture: any
  pre: any
  progress: any
  q: any
  rp: any
  rt: any
  ruby: any
  s: any
  samp: any
  script: any
  section: any
  select: any
  slot: any
  small: any
  source: any
  span: any
  strong: any
  style: any
  sub: any
  summary: any
  sup: any
  table: any
  tbody: any
  td: any
  template: any
  textarea: any
  tfoot: any
  th: any
  thead: any
  time: any
  title: any
  tr: any
  track: any
  u: any
  ul: any
  var: any
  video: any
  wbr: any
}

export interface SvgAnimationElement {
  targetElement: any
}

export function svgAnimationElementAddEventListener30<K>(type: K, listener: (a0: SvgAnimationElement, a1: number) => number, options: Maybe<number>): void {}

export function svgAnimationElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgAnimationElementRemoveEventListener30<K>(type: K, listener: (a0: SvgAnimationElement, a1: number) => number, options: Maybe<number>): void {}

export function svgAnimationElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgAnimateElement {

}

export function svgAnimateElementAddEventListener30<K>(type: K, listener: (a0: SvgAnimateElement, a1: number) => number, options: Maybe<number>): void {}

export function svgAnimateElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgAnimateElementRemoveEventListener30<K>(type: K, listener: (a0: SvgAnimateElement, a1: number) => number, options: Maybe<number>): void {}

export function svgAnimateElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgAnimateMotionElement {

}

export function svgAnimateMotionElementAddEventListener30<K>(type: K, listener: (a0: SvgAnimateMotionElement, a1: number) => number, options: Maybe<number>): void {}

export function svgAnimateMotionElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgAnimateMotionElementRemoveEventListener30<K>(type: K, listener: (a0: SvgAnimateMotionElement, a1: number) => number, options: Maybe<number>): void {}

export function svgAnimateMotionElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgAnimateTransformElement {

}

export function svgAnimateTransformElementAddEventListener30<K>(type: K, listener: (a0: SvgAnimateTransformElement, a1: number) => number, options: Maybe<number>): void {}

export function svgAnimateTransformElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgAnimateTransformElementRemoveEventListener30<K>(type: K, listener: (a0: SvgAnimateTransformElement, a1: number) => number, options: Maybe<number>): void {}

export function svgAnimateTransformElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgClipPathElement {
  clipPathUnits: any
  transform: any
}

export function svgClipPathElementAddEventListener30<K>(type: K, listener: (a0: SvgClipPathElement, a1: number) => number, options: Maybe<number>): void {}

export function svgClipPathElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgClipPathElementRemoveEventListener30<K>(type: K, listener: (a0: SvgClipPathElement, a1: number) => number, options: Maybe<number>): void {}

export function svgClipPathElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgDefsElement {

}

export function svgDefsElementAddEventListener30<K>(type: K, listener: (a0: SvgDefsElement, a1: number) => number, options: Maybe<number>): void {}

export function svgDefsElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgDefsElementRemoveEventListener30<K>(type: K, listener: (a0: SvgDefsElement, a1: number) => number, options: Maybe<number>): void {}

export function svgDefsElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgDescElement {

}

export function svgDescElementAddEventListener30<K>(type: K, listener: (a0: SvgDescElement, a1: number) => number, options: Maybe<number>): void {}

export function svgDescElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgDescElementRemoveEventListener30<K>(type: K, listener: (a0: SvgDescElement, a1: number) => number, options: Maybe<number>): void {}

export function svgDescElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgFilterElement {
  filterUnits: any
  height: any
  primitiveUnits: any
  width: any
  x: any
  y: any
}

export function svgFilterElementAddEventListener30<K>(type: K, listener: (a0: SvgFilterElement, a1: number) => number, options: Maybe<number>): void {}

export function svgFilterElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgFilterElementRemoveEventListener30<K>(type: K, listener: (a0: SvgFilterElement, a1: number) => number, options: Maybe<number>): void {}

export function svgFilterElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgForeignObjectElement {
  height: any
  width: any
  x: any
  y: any
}

export function svgForeignObjectElementAddEventListener30<K>(type: K, listener: (a0: SvgForeignObjectElement, a1: number) => number, options: Maybe<number>): void {}

export function svgForeignObjectElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgForeignObjectElementRemoveEventListener30<K>(type: K, listener: (a0: SvgForeignObjectElement, a1: number) => number, options: Maybe<number>): void {}

export function svgForeignObjectElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgGradientElement {
  gradientTransform: any
  gradientUnits: any
  spreadMethod: any
  svgSpreadmethodPad: any
  svgSpreadmethodReflect: any
  svgSpreadmethodRepeat: any
  svgSpreadmethodUnknown: any
}

export function svgGradientElementAddEventListener30<K>(type: K, listener: (a0: SvgGradientElement, a1: number) => number, options: Maybe<number>): void {}

export function svgGradientElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgGradientElementRemoveEventListener30<K>(type: K, listener: (a0: SvgGradientElement, a1: number) => number, options: Maybe<number>): void {}

export function svgGradientElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgLinearGradientElement {
  x1: any
  x2: any
  y1: any
  y2: any
}

export function svgLinearGradientElementAddEventListener30<K>(type: K, listener: (a0: SvgLinearGradientElement, a1: number) => number, options: Maybe<number>): void {}

export function svgLinearGradientElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgLinearGradientElementRemoveEventListener30<K>(type: K, listener: (a0: SvgLinearGradientElement, a1: number) => number, options: Maybe<number>): void {}

export function svgLinearGradientElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgMarkerElement {
  markerHeight: any
  markerUnits: any
  markerWidth: any
  orientAngle: any
  orientType: any
  refX: any
  refY: any
  svgMarkerunitsStrokewidth: any
  svgMarkerunitsUnknown: any
  svgMarkerunitsUserspaceonuse: any
  svgMarkerOrientAngle: any
  svgMarkerOrientAuto: any
  svgMarkerOrientUnknown: any
}

export function svgMarkerElementAddEventListener30<K>(type: K, listener: (a0: SvgMarkerElement, a1: number) => number, options: Maybe<number>): void {}

export function svgMarkerElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgMarkerElementRemoveEventListener30<K>(type: K, listener: (a0: SvgMarkerElement, a1: number) => number, options: Maybe<number>): void {}

export function svgMarkerElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgMaskElement {
  height: any
  maskContentUnits: any
  maskUnits: any
  width: any
  x: any
  y: any
}

export function svgMaskElementAddEventListener30<K>(type: K, listener: (a0: SvgMaskElement, a1: number) => number, options: Maybe<number>): void {}

export function svgMaskElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgMaskElementRemoveEventListener30<K>(type: K, listener: (a0: SvgMaskElement, a1: number) => number, options: Maybe<number>): void {}

export function svgMaskElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgMetadataElement {

}

export function svgMetadataElementAddEventListener30<K>(type: K, listener: (a0: SvgMetadataElement, a1: number) => number, options: Maybe<number>): void {}

export function svgMetadataElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgMetadataElementRemoveEventListener30<K>(type: K, listener: (a0: SvgMetadataElement, a1: number) => number, options: Maybe<number>): void {}

export function svgMetadataElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgPatternElement {
  height: any
  patternContentUnits: any
  patternTransform: any
  patternUnits: any
  width: any
  x: any
  y: any
}

export function svgPatternElementAddEventListener30<K>(type: K, listener: (a0: SvgPatternElement, a1: number) => number, options: Maybe<number>): void {}

export function svgPatternElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgPatternElementRemoveEventListener30<K>(type: K, listener: (a0: SvgPatternElement, a1: number) => number, options: Maybe<number>): void {}

export function svgPatternElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgRadialGradientElement {
  cx: any
  cy: any
  fr: any
  fx: any
  fy: any
  r: any
}

export function svgRadialGradientElementAddEventListener30<K>(type: K, listener: (a0: SvgRadialGradientElement, a1: number) => number, options: Maybe<number>): void {}

export function svgRadialGradientElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgRadialGradientElementRemoveEventListener30<K>(type: K, listener: (a0: SvgRadialGradientElement, a1: number) => number, options: Maybe<number>): void {}

export function svgRadialGradientElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgScriptElement {
  type: any
}

export function svgScriptElementAddEventListener30<K>(type: K, listener: (a0: SvgScriptElement, a1: number) => number, options: Maybe<number>): void {}

export function svgScriptElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgScriptElementRemoveEventListener30<K>(type: K, listener: (a0: SvgScriptElement, a1: number) => number, options: Maybe<number>): void {}

export function svgScriptElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgSetElement {

}

export function svgSetElementAddEventListener30<K>(type: K, listener: (a0: SvgSetElement, a1: number) => number, options: Maybe<number>): void {}

export function svgSetElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgSetElementRemoveEventListener30<K>(type: K, listener: (a0: SvgSetElement, a1: number) => number, options: Maybe<number>): void {}

export function svgSetElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgStopElement {
  offset: any
}

export function svgStopElementAddEventListener30<K>(type: K, listener: (a0: SvgStopElement, a1: number) => number, options: Maybe<number>): void {}

export function svgStopElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgStopElementRemoveEventListener30<K>(type: K, listener: (a0: SvgStopElement, a1: number) => number, options: Maybe<number>): void {}

export function svgStopElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgStyleElement {
  disabled: any
  media: any
  title: any
  type: any
}

export function svgStyleElementAddEventListener30<K>(type: K, listener: (a0: SvgStyleElement, a1: number) => number, options: Maybe<number>): void {}

export function svgStyleElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgStyleElementRemoveEventListener30<K>(type: K, listener: (a0: SvgStyleElement, a1: number) => number, options: Maybe<number>): void {}

export function svgStyleElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgSwitchElement {

}

export function svgSwitchElementAddEventListener30<K>(type: K, listener: (a0: SvgSwitchElement, a1: number) => number, options: Maybe<number>): void {}

export function svgSwitchElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgSwitchElementRemoveEventListener30<K>(type: K, listener: (a0: SvgSwitchElement, a1: number) => number, options: Maybe<number>): void {}

export function svgSwitchElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgSymbolElement {

}

export function svgSymbolElementAddEventListener30<K>(type: K, listener: (a0: SvgSymbolElement, a1: number) => number, options: Maybe<number>): void {}

export function svgSymbolElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgSymbolElementRemoveEventListener30<K>(type: K, listener: (a0: SvgSymbolElement, a1: number) => number, options: Maybe<number>): void {}

export function svgSymbolElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgTextPathElement {
  method: any
  spacing: any
  startOffset: any
  textpathMethodtypeAlign: any
  textpathMethodtypeStretch: any
  textpathMethodtypeUnknown: any
  textpathSpacingtypeAuto: any
  textpathSpacingtypeExact: any
  textpathSpacingtypeUnknown: any
}

export function svgTextPathElementAddEventListener30<K>(type: K, listener: (a0: SvgTextPathElement, a1: number) => number, options: Maybe<number>): void {}

export function svgTextPathElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgTextPathElementRemoveEventListener30<K>(type: K, listener: (a0: SvgTextPathElement, a1: number) => number, options: Maybe<number>): void {}

export function svgTextPathElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgTitleElement {

}

export function svgTitleElementAddEventListener30<K>(type: K, listener: (a0: SvgTitleElement, a1: number) => number, options: Maybe<number>): void {}

export function svgTitleElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgTitleElementRemoveEventListener30<K>(type: K, listener: (a0: SvgTitleElement, a1: number) => number, options: Maybe<number>): void {}

export function svgTitleElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgViewElement {

}

export function svgViewElementAddEventListener30<K>(type: K, listener: (a0: SvgViewElement, a1: number) => number, options: Maybe<number>): void {}

export function svgViewElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgViewElementRemoveEventListener30<K>(type: K, listener: (a0: SvgViewElement, a1: number) => number, options: Maybe<number>): void {}

export function svgViewElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgaElement {
  rel: any
  relList: any
  target: any
}

export function svgaElementAddEventListener30<K>(type: K, listener: (a0: SvgaElement, a1: number) => number, options: Maybe<number>): void {}

export function svgaElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgaElementRemoveEventListener30<K>(type: K, listener: (a0: SvgaElement, a1: number) => number, options: Maybe<number>): void {}

export function svgaElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeBlendElement {
  in1: any
  in2: any
  mode: any
  svgFeblendModeColor: any
  svgFeblendModeColorBurn: any
  svgFeblendModeColorDodge: any
  svgFeblendModeDarken: any
  svgFeblendModeDifference: any
  svgFeblendModeExclusion: any
  svgFeblendModeHardLight: any
  svgFeblendModeHue: any
  svgFeblendModeLighten: any
  svgFeblendModeLuminosity: any
  svgFeblendModeMultiply: any
  svgFeblendModeNormal: any
  svgFeblendModeOverlay: any
  svgFeblendModeSaturation: any
  svgFeblendModeScreen: any
  svgFeblendModeSoftLight: any
  svgFeblendModeUnknown: any
}

export function svgfeBlendElementAddEventListener30<K>(type: K, listener: (a0: SvgfeBlendElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeBlendElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeBlendElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeBlendElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeBlendElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeColorMatrixElement {
  in1: any
  type: any
  values: any
  svgFecolormatrixTypeHuerotate: any
  svgFecolormatrixTypeLuminancetoalpha: any
  svgFecolormatrixTypeMatrix: any
  svgFecolormatrixTypeSaturate: any
  svgFecolormatrixTypeUnknown: any
}

export function svgfeColorMatrixElementAddEventListener30<K>(type: K, listener: (a0: SvgfeColorMatrixElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeColorMatrixElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeColorMatrixElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeColorMatrixElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeColorMatrixElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeComponentTransferElement {
  in1: any
}

export function svgfeComponentTransferElementAddEventListener30<K>(type: K, listener: (a0: SvgfeComponentTransferElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeComponentTransferElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeComponentTransferElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeComponentTransferElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeComponentTransferElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeCompositeElement {
  in1: any
  in2: any
  k1: any
  k2: any
  k3: any
  k4: any
  operator: any
  svgFecompositeOperatorArithmetic: any
  svgFecompositeOperatorAtop: any
  svgFecompositeOperatorIn: any
  svgFecompositeOperatorOut: any
  svgFecompositeOperatorOver: any
  svgFecompositeOperatorUnknown: any
  svgFecompositeOperatorXor: any
}

export function svgfeCompositeElementAddEventListener30<K>(type: K, listener: (a0: SvgfeCompositeElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeCompositeElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeCompositeElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeCompositeElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeCompositeElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeConvolveMatrixElement {
  bias: any
  divisor: any
  edgeMode: any
  in1: any
  kernelMatrix: any
  kernelUnitLengthX: any
  kernelUnitLengthY: any
  orderX: any
  orderY: any
  preserveAlpha: any
  targetX: any
  targetY: any
  svgEdgemodeDuplicate: any
  svgEdgemodeNone: any
  svgEdgemodeUnknown: any
  svgEdgemodeWrap: any
}

export function svgfeConvolveMatrixElementAddEventListener30<K>(type: K, listener: (a0: SvgfeConvolveMatrixElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeConvolveMatrixElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeConvolveMatrixElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeConvolveMatrixElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeConvolveMatrixElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeDiffuseLightingElement {
  diffuseConstant: any
  in1: any
  kernelUnitLengthX: any
  kernelUnitLengthY: any
  surfaceScale: any
}

export function svgfeDiffuseLightingElementAddEventListener30<K>(type: K, listener: (a0: SvgfeDiffuseLightingElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeDiffuseLightingElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeDiffuseLightingElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeDiffuseLightingElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeDiffuseLightingElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeDisplacementMapElement {
  in1: any
  in2: any
  scale: any
  xChannelSelector: any
  yChannelSelector: any
  svgChannelA: any
  svgChannelB: any
  svgChannelG: any
  svgChannelR: any
  svgChannelUnknown: any
}

export function svgfeDisplacementMapElementAddEventListener30<K>(type: K, listener: (a0: SvgfeDisplacementMapElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeDisplacementMapElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeDisplacementMapElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeDisplacementMapElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeDisplacementMapElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeDistantLightElement {
  azimuth: any
  elevation: any
}

export function svgfeDistantLightElementAddEventListener30<K>(type: K, listener: (a0: SvgfeDistantLightElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeDistantLightElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeDistantLightElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeDistantLightElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeDistantLightElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeDropShadowElement {
  dx: any
  dy: any
  in1: any
  stdDeviationX: any
  stdDeviationY: any
}

export function svgfeDropShadowElementAddEventListener30<K>(type: K, listener: (a0: SvgfeDropShadowElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeDropShadowElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeDropShadowElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeDropShadowElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeDropShadowElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeFloodElement {

}

export function svgfeFloodElementAddEventListener30<K>(type: K, listener: (a0: SvgfeFloodElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeFloodElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeFloodElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeFloodElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeFloodElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgComponentTransferFunctionElement {
  amplitude: any
  exponent: any
  intercept: any
  offset: any
  slope: any
  tableValues: any
  type: any
  svgFecomponenttransferTypeDiscrete: any
  svgFecomponenttransferTypeGamma: any
  svgFecomponenttransferTypeIdentity: any
  svgFecomponenttransferTypeLinear: any
  svgFecomponenttransferTypeTable: any
  svgFecomponenttransferTypeUnknown: any
}

export function svgComponentTransferFunctionElementAddEventListener30<K>(type: K, listener: (a0: SvgComponentTransferFunctionElement, a1: number) => number, options: Maybe<number>): void {}

export function svgComponentTransferFunctionElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgComponentTransferFunctionElementRemoveEventListener30<K>(type: K, listener: (a0: SvgComponentTransferFunctionElement, a1: number) => number, options: Maybe<number>): void {}

export function svgComponentTransferFunctionElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeFuncAElement {

}

export function svgfeFuncAElementAddEventListener30<K>(type: K, listener: (a0: SvgfeFuncAElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeFuncAElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeFuncAElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeFuncAElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeFuncAElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeFuncBElement {

}

export function svgfeFuncBElementAddEventListener30<K>(type: K, listener: (a0: SvgfeFuncBElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeFuncBElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeFuncBElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeFuncBElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeFuncBElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeFuncGElement {

}

export function svgfeFuncGElementAddEventListener30<K>(type: K, listener: (a0: SvgfeFuncGElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeFuncGElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeFuncGElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeFuncGElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeFuncGElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeFuncRElement {

}

export function svgfeFuncRElementAddEventListener30<K>(type: K, listener: (a0: SvgfeFuncRElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeFuncRElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeFuncRElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeFuncRElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeFuncRElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeGaussianBlurElement {
  in1: any
  stdDeviationX: any
  stdDeviationY: any
}

export function svgfeGaussianBlurElementAddEventListener30<K>(type: K, listener: (a0: SvgfeGaussianBlurElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeGaussianBlurElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeGaussianBlurElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeGaussianBlurElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeGaussianBlurElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeImageElement {
  preserveAspectRatio: any
}

export function svgfeImageElementAddEventListener30<K>(type: K, listener: (a0: SvgfeImageElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeImageElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeImageElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeImageElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeImageElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeMergeElement {

}

export function svgfeMergeElementAddEventListener30<K>(type: K, listener: (a0: SvgfeMergeElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeMergeElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeMergeElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeMergeElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeMergeElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeMergeNodeElement {
  in1: any
}

export function svgfeMergeNodeElementAddEventListener30<K>(type: K, listener: (a0: SvgfeMergeNodeElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeMergeNodeElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeMergeNodeElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeMergeNodeElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeMergeNodeElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeMorphologyElement {
  in1: any
  operator: any
  radiusX: any
  radiusY: any
  svgMorphologyOperatorDilate: any
  svgMorphologyOperatorErode: any
  svgMorphologyOperatorUnknown: any
}

export function svgfeMorphologyElementAddEventListener30<K>(type: K, listener: (a0: SvgfeMorphologyElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeMorphologyElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeMorphologyElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeMorphologyElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeMorphologyElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeOffsetElement {
  dx: any
  dy: any
  in1: any
}

export function svgfeOffsetElementAddEventListener30<K>(type: K, listener: (a0: SvgfeOffsetElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeOffsetElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeOffsetElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeOffsetElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeOffsetElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfePointLightElement {
  x: any
  y: any
  z: any
}

export function svgfePointLightElementAddEventListener30<K>(type: K, listener: (a0: SvgfePointLightElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfePointLightElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfePointLightElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfePointLightElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfePointLightElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeSpecularLightingElement {
  in1: any
  kernelUnitLengthX: any
  kernelUnitLengthY: any
  specularConstant: any
  specularExponent: any
  surfaceScale: any
}

export function svgfeSpecularLightingElementAddEventListener30<K>(type: K, listener: (a0: SvgfeSpecularLightingElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeSpecularLightingElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeSpecularLightingElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeSpecularLightingElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeSpecularLightingElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeSpotLightElement {
  limitingConeAngle: any
  pointsAtX: any
  pointsAtY: any
  pointsAtZ: any
  specularExponent: any
  x: any
  y: any
  z: any
}

export function svgfeSpotLightElementAddEventListener30<K>(type: K, listener: (a0: SvgfeSpotLightElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeSpotLightElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeSpotLightElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeSpotLightElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeSpotLightElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeTileElement {
  in1: any
}

export function svgfeTileElementAddEventListener30<K>(type: K, listener: (a0: SvgfeTileElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeTileElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeTileElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeTileElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeTileElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgfeTurbulenceElement {
  baseFrequencyX: any
  baseFrequencyY: any
  numOctaves: any
  seed: any
  stitchTiles: any
  type: any
  svgStitchtypeNostitch: any
  svgStitchtypeStitch: any
  svgStitchtypeUnknown: any
  svgTurbulenceTypeFractalnoise: any
  svgTurbulenceTypeTurbulence: any
  svgTurbulenceTypeUnknown: any
}

export function svgfeTurbulenceElementAddEventListener30<K>(type: K, listener: (a0: SvgfeTurbulenceElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeTurbulenceElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgfeTurbulenceElementRemoveEventListener30<K>(type: K, listener: (a0: SvgfeTurbulenceElement, a1: number) => number, options: Maybe<number>): void {}

export function svgfeTurbulenceElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvggElement {

}

export function svggElementAddEventListener30<K>(type: K, listener: (a0: SvggElement, a1: number) => number, options: Maybe<number>): void {}

export function svggElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svggElementRemoveEventListener30<K>(type: K, listener: (a0: SvggElement, a1: number) => number, options: Maybe<number>): void {}

export function svggElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgmPathElement {

}

export function svgmPathElementAddEventListener30<K>(type: K, listener: (a0: SvgmPathElement, a1: number) => number, options: Maybe<number>): void {}

export function svgmPathElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgmPathElementRemoveEventListener30<K>(type: K, listener: (a0: SvgmPathElement, a1: number) => number, options: Maybe<number>): void {}

export function svgmPathElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgtSpanElement {

}

export function svgtSpanElementAddEventListener30<K>(type: K, listener: (a0: SvgtSpanElement, a1: number) => number, options: Maybe<number>): void {}

export function svgtSpanElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function svgtSpanElementRemoveEventListener30<K>(type: K, listener: (a0: SvgtSpanElement, a1: number) => number, options: Maybe<number>): void {}

export function svgtSpanElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SvgElementTagNameMap {
  a: any
  animate: any
  animateMotion: any
  animateTransform: any
  circle: any
  clipPath: any
  defs: any
  desc: any
  ellipse: any
  feBlend: any
  feColorMatrix: any
  feComponentTransfer: any
  feComposite: any
  feConvolveMatrix: any
  feDiffuseLighting: any
  feDisplacementMap: any
  feDistantLight: any
  feDropShadow: any
  feFlood: any
  feFuncA: any
  feFuncB: any
  feFuncG: any
  feFuncR: any
  feGaussianBlur: any
  feImage: any
  feMerge: any
  feMergeNode: any
  feMorphology: any
  feOffset: any
  fePointLight: any
  feSpecularLighting: any
  feSpotLight: any
  feTile: any
  feTurbulence: any
  filter: any
  foreignObject: any
  g: any
  image: any
  line: any
  linearGradient: any
  marker: any
  mask: any
  metadata: any
  mpath: any
  path: any
  pattern: any
  polygon: any
  polyline: any
  radialGradient: any
  rect: any
  script: any
  set: any
  stop: any
  style: any
  svg: any
  switch: any
  symbol: any
  text: any
  textPath: any
  title: any
  tspan: any
  use: any
  view: any
}

export interface ParentNode {
  childElementCount: any
  children: any
  firstElementChild: any
  lastElementChild: any
}

export function parentNodeAppend(nodes: number): void {}

export function parentNodeQuerySelector10<K>(selectors: K): number {
  throw new Error("stub: parent-node_query-selector__1__0")
}

export function parentNodeQuerySelector11<K>(selectors: K): number {
  throw new Error("stub: parent-node_query-selector__1__1")
}

export function parentNodeQuerySelector12<E>(selectors: string): number {
  throw new Error("stub: parent-node_query-selector__1__2")
}

export function parentNodeQuerySelectorAll10<K>(selectors: K): NodeListOf<number> {
  throw new Error("stub: parent-node_query-selector-all__1__0")
}

export function parentNodeQuerySelectorAll11<K>(selectors: K): NodeListOf<number> {
  throw new Error("stub: parent-node_query-selector-all__1__1")
}

export function parentNodeQuerySelectorAll12<E>(selectors: string): NodeListOf<E> {
  throw new Error("stub: parent-node_query-selector-all__1__2")
}

export function domRectListItem(index: number): number {
  throw new Error("stub: dom-rect-list_item")
}

export interface SpeechSynthesisEventMap {
  voiceschanged: any
}

export interface SpeechSynthesisUtteranceEventMap {
  boundary: any
  end: any
  error: any
  mark: any
  pause: any
  resume: any
  start: any
}

export interface SpeechSynthesisUtterance {
  lang: any
  onboundary: any
  onend: any
  onerror: any
  onmark: any
  onpause: any
  onresume: any
  onstart: any
  pitch: any
  rate: any
  text: any
  voice: any
  volume: any
}

export function speechSynthesisUtteranceAddEventListener30<K>(type: K, listener: (a0: SpeechSynthesisUtterance, a1: number) => number, options: Maybe<number>): void {}

export function speechSynthesisUtteranceAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function speechSynthesisUtteranceRemoveEventListener30<K>(type: K, listener: (a0: SpeechSynthesisUtterance, a1: number) => number, options: Maybe<number>): void {}

export function speechSynthesisUtteranceRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface SpeechSynthesis {
  onvoiceschanged: any
  paused: any
  pending: any
  speaking: any
}

export function speechSynthesisCancel(): void {}

export function speechSynthesisPause(): void {}

export function speechSynthesisResume(): void {}

export function speechSynthesisAddEventListener30<K>(type: K, listener: (a0: SpeechSynthesis, a1: number) => number, options: Maybe<number>): void {}

export function speechSynthesisAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function speechSynthesisRemoveEventListener30<K>(type: K, listener: (a0: SpeechSynthesis, a1: number) => number, options: Maybe<number>): void {}

export function speechSynthesisRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface VisualViewportEventMap {
  resize: any
  scroll: any
}

export interface VisualViewport {
  height: any
  offsetLeft: any
  offsetTop: any
  onresize: any
  onscroll: any
  pageLeft: any
  pageTop: any
  scale: any
  width: any
}

export function visualViewportAddEventListener30<K>(type: K, listener: (a0: VisualViewport, a1: number) => number, options: Maybe<number>): void {}

export function visualViewportAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function visualViewportRemoveEventListener30<K>(type: K, listener: (a0: VisualViewport, a1: number) => number, options: Maybe<number>): void {}

export function visualViewportRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface WindowEventMap {
  devicemotion: any
  deviceorientation: any
  gamepadconnected: any
  gamepaddisconnected: any
  orientationchange: any
}

export interface Uint8Array {
  bytesPerElement: any
  buffer: any
  byteLength: any
  byteOffset: any
  length: any
}

export function uint8ArrayEvery(predicate: (a0: number, a1: number, a2: Uint8Array) => number, thisArg: Maybe<number>): boolean {
  throw new Error("stub: uint8-array_every")
}

export function uint8ArrayFilter(predicate: (a0: number, a1: number, a2: Uint8Array) => number, thisArg: Maybe<number>): Uint8Array {
  throw new Error("stub: uint8-array_filter")
}

export function uint8ArrayMap(callbackfn: (a0: number, a1: number, a2: Uint8Array) => number, thisArg: Maybe<number>): Uint8Array {
  throw new Error("stub: uint8-array_map")
}

export function uint8ArrayReduce1(callbackfn: (a0: number, a1: number, a2: number, a3: Uint8Array) => number): number {
  throw new Error("stub: uint8-array_reduce__1")
}

export function uint8ArrayReduce20(callbackfn: (a0: number, a1: number, a2: number, a3: Uint8Array) => number, initialValue: number): number {
  throw new Error("stub: uint8-array_reduce__2__0")
}

export function uint8ArrayReduce21<U>(callbackfn: (a0: U, a1: number, a2: number, a3: Uint8Array) => U, initialValue: U): U {
  throw new Error("stub: uint8-array_reduce__2__1")
}

export function uint8ArrayReduceRight1(callbackfn: (a0: number, a1: number, a2: number, a3: Uint8Array) => number): number {
  throw new Error("stub: uint8-array_reduce-right__1")
}

export function uint8ArrayReduceRight20(callbackfn: (a0: number, a1: number, a2: number, a3: Uint8Array) => number, initialValue: number): number {
  throw new Error("stub: uint8-array_reduce-right__2__0")
}

export function uint8ArrayReduceRight21<U>(callbackfn: (a0: U, a1: number, a2: number, a3: Uint8Array) => U, initialValue: U): U {
  throw new Error("stub: uint8-array_reduce-right__2__1")
}

export function uint8ArraySet(array: ArrayLike<number>, offset: Maybe<number>): void {}

export function uint8ArraySlice(start: Maybe<number>, end: Maybe<number>): Uint8Array {
  throw new Error("stub: uint8-array_slice")
}

export function uint8ArraySome(predicate: (a0: number, a1: number, a2: Uint8Array) => number, thisArg: Maybe<number>): boolean {
  throw new Error("stub: uint8-array_some")
}

export interface Body {
  body: any
  bodyUsed: any
}

export function bodyArrayBuffer(): PromiseForm<ArrayBuffer> {
  throw new Error("stub: body_array-buffer")
}

export function bodyBlob(): PromiseForm<Blob> {
  throw new Error("stub: body_blob")
}

export function bodyText(): PromiseForm<string> {
  throw new Error("stub: body_text")
}

export interface Headers {

}

export function headersAppend(name: string, value: string): void {}

export function headersGet(name: string): number {
  throw new Error("stub: headers_get")
}

export function headersSet(name: string, value: string): void {}

export interface Request {
  cache: any
  credentials: any
  destination: any
  headers: any
  integrity: any
  keepalive: any
  method: any
  mode: any
  redirect: any
  referrer: any
  referrerPolicy: any
  signal: any
  url: any
}

export interface Response {
  headers: any
  ok: any
  redirected: any
  status: any
  statusText: any
  type: any
  url: any
}

export interface Cache {

}

export function cacheKeys(request: Maybe<number>, options: Maybe<number>): PromiseForm<ReadonlyArray<Request>> {
  throw new Error("stub: cache_keys")
}

export function cacheStorageKeys(): PromiseForm<number> {
  throw new Error("stub: cache-storage_keys")
}

export function cacheStorageOpen(cacheName: string): PromiseForm<Cache> {
  throw new Error("stub: cache-storage_open")
}

export interface Algorithm {
  name: any
}

export interface AesKeyAlgorithm {
  length: any
}

export interface AesKeyGenParams {
  length: any
}

export interface AlgorithmIdentifier {

}

export interface KeyUsage {

}

export interface CryptoKey {
  algorithm: any
  extractable: any
  type: any
  usages: any
}

export interface CryptoKeyPair {
  privateKey: any
  publicKey: any
}

export interface NamedCurve {

}

export interface EcKeyGenParams {
  namedCurve: any
}

export interface EcKeyImportParams {
  namedCurve: any
}

export interface HmacImportParams {
  hash: any
  length: any
}

export interface HmacKeyGenParams {
  hash: any
  length: any
}

export interface JsonWebKey {
  alg: any
  crv: any
  d: any
  dp: any
  dq: any
  e: any
  ext: any
  k: any
  keyOps: any
  kty: any
  n: any
  oth: any
  p: any
  q: any
  qi: any
  use: any
  x: any
  y: any
}

export interface KeyFormat {

}

export interface Pbkdf2Params {
  hash: any
  iterations: any
  salt: any
}

export interface RsaHashedImportParams {
  hash: any
}

export interface RsaHashedKeyGenParams {
  hash: any
}

export interface Exclude<T = any, U = any> {

}

export function subtleCryptoGenerateKey30(algorithm: number, extractable: boolean, keyUsages: number): PromiseForm<CryptoKeyPair> {
  throw new Error("stub: subtle-crypto_generate-key__3__0")
}

export function subtleCryptoGenerateKey31(algorithm: number, extractable: boolean, keyUsages: number): PromiseForm<CryptoKey> {
  throw new Error("stub: subtle-crypto_generate-key__3__1")
}

export function subtleCryptoGenerateKey32(algorithm: AlgorithmIdentifier, extractable: boolean, keyUsages: number): PromiseForm<number> {
  throw new Error("stub: subtle-crypto_generate-key__3__2")
}

export function subtleCryptoImportKey50(format: number, keyData: JsonWebKey, algorithm: number, extractable: boolean, keyUsages: number): PromiseForm<CryptoKey> {
  throw new Error("stub: subtle-crypto_import-key__5__0")
}

export function subtleCryptoImportKey51(format: Exclude<KeyFormat, number>, keyData: BufferSource, algorithm: number, extractable: boolean, keyUsages: number): PromiseForm<CryptoKey> {
  throw new Error("stub: subtle-crypto_import-key__5__1")
}

export interface IdbRequestEventMap {
  error: any
  success: any
}

export interface IdbOpenDbRequestEventMap {
  blocked: any
  upgradeneeded: any
}

export interface IdbKeyRange {
  lower: any
  lowerOpen: any
  upper: any
  upperOpen: any
}

export function idbKeyRangeIncludes(key: number): boolean {
  throw new Error("stub: idb-key-range_includes")
}

export interface IdbDatabaseEventMap {
  abort: any
  close: any
  error: any
  versionchange: any
}

export interface IdbDatabase {
  name: any
  objectStoreNames: any
  onabort: any
  onclose: any
  onerror: any
  onversionchange: any
  version: any
}

export function idbDatabaseClose(): void {}

export function idbDatabaseTransaction(storeNames: number, mode: Maybe<number>): IdbTransaction {
  throw new Error("stub: idb-database_transaction")
}

export function idbDatabaseAddEventListener30<K>(type: K, listener: (a0: IdbDatabase, a1: number) => number, options: Maybe<number>): void {}

export function idbDatabaseAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function idbDatabaseRemoveEventListener30<K>(type: K, listener: (a0: IdbDatabase, a1: number) => number, options: Maybe<number>): void {}

export function idbDatabaseRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface IdbTransactionEventMap {
  abort: any
  complete: any
  error: any
}

export interface IdbTransaction {
  db: any
  error: any
  mode: any
  objectStoreNames: any
  onabort: any
  oncomplete: any
  onerror: any
}

export function idbTransactionAbort(): void {}

export function idbTransactionObjectStore(name: string): IdbObjectStore {
  throw new Error("stub: idb-transaction_object-store")
}

export function idbTransactionAddEventListener30<K>(type: K, listener: (a0: IdbTransaction, a1: number) => number, options: Maybe<number>): void {}

export function idbTransactionAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function idbTransactionRemoveEventListener30<K>(type: K, listener: (a0: IdbTransaction, a1: number) => number, options: Maybe<number>): void {}

export function idbTransactionRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface IdbValidKey {

}

export interface IdbObjectStore {
  autoIncrement: any
  indexNames: any
  keyPath: any
  name: any
  transaction: any
}

export function idbObjectStoreClear(): IdbRequest<void> {
  throw new Error("stub: idb-object-store_clear")
}

export function idbObjectStoreCount(query: Maybe<number>): IdbRequest<number> {
  throw new Error("stub: idb-object-store_count")
}

export function idbObjectStoreGet(query: number): IdbRequest<number> {
  throw new Error("stub: idb-object-store_get")
}

export function idbObjectStoreIndex(name: string): IdbIndex {
  throw new Error("stub: idb-object-store_index")
}

export interface IdbIndex {
  keyPath: any
  multiEntry: any
  name: any
  objectStore: any
  unique: any
}

export function idbIndexCount(query: Maybe<number>): IdbRequest<number> {
  throw new Error("stub: idb-index_count")
}

export function idbIndexGet(query: number): IdbRequest<number> {
  throw new Error("stub: idb-index_get")
}

export function idbCursorUpdate(value: number): IdbRequest<IdbValidKey> {
  throw new Error("stub: idb-cursor_update")
}

export interface IdbRequest<T = any> {
  error: any
  onerror: any
  onsuccess: any
  readyState: any
  result: any
  source: any
  transaction: any
}

export function idbRequestAddEventListener30<T, K>(type: K, listener: (a0: IdbRequest<T>, a1: number) => number, options: Maybe<number>): void {}

export function idbRequestAddEventListener31<T>(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function idbRequestRemoveEventListener30<T, K>(type: K, listener: (a0: IdbRequest<T>, a1: number) => number, options: Maybe<number>): void {}

export function idbRequestRemoveEventListener31<T>(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface IdbOpenDbRequest {
  onblocked: any
  onupgradeneeded: any
}

export function idbOpenDbRequestAddEventListener30<K>(type: K, listener: (a0: IdbOpenDbRequest, a1: number) => number, options: Maybe<number>): void {}

export function idbOpenDbRequestAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function idbOpenDbRequestRemoveEventListener30<K>(type: K, listener: (a0: IdbOpenDbRequest, a1: number) => number, options: Maybe<number>): void {}

export function idbOpenDbRequestRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function idbFactoryOpen(name: string, version: Maybe<number>): IdbOpenDbRequest {
  throw new Error("stub: idb-factory_open")
}

export interface PerformanceEventMap {
  resourcetimingbufferfull: any
}

export interface PerformanceMark {
  detail: any
}

export interface Performance {
  navigation: any
  onresourcetimingbufferfull: any
  timeOrigin: any
  timing: any
}

export function performanceMark(markName: string, markOptions: Maybe<number>): PerformanceMark {
  throw new Error("stub: performance_mark")
}

export function performanceAddEventListener30<K>(type: K, listener: (a0: Performance, a1: number) => number, options: Maybe<number>): void {}

export function performanceAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function performanceRemoveEventListener30<K>(type: K, listener: (a0: Performance, a1: number) => number, options: Maybe<number>): void {}

export function performanceRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface Function_ {
  prototype: any
  length: any
  arguments: any
  caller: any
}

export function functionCall(this_: Function_, thisArg: number, argArray: number): number {
  throw new Error("stub: function_call")
}

export interface Window {
  htmlDocument: any
  closed: any
  customElements: any
  devicePixelRatio: any
  document: any
  event: any
  external: any
  frameElement: any
  frames: any
  history: any
  innerHeight: any
  innerWidth: any
  length: any
  locationbar: any
  menubar: any
  name: any
  navigator: any
  ondevicemotion: any
  ondeviceorientation: any
  onorientationchange: any
  opener: any
  orientation: any
  outerHeight: any
  outerWidth: any
  pageXOffset: any
  pageYOffset: any
  parent: any
  personalbar: any
  screen: any
  screenLeft: any
  screenTop: any
  screenX: any
  screenY: any
  scrollX: any
  scrollY: any
  scrollbars: any
  self: any
  speechSynthesis: any
  status: any
  statusbar: any
  toolbar: any
  top: any
  visualViewport: any
  window: any
}

export function windowLocation0(): Location {
  throw new Error("stub: window_location__0")
}

export function windowLocation1(href: number): void {}

export function windowBlur(): void {}

export function windowClose(): void {}

export function windowFocus(): void {}

export function windowOpen(url: Maybe<number>, target: Maybe<number>, features: Maybe<number>): number {
  throw new Error("stub: window_open")
}

export function windowPostMessage3(message: number, targetOrigin: string, transfer: Maybe<number>): void {}

export function windowPostMessage2(message: number, options: Maybe<number>): void {}

export function windowScroll1(options: Maybe<number>): void {}

export function windowScroll2(x: number, y: number): void {}

export function windowStop(): void {}

export function windowAddEventListener30<K>(type: K, listener: (a0: Window, a1: number) => number, options: Maybe<number>): void {}

export function windowAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function windowRemoveEventListener30<K>(type: K, listener: (a0: Window, a1: number) => number, options: Maybe<number>): void {}

export function windowRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface GlobalEventHandlers {
  onabort: any
  onanimationcancel: any
  onanimationend: any
  onanimationiteration: any
  onanimationstart: any
  onauxclick: any
  onblur: any
  oncanplay: any
  oncanplaythrough: any
  onchange: any
  onclick: any
  onclose: any
  oncontextmenu: any
  oncuechange: any
  ondblclick: any
  ondrag: any
  ondragend: any
  ondragenter: any
  ondragleave: any
  ondragover: any
  ondragstart: any
  ondrop: any
  ondurationchange: any
  onemptied: any
  onended: any
  onerror: any
  onfocus: any
  onformdata: any
  ongotpointercapture: any
  oninput: any
  oninvalid: any
  onkeydown: any
  onkeypress: any
  onkeyup: any
  onload: any
  onloadeddata: any
  onloadedmetadata: any
  onloadstart: any
  onlostpointercapture: any
  onmousedown: any
  onmouseenter: any
  onmouseleave: any
  onmousemove: any
  onmouseout: any
  onmouseover: any
  onmouseup: any
  onpause: any
  onplay: any
  onplaying: any
  onpointercancel: any
  onpointerdown: any
  onpointerenter: any
  onpointerleave: any
  onpointermove: any
  onpointerout: any
  onpointerover: any
  onpointerup: any
  onprogress: any
  onratechange: any
  onreset: any
  onresize: any
  onscroll: any
  onseeked: any
  onseeking: any
  onselect: any
  onselectionchange: any
  onselectstart: any
  onstalled: any
  onsubmit: any
  onsuspend: any
  ontimeupdate: any
  ontoggle: any
  ontouchcancel: any
  ontouchend: any
  ontouchmove: any
  ontouchstart: any
  ontransitioncancel: any
  ontransitionend: any
  ontransitionrun: any
  ontransitionstart: any
  onvolumechange: any
  onwaiting: any
  onwebkitanimationend: any
  onwebkitanimationiteration: any
  onwebkitanimationstart: any
  onwebkittransitionend: any
  onwheel: any
}

export function globalEventHandlersAddEventListener30<K>(type: K, listener: (a0: GlobalEventHandlers, a1: number) => number, options: Maybe<number>): void {}

export function globalEventHandlersAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function globalEventHandlersRemoveEventListener30<K>(type: K, listener: (a0: GlobalEventHandlers, a1: number) => number, options: Maybe<number>): void {}

export function globalEventHandlersRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface HtmlElement {
  accessKey: any
  accessKeyLabel: any
  autocapitalize: any
  dir: any
  draggable: any
  hidden: any
  innerText: any
  lang: any
  offsetHeight: any
  offsetLeft: any
  offsetParent: any
  offsetTop: any
  offsetWidth: any
  outerText: any
  spellcheck: any
  title: any
  translate: any
}

export function htmlElementClick(): void {}

export function htmlElementAddEventListener30<K>(type: K, listener: (a0: HtmlElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlElementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlElementRemoveEventListener30<K>(type: K, listener: (a0: HtmlElement, a1: number) => number, options: Maybe<number>): void {}

export function htmlElementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface Node {
  baseURI: any
  childNodes: any
  firstChild: any
  isConnected: any
  lastChild: any
  nextSibling: any
  nodeName: any
  nodeType: any
  nodeValue: any
  ownerDocument: any
  parentElement: any
  parentNode: any
  previousSibling: any
  textContent: any
  attributeNode: any
  cdataSectionNode: any
  commentNode: any
  documentFragmentNode: any
  documentNode: any
  documentPositionContainedBy: any
  documentPositionContains: any
  documentPositionDisconnected: any
  documentPositionFollowing: any
  documentPositionImplementationSpecific: any
  documentPositionPreceding: any
  documentTypeNode: any
  elementNode: any
  entityNode: any
  entityReferenceNode: any
  notationNode: any
  processingInstructionNode: any
  textNode: any
}

export function nodeAppendChild<T>(node: T): T {
  throw new Error("stub: node_append-child")
}

export interface ChildNode {

}

export function childNodeRemove(): void {}

export function childNodeReplaceWith(nodes: number): void {}

export function namedNodeMapItem(index: number): number {
  throw new Error("stub: named-node-map_item")
}

export function styleSheetListItem(index: number): number {
  throw new Error("stub: style-sheet-list_item")
}

export interface ShadowRoot {
  host: any
  mode: any
}

export interface Element {
  attributes: any
  classList: any
  className: any
  clientHeight: any
  clientLeft: any
  clientTop: any
  clientWidth: any
  id: any
  localName: any
  namespaceURI: any
  onfullscreenchange: any
  onfullscreenerror: any
  outerHTML: any
  ownerDocument: any
  part: any
  prefix: any
  scrollHeight: any
  scrollLeft: any
  scrollTop: any
  scrollWidth: any
  shadowRoot: any
  slot: any
  tagName: any
}

export function elementClosest10<K>(selector: K): number {
  throw new Error("stub: element_closest__1__0")
}

export function elementClosest11<K>(selector: K): number {
  throw new Error("stub: element_closest__1__1")
}

export function elementClosest12<E>(selectors: string): number {
  throw new Error("stub: element_closest__1__2")
}

export function elementGetElementsByTagName10<K>(qualifiedName: K): HtmlCollectionOf<number> {
  throw new Error("stub: element_get-elements-by-tag-name__1__0")
}

export function elementGetElementsByTagName11<K>(qualifiedName: K): HtmlCollectionOf<number> {
  throw new Error("stub: element_get-elements-by-tag-name__1__1")
}

export function elementGetElementsByTagName12(qualifiedName: string): HtmlCollectionOf<Element> {
  throw new Error("stub: element_get-elements-by-tag-name__1__2")
}

export function elementMatches(selectors: string): boolean {
  throw new Error("stub: element_matches")
}

export function elementScroll1(options: Maybe<number>): void {}

export function elementScroll2(x: number, y: number): void {}

export function elementSetAttribute(qualifiedName: string, value: string): void {}

export function elementAddEventListener30<K>(type: K, listener: (a0: Element, a1: number) => number, options: Maybe<number>): void {}

export function elementAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function elementRemoveEventListener30<K>(type: K, listener: (a0: Element, a1: number) => number, options: Maybe<number>): void {}

export function elementRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface Attr {
  localName: any
  name: any
  namespaceURI: any
  ownerDocument: any
  ownerElement: any
  prefix: any
  specified: any
  value: any
}

export interface DocumentEventMap {
  fullscreenchange: any
  fullscreenerror: any
  pointerlockchange: any
  pointerlockerror: any
  readystatechange: any
  visibilitychange: any
}

export interface XmlDocument {

}

export function xmlDocumentAddEventListener30<K>(type: K, listener: (a0: XmlDocument, a1: number) => number, options: Maybe<number>): void {}

export function xmlDocumentAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function xmlDocumentRemoveEventListener30<K>(type: K, listener: (a0: XmlDocument, a1: number) => number, options: Maybe<number>): void {}

export function xmlDocumentRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface FontFace {
  ascentOverride: any
  descentOverride: any
  display: any
  family: any
  featureSettings: any
  lineGapOverride: any
  loaded: any
  status: any
  stretch: any
  style: any
  unicodeRange: any
  variant: any
  variationSettings: any
  weight: any
}

export function fontFaceLoad(): PromiseForm<FontFace> {
  throw new Error("stub: font-face_load")
}

export interface FontFaceSetEventMap {
  loading: any
  loadingdone: any
  loadingerror: any
}

export interface FontFaceSet {
  onloading: any
  onloadingdone: any
  onloadingerror: any
  ready: any
  status: any
}

export function fontFaceSetLoad(font: string, text: Maybe<number>): PromiseForm<number> {
  throw new Error("stub: font-face-set_load")
}

export function fontFaceSetAddEventListener30<K>(type: K, listener: (a0: FontFaceSet, a1: number) => number, options: Maybe<number>): void {}

export function fontFaceSetAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function fontFaceSetRemoveEventListener30<K>(type: K, listener: (a0: FontFaceSet, a1: number) => number, options: Maybe<number>): void {}

export function fontFaceSetRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function htmlAllCollectionItem(nameOrIndex: Maybe<number>): number {
  throw new Error("stub: html-all-collection_item")
}

export interface HtmlElementDeprecatedTagNameMap {
  listing: any
  xmp: any
}

export interface BinaryType {

}

export interface RtcDataChannelEventMap {
  bufferedamountlow: any
  close: any
  error: any
  message: any
  open: any
}

export interface RtcDataChannel {
  binaryType: any
  bufferedAmount: any
  bufferedAmountLowThreshold: any
  id: any
  label: any
  maxPacketLifeTime: any
  maxRetransmits: any
  negotiated: any
  onbufferedamountlow: any
  onclose: any
  onerror: any
  onmessage: any
  onopen: any
  ordered: any
  protocol: any
  readyState: any
}

export function rtcDataChannelClose(): void {}

export function rtcDataChannelSend10(data: string): void {}

export function rtcDataChannelSend11(data: Blob): void {}

export function rtcDataChannelSend12(data: ArrayBuffer): void {}

export function rtcDataChannelSend13(data: ArrayBufferView): void {}

export function rtcDataChannelAddEventListener30<K>(type: K, listener: (a0: RtcDataChannel, a1: number) => number, options: Maybe<number>): void {}

export function rtcDataChannelAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function rtcDataChannelRemoveEventListener30<K>(type: K, listener: (a0: RtcDataChannel, a1: number) => number, options: Maybe<number>): void {}

export function rtcDataChannelRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface RtcDtlsTransportEventMap {
  statechange: any
}

export interface RtcDtlsTransport {
  onstatechange: any
  state: any
}

export function rtcDtlsTransportAddEventListener30<K>(type: K, listener: (a0: RtcDtlsTransport, a1: number) => number, options: Maybe<number>): void {}

export function rtcDtlsTransportAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function rtcDtlsTransportRemoveEventListener30<K>(type: K, listener: (a0: RtcDtlsTransport, a1: number) => number, options: Maybe<number>): void {}

export function rtcDtlsTransportRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export interface RtcdtmfSenderEventMap {
  tonechange: any
}

export interface RtcdtmfSender {
  canInsertDtmf: any
  ontonechange: any
  toneBuffer: any
}

export function rtcdtmfSenderAddEventListener30<K>(type: K, listener: (a0: RtcdtmfSender, a1: number) => number, options: Maybe<number>): void {}

export function rtcdtmfSenderAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function rtcdtmfSenderRemoveEventListener30<K>(type: K, listener: (a0: RtcdtmfSender, a1: number) => number, options: Maybe<number>): void {}

export function rtcdtmfSenderRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function rtcRtpTransceiverStop(): void {}

export function treeWalkerFirstChild(): number {
  throw new Error("stub: tree-walker_first-child")
}

export function treeWalkerLastChild(): number {
  throw new Error("stub: tree-walker_last-child")
}

export function treeWalkerNextSibling(): number {
  throw new Error("stub: tree-walker_next-sibling")
}

export function treeWalkerParentNode(): number {
  throw new Error("stub: tree-walker_parent-node")
}

export function treeWalkerPreviousSibling(): number {
  throw new Error("stub: tree-walker_previous-sibling")
}

export interface VisibilityState {

}

export interface Document {
  url: any
  alinkColor: any
  all: any
  anchors: any
  applets: any
  bgColor: any
  body: any
  characterSet: any
  charset: any
  compatMode: any
  contentType: any
  cookie: any
  currentScript: any
  defaultView: any
  designMode: any
  dir: any
  doctype: any
  documentElement: any
  documentURI: any
  domain: any
  embeds: any
  fgColor: any
  forms: any
  fullscreen: any
  fullscreenEnabled: any
  head: any
  hidden: any
  images: any
  implementation: any
  inputEncoding: any
  lastModified: any
  linkColor: any
  links: any
  onfullscreenchange: any
  onfullscreenerror: any
  onpointerlockchange: any
  onpointerlockerror: any
  onreadystatechange: any
  onvisibilitychange: any
  ownerDocument: any
  pictureInPictureEnabled: any
  plugins: any
  readyState: any
  referrer: any
  scripts: any
  scrollingElement: any
  timeline: any
  title: any
  visibilityState: any
  vlinkColor: any
}

export function documentLocation0(): Location {
  throw new Error("stub: document_location__0")
}

export function documentLocation1(href: number): void {}

export function documentClear(): void {}

export function documentClose(): void {}

export function documentCreateElement20<K>(tagName: K, options: Maybe<number>): number {
  throw new Error("stub: document_create-element__2__0")
}

export function documentCreateElement21<K>(tagName: K, options: Maybe<number>): number {
  throw new Error("stub: document_create-element__2__1")
}

export function documentCreateElement22(tagName: string, options: Maybe<number>): HtmlElement {
  throw new Error("stub: document_create-element__2__2")
}

export function documentCreateElementNs20(namespaceUri: number, qualifiedName: string): HtmlElement {
  throw new Error("stub: document_create-element-ns__2__0")
}

export function documentCreateElementNs21<K>(namespaceUri: number, qualifiedName: K): number {
  throw new Error("stub: document_create-element-ns__2__1")
}

export function documentCreateElementNs22(namespaceUri: number, qualifiedName: string): SvgElement {
  throw new Error("stub: document_create-element-ns__2__2")
}

export function documentCreateElementNs3(namespace: number, qualifiedName: string, options: Maybe<number>): Element {
  throw new Error("stub: document_create-element-ns__3")
}

export function documentCreateTextNode(data: string): string {
  throw new Error("stub: document_create-text-node")
}

export function documentGetElementsByTagName10<K>(qualifiedName: K): HtmlCollectionOf<number> {
  throw new Error("stub: document_get-elements-by-tag-name__1__0")
}

export function documentGetElementsByTagName11<K>(qualifiedName: K): HtmlCollectionOf<number> {
  throw new Error("stub: document_get-elements-by-tag-name__1__1")
}

export function documentGetElementsByTagName12(qualifiedName: string): HtmlCollectionOf<Element> {
  throw new Error("stub: document_get-elements-by-tag-name__1__2")
}

export function documentOpen2(unused1: Maybe<number>, unused2: Maybe<number>): Document {
  throw new Error("stub: document_open__2")
}

export function documentOpen3(url: number, name: string, features: string): number {
  throw new Error("stub: document_open__3")
}

export function documentAddEventListener30<K>(type: K, listener: (a0: Document, a1: number) => number, options: Maybe<number>): void {}

export function documentAddEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

export function documentRemoveEventListener30<K>(type: K, listener: (a0: Document, a1: number) => number, options: Maybe<number>): void {}

export function documentRemoveEventListener31(type: string, listener: EventListenerOrEventListenerObject, options: Maybe<number>): void {}

const page = document

export type Maybe<T = any> =
  | { form: "some"; value: T }
  | { form: "none" }

export function createElement(tag: string): View {
  const made = page.createElement(tag, { form: "none" })
  return { handle: made }
}

export function createText(value: string): View {
  const made = page.createTextNode(value)
  return { handle: made }
}

export function setText(node: View, value: string): void {
  node.handle.textContent = value
}

export function setAttribute(node: View, name: string, value: string): void {
  const made = node.handle
  made.setAttribute(name, value)
}

export function focus(node: View): void {
  const made = node.handle
  made.focus({ form: "none" })
}

export function blur(node: View): void {
  const made = node.handle
  made.blur()
}

export function listen(node: View, event: string, handler: () => void): void {
  const made = node.handle
  made.addEventListener(event, handler, { form: "none" })
}

export function pageBody(): View {
  return { handle: page.body }
}

export function append(parent: View, child: View): void {
  const made = parent.handle
  made.appendChild(child.handle)
}

export function replace(old: View, new_: View): void {
  const made = old.handle
  made.replaceWith(new_.handle)
}

export function clear(node: View): void {
  node.handle.textContent = ""
}

export function remove(node: View): void {
  const made = node.handle
  made.remove()
}

export function getValue(node: View): string {
  return node.handle.value
}

export function setValue(node: View, value: string): void {
  node.handle.value = value
}

export type Side =
  | { form: "start" }
  | { form: "end" }
  | { form: "both" }

export function listIsEmpty<T>(self: T[]): boolean {
  return self.length == 0
}

export function listPush<T>(self: T[], item: T): number {
  return self.push(item)
}

export function listPop<T>(self: T[]): T {
  return self.pop()
}

export function listGet<T>(self: T[], index: number): T {
  return self.at(index)
}

export function listSet<T>(self: T[], index: number, item: T): T[] {
  self.splice(index, 1, item)
  return self
}

export function listClear<T>(self: T[]): T[] {
  while (self.length > 0) {
    listPop(self)
  }
  return self
}

export function listCopy<T>(self: T[]): T[] {
  return self.slice(0)
}

export function listConcat<T>(self: T[], other: T[]): T[] {
  return self.concat(other)
}

export function listSlice<T>(self: T[], start: number, end: number): T[] {
  return self.slice(start, end)
}

export function listMap<T, S>(self: T[], call: (a0: T) => S): S[] {
  return self.map(call)
}

export function listFilter<T>(self: T[], test: (a0: T) => boolean): T[] {
  return self.filter(test)
}

export function listDrop<T>(self: T[], count: number, side: Side): T[] {
  if (side.form === "end") {
    return self.slice(0, self.length - count)
  } else if (side.form === "start") {
    return self.slice(count)
  } else if (side.form === "both") {
    return self.slice(count)
  }
}

export function listUnique<T>(self: T[]): T[] {
  const out = []
  for (const value of self) {
    const seen = out.includes(value)
    if (!seen) {
      out.push(value)
    }
  }
  return out
}

export interface Signal<T = any> {
  value: T
  observers: any[]
}

export interface Effect {
  run: () => void
  live: boolean
}

export interface Owner {
  effects: any[]
  cleanups: any[]
}

const running = []

const owners = []

export interface ReactFlags {
  batching: boolean
  paused: boolean
  queue: any[]
}

const flags = { batching: false, paused: false, queue: [] }

export function makeSignal<T>(value: T): Signal<T> {
  return { value: value, observers: [] }
}

export function readSignal(self: any): any {
  track(self)
  return self.value
}

export function writeSignal(self: any, value: any): void {
  self.value = value
  const subscribers = self.observers
  self.observers = []
  for (const observer of subscribers) {
    if (flags.batching) {
      listPush(flags.queue, observer)
    } else {
      runEffect(observer)
    }
  }
}

export function makeEffect(run: () => void): Effect {
  const own = { run: run, live: true }
  if (listIsEmpty(owners)) {} else {
    const top = listGet(owners, owners.length - 1)
    listPush(top.effects, own)
  }
  runEffect(own)
  return own
}

export function onCleanup(run: () => void): void {
  if (listIsEmpty(owners)) {} else {
    const top = listGet(owners, owners.length - 1)
    listPush(top.cleanups, run)
  }
}

export function runEffect(effect: Effect): void {
  if (effect.live) {
    listPush(running, effect)
    effect.run()
    listPop(running)
  } else {}
}

export function openScope(): Owner {
  const own = { effects: [], cleanups: [] }
  listPush(owners, own)
  return own
}

export function closeScope(): void {
  listPop(owners)
}

export function disposeScope(scope: Owner): void {
  for (const member of scope.effects) {
    member.live = false
  }
  for (const run of scope.cleanups) {
    run()
  }
}

export function track(signal: number): void {
  if (flags.paused) {
    const skip = 0
  } else {
    if (listIsEmpty(running)) {
      const skip = 0
    } else {
      const index = running.length - 1
      const current = listGet(running, index)
      listPush(signal.observers, current)
    }
  }
}

export function element(tag: string): View {
  return createElement(tag)
}

export function text(value: string): View {
  return createText(value)
}

export function attribute(node: View, name: string, value: string): void {
  setAttribute(node, name, value)
}

export function event(node: View, name: string, handler: () => void): void {
  listen(node, name, handler)
}

export function bindAttribute(node: View, name: string, source: () => string): void {
  makeEffect(() => {
  setAttribute(node, name, source())
})
}

export function dynamic(source: () => string): View {
  const host = createText("")
  makeEffect(() => {
  setText(host, source())
})
  return host
}

export function show(host: View, when: () => boolean, then: () => View, other: () => View): void {
  let current = createText("")
  append(host, current)
  makeEffect(() => {
  const next = when() ? then() : other()
  replace(current, next)
  current = next
})
}

export function each<T>(host: View, items: () => T[], build: (a0: T) => View): void {
  let mounted = []
  makeEffect(() => {
  for (const old of mounted) {
    remove(old)
  }
  const fresh = []
  const current = items()
  for (const item of current) {
    const node = build(item)
    append(host, node)
    listPush(fresh, node)
  }
  mounted = fresh
})
}

export function eachKeyed<T>(host: View, items: () => T[], key: (a0: T) => string, build: (a0: T) => View): void {
  let keys = []
  let nodes = []
  makeEffect(() => {
  const current = items()
  const nextKeys = []
  const nextNodes = []
  for (const item of current) {
    const k = key(item)
    let found = 0
    let i = 0
    for (const oldKey of keys) {
      if (oldKey == k) {
        found = i + 1
      }
      i = i + 1
    }
    const node = found > 0 ? listGet(nodes, found - 1) : build(item)
    listPush(nextKeys, k)
    listPush(nextNodes, node)
  }
  let j = 0
  for (const oldKey of keys) {
    let still = 0
    for (const nk of nextKeys) {
      if (nk == oldKey) {
        still = still + 1
      }
    }
    if (still == 0) {
      remove(listGet(nodes, j))
    }
    j = j + 1
  }
  for (const node of nextNodes) {
    append(host, node)
  }
  keys = nextKeys
  nodes = nextNodes
})
}

export function dynamicView(host: View, source: () => View): void {
  let current = createText("")
  append(host, current)
  makeEffect(() => {
  const next = source()
  replace(current, next)
  current = next
})
}

export function gate(host: View, status: () => string, pending: () => View, failed: () => View, ready: () => View): void {
  let current = createText("")
  append(host, current)
  makeEffect(() => {
  const next = status() == "pending" ? pending() : status() == "error" ? failed() : ready()
  replace(current, next)
  current = next
})
}

export function mount(host: View, build: () => View): void {
  append(host, build())
}

export function portal(target: View, build: () => View): View {
  const marker = createText("")
  const content = build()
  append(target, content)
  onCleanup(() => {
  remove(content)
})
  return marker
}

export interface Post {
  title: string
  body: string
}

export function addPost(titleField: View, bodyField: View, posts: Signal<number[]>): void {
  const titleText = getValue(titleField)
  const bodyText = getValue(bodyField)
  const current = readSignal(posts)
  listPush(current, { title: titleText, body: bodyText })
  writeSignal(posts, current)
  setValue(titleField, "")
  setValue(bodyField, "")
}

export function blog(host: View): number {
  const posts = makeSignal([])
  const view0 = element("div")
  const titleInput = element("input")
  append(view0, titleInput)
  const bodyInput = element("textarea")
  append(view0, bodyInput)
  const view1 = element("button")
  event(view1, "click", () => (addPost(titleInput, bodyInput, posts)))
  const view2 = text("Add post")
  append(view1, view2)
  append(view0, view1)
  const postList = element("div")
  each(postList, () => (readSignal(posts)), (item: number) => {
  const view3 = element("div")
  const view4 = element("h2")
  const view5 = dynamic(() => (item.title))
  append(view4, view5)
  append(view3, view4)
  const view6 = element("p")
  const view7 = dynamic(() => (item.body))
  append(view6, view7)
  append(view3, view6)
  return view3
})
  append(view0, postList)
  append(host, view0)
}

export function boot(): void {
  blog(pageBody())
}
