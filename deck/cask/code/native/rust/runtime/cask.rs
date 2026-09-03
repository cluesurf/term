// The cask runtime for Linux and Windows, provided to Term via <global:cask> (docked `name cask`), so the module IS
// the binding and the native module calls `cask::open_window(title, width, height)`. One file, two toolkits under
// `cfg`: GTK4 with WebKitGTK 6 on Linux, Win32 with WebView2 on Windows. The shape is the Swift runtime's
// (deck/cask/code/native/swift/runtime/cask.swift): a window handle, a WebView, a script message handler that
// receives `window.term.post`, an asynchronous message handler whose reply goes back as `window.term.reply(text)`,
// and an event loop. On any other platform the functions are stubs, so the Term program still typechecks there
// (`cargo check` on a Mac holds the emitted program to these signatures before a Linux box builds it).
//
// Asynchronous handlers run on the UI thread. On Linux, glib's main context is the executor. On Windows there is no
// executor in Win32, so a small one lives here: a task list polled on a custom window message, whose waker posts
// that message. The stdlib's asynchronous natives (tokio's fs) run against a tokio runtime this thread has entered;
// their blocking work runs on tokio's pool and wakes the UI-thread task through the same wakers.
//
// CASK_TRACE=1 in the environment prints every message and reply. Design: note/term/cask/readme.md.
#[allow(dead_code)]
mod cask {
    use std::future::Future;
    use std::pin::Pin;
    use std::rc::Rc;

    // the Term handler for a message: `like task / wait true / take message, like text / like text`
    pub type Handler = Rc<dyn Fn(String) -> Pin<Box<dyn Future<Output = String>>>>;
    // `like task / like void`
    pub type Ready = Rc<dyn Fn() -> ()>;

    fn trace() -> bool {
        std::env::var_os("CASK_TRACE").is_some()
    }

    // a JavaScript string literal for a text
    fn quote(text: &str) -> String {
        serde_json::to_string(text).unwrap_or_else(|_| "\"\"".to_string())
    }

    // the object the page finds at document start. `post` is the one platform-specific line: how a string reaches
    // the native side. The page-side runtime (deck/seed/code/native/webview/runtime/bridge.ts) builds on this. The
    // two listeners forward an error thrown before the bridge module is even evaluated, so it never vanishes
    fn bridge_shim(post: &str) -> String {
        format!(
            "Object.defineProperty(window, 'term', {{ value: {{\n\
             post: function (text) {{ {post} }},\n\
             reply: function (message) {{ if (window.term.onReply) {{ window.term.onReply(message) }} }},\n\
             push: function (name, text) {{ if (window.term.onPush) {{ window.term.onPush(name, text) }} }},\n\
             onReply: null,\n\
             onPush: null\n\
             }} }});\n\
             Object.freeze(window.term.post);\n\
             window.addEventListener('error', function (event) {{\n\
             window.term.post(JSON.stringify({{ id: '', command: 'cask_log', arguments: {{ text: 'error: ' + (event.message || String(event.error)) + ' at ' + (event.filename || '?') + ':' + (event.lineno || 0) }} }}))\n\
             }});\n\
             window.addEventListener('unhandledrejection', function (event) {{\n\
             var reason = event.reason;\n\
             window.term.post(JSON.stringify({{ id: '', command: 'cask_log', arguments: {{ text: 'unhandled rejection: ' + (reason && reason.message ? reason.message + '\\n' + reason.stack : String(reason)) }} }}))\n\
             }});\n"
        )
    }

    // the process leaves with the status the page asked for. The line is what a harness reads when the status
    // itself is out of reach (a device's log)
    pub fn exit(status: i64) -> () {
        use std::io::Write;
        println!("cask exit {}", status);
        let _ = std::io::stdout().flush();
        std::process::exit(status as i32)
    }

    // the app's own read-only files. Linux: `<app>/bin/<name>` sits beside `<app>/resources`. Windows:
    // `<app>/<name>.exe` beside `<app>/resources`. `term make` lays both out this way
    pub fn bundle_path() -> String {
        let exe = std::env::current_exe().unwrap_or_default();
        let directory = exe.parent().map(|p| p.to_path_buf()).unwrap_or_default();
        let beside = directory.join("resources");
        if beside.is_dir() {
            return beside.to_string_lossy().to_string();
        }
        directory
            .parent()
            .map(|p| p.join("resources"))
            .unwrap_or(beside)
            .to_string_lossy()
            .to_string()
    }

    // a directory of the app's own, named `name`, for what it keeps between runs. Linux: `$XDG_DATA_HOME/<name>`,
    // which is `~/.local/share/<name>` by default. Windows: `%APPDATA%\<name>`
    pub fn data_path(name: String) -> String {
        let base = if cfg!(windows) {
            std::env::var_os("APPDATA").map(std::path::PathBuf::from)
        } else {
            std::env::var_os("XDG_DATA_HOME")
                .map(std::path::PathBuf::from)
                .or_else(|| std::env::var_os("HOME").map(|home| std::path::PathBuf::from(home).join(".local/share")))
        };
        let directory = base.unwrap_or_else(std::env::temp_dir).join(name);
        let _ = std::fs::create_dir_all(&directory);
        directory.to_string_lossy().to_string()
    }

    // ---- Linux: GTK4 and WebKitGTK 6 ----

    #[cfg(target_os = "linux")]
    mod imp {
        use super::{bridge_shim, quote, trace, Handler, Ready};
        use gtk4 as gtk;
        use gtk::gio;
        use gtk::glib;
        use gtk::prelude::*;
        use std::cell::RefCell;
        use std::rc::Rc;
        use webkit6::prelude::*;

        pub struct Inner {
            window: gtk::Window,
            webview: webkit6::WebView,
            handler: RefCell<Option<Handler>>,
            ready: RefCell<Option<Ready>>,
        }

        // the opaque handle Term holds: `dock type / load <cask::CaskWindow>, name window`
        #[derive(Clone)]
        pub struct CaskWindow(Rc<Inner>);

        thread_local! {
            static MAIN_LOOP: RefCell<Option<glib::MainLoop>> = RefCell::new(None);
        }

        pub fn open_window(title: String, width: i64, height: i64) -> CaskWindow {
            gtk::init().expect("cask: GTK could not start. Is there a display? (a test runs under xvfb-run)");
            let manager = webkit6::UserContentManager::new();
            manager.register_script_message_handler("term", None);
            let shim = webkit6::UserScript::new(
                &bridge_shim("window.webkit.messageHandlers.term.postMessage(String(text))"),
                webkit6::UserContentInjectedFrames::TopFrame,
                webkit6::UserScriptInjectionTime::Start,
                &[],
                &[],
            );
            manager.add_script(&shim);
            let webview = webkit6::WebView::builder().user_content_manager(&manager).build();
            if let Some(settings) = WebViewExt::settings(&webview) {
                // a bundle is loaded from the app's own files, and a page loaded from a file URL may fetch its siblings
                settings.set_allow_file_access_from_file_urls(true);
                settings.set_allow_universal_access_from_file_urls(true);
            }
            let window = gtk::Window::builder()
                .title(title.as_str())
                .default_width(width as i32)
                .default_height(height as i32)
                .build();
            window.set_child(Some(&webview));
            let handle = CaskWindow(Rc::new(Inner {
                window,
                webview: webview.clone(),
                handler: RefCell::new(None),
                ready: RefCell::new(None),
            }));
            let receiver = handle.clone();
            manager.connect_script_message_received(Some("term"), move |_, value| {
                receiver.receive(value.to_str().to_string());
            });
            let loaded = handle.clone();
            webview.connect_load_changed(move |_, event| {
                if event == webkit6::LoadEvent::Finished {
                    let ready = loaded.0.ready.borrow().clone();
                    if let Some(ready) = ready {
                        ready();
                    }
                }
            });
            handle.0.window.connect_close_request(|_| {
                quit();
                glib::Propagation::Proceed
            });
            // GTK has no off-screen window and a WebView renders only once its window is realised, so the window is
            // shown now. A test runs under xvfb-run, where nothing is on a desk to disturb
            handle.0.window.set_visible(true);
            handle
        }

        impl CaskWindow {
            fn receive(&self, text: String) {
                if trace() {
                    println!("cask <- {}", text);
                }
                let handler = self.0.handler.borrow().clone();
                let Some(handler) = handler else { return };
                let webview = self.0.webview.clone();
                glib::MainContext::default().spawn_local(async move {
                    let reply = handler(text).await;
                    if trace() {
                        println!("cask -> {}", reply);
                    }
                    webview.evaluate_javascript(
                        &format!("window.term.reply({})", reply),
                        None,
                        None,
                        gio::Cancellable::NONE,
                        |_| {},
                    );
                });
            }

            fn eval(&self, script: &str) {
                self.0.webview.evaluate_javascript(script, None, None, gio::Cancellable::NONE, |_| {});
            }
        }

        pub fn load_bundle(handle: CaskWindow, path: String) -> () {
            handle.0.webview.load_uri(&format!("file://{}/index.html", path));
        }

        pub fn load_url(handle: CaskWindow, url: String) -> () {
            handle.0.webview.load_uri(&url);
        }

        pub fn eval(handle: CaskWindow, script: String) -> () {
            handle.eval(&script);
        }

        pub fn emit(handle: CaskWindow, name: String, text: String) -> () {
            handle.eval(&format!("window.term.push({}, {})", quote(&name), quote(&text)));
        }

        pub fn on_message(handle: CaskWindow, handler: Handler) -> () {
            *handle.0.handler.borrow_mut() = Some(handler);
        }

        pub fn on_ready(handle: CaskWindow, handler: Ready) -> () {
            *handle.0.ready.borrow_mut() = Some(handler);
        }

        // the visible part of the page as a PNG at `path`, then `done`
        pub fn snapshot(handle: CaskWindow, path: String, done: Ready) -> () {
            handle.0.webview.snapshot(
                webkit6::SnapshotRegion::Visible,
                webkit6::SnapshotOptions::NONE,
                gio::Cancellable::NONE,
                move |result| {
                    if let Ok(texture) = result {
                        let _ = texture.save_to_png(&path);
                    }
                    done();
                },
            );
        }

        pub fn show(handle: CaskWindow) -> () {
            handle.0.window.set_visible(true);
        }

        pub fn activate(handle: CaskWindow) -> () {
            handle.0.window.present();
        }

        // the event loop, which returns when `quit` is called or the last window closes. A tokio runtime is entered
        // first so the stdlib's asynchronous natives have their pool
        pub fn run() -> () {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("cask: the tokio runtime could not start");
            let _entered = runtime.enter();
            let main_loop = glib::MainLoop::new(None, false);
            MAIN_LOOP.with(|slot| *slot.borrow_mut() = Some(main_loop.clone()));
            main_loop.run();
        }

        pub fn quit() -> () {
            MAIN_LOOP.with(|slot| {
                if let Some(main_loop) = slot.borrow().as_ref() {
                    main_loop.quit();
                }
            });
        }
    }

    // ---- Windows: Win32 and WebView2 ----

    #[cfg(windows)]
    mod imp {
        use super::{bridge_shim, quote, trace, Handler, Ready};
        use std::cell::RefCell;
        use std::future::Future;
        use std::pin::Pin;
        use std::rc::Rc;
        use std::sync::Arc;
        use std::task::{Context, Poll, Wake, Waker};
        use webview2_com::Microsoft::Web::WebView2::Win32::*;
        use webview2_com::*;
        use windows::core::{w, HSTRING, PCWSTR, PWSTR};
        use windows::Win32::Foundation::{E_FAIL, HWND, LPARAM, LRESULT, RECT, WPARAM};
        use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
        use windows::Win32::System::Com::{CoInitializeEx, CoTaskMemFree, COINIT_APARTMENTTHREADED, STGM_CREATE, STGM_WRITE};
        use windows::Win32::System::WinRT::EventRegistrationToken;
        use windows::Win32::System::LibraryLoader::GetModuleHandleW;
        use windows::Win32::UI::Shell::SHCreateStreamOnFileEx;
        use windows::Win32::UI::WindowsAndMessaging::*;

        // the message the executor polls its tasks on
        const WM_CASK_POLL: u32 = WM_APP + 1;

        enum Load {
            Bundle(String),
            Url(String),
        }

        pub struct Inner {
            hwnd: HWND,
            controller: RefCell<Option<ICoreWebView2Controller>>,
            webview: RefCell<Option<ICoreWebView2>>,
            handler: RefCell<Option<Handler>>,
            ready: RefCell<Option<Ready>>,
            // a load asked for before the WebView existed, run the moment it does
            pending: RefCell<Option<Load>>,
            // scripts asked for before the WebView existed
            queued: RefCell<Vec<String>>,
        }

        // the opaque handle Term holds: `dock type / load <cask::CaskWindow>, name window`
        #[derive(Clone)]
        pub struct CaskWindow(Rc<Inner>);

        thread_local! {
            static WINDOWS: RefCell<Vec<CaskWindow>> = RefCell::new(Vec::new());
            static TASKS: RefCell<Vec<Pin<Box<dyn Future<Output = ()>>>>> = RefCell::new(Vec::new());
        }

        // a waker that posts the poll message to the window, so a task woken from tokio's pool is polled on the
        // UI thread. The window handle travels as an integer, which is what it is
        struct PostWaker(isize);

        impl Wake for PostWaker {
            fn wake(self: Arc<Self>) {
                unsafe {
                    let _ = PostMessageW(HWND(self.0 as *mut _), WM_CASK_POLL, WPARAM(0), LPARAM(0));
                }
            }
        }

        fn spawn_local(hwnd: HWND, future: impl Future<Output = ()> + 'static) {
            TASKS.with(|tasks| tasks.borrow_mut().push(Box::pin(future)));
            unsafe {
                let _ = PostMessageW(hwnd, WM_CASK_POLL, WPARAM(0), LPARAM(0));
            }
        }

        fn poll_tasks(hwnd: HWND) {
            let waker: Waker = Arc::new(PostWaker(hwnd.0 as isize)).into();
            let mut context = Context::from_waker(&waker);
            let mut tasks = TASKS.with(|tasks| std::mem::take(&mut *tasks.borrow_mut()));
            tasks.retain_mut(|task| task.as_mut().poll(&mut context).is_pending());
            TASKS.with(|slot| {
                let mut slot = slot.borrow_mut();
                tasks.append(&mut slot);
                *slot = tasks;
            });
        }

        fn window_of(hwnd: HWND) -> Option<CaskWindow> {
            WINDOWS.with(|windows| windows.borrow().iter().find(|w| w.0.hwnd == hwnd).cloned())
        }

        unsafe extern "system" fn wndproc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
            match message {
                WM_SIZE => {
                    if let Some(window) = window_of(hwnd) {
                        window.fit();
                    }
                    LRESULT(0)
                }
                WM_CASK_POLL => {
                    poll_tasks(hwnd);
                    LRESULT(0)
                }
                WM_CLOSE => {
                    let _ = DestroyWindow(hwnd);
                    LRESULT(0)
                }
                WM_DESTROY => {
                    PostQuitMessage(0);
                    LRESULT(0)
                }
                _ => DefWindowProcW(hwnd, message, wparam, lparam),
            }
        }

        pub fn open_window(title: String, width: i64, height: i64) -> CaskWindow {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
                let instance = GetModuleHandleW(None).expect("cask: the module handle");
                let class_name = w!("TermCaskWindow");
                let class = WNDCLASSW {
                    lpfnWndProc: Some(wndproc),
                    hInstance: instance.into(),
                    lpszClassName: class_name,
                    hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                    ..Default::default()
                };
                // a second registration fails, harmlessly: the class is already there
                RegisterClassW(&class);
                // off screen and hidden until `show`, like the macOS cask; the WebView runs all the same
                let hwnd = CreateWindowExW(
                    WINDOW_EX_STYLE(0),
                    class_name,
                    &HSTRING::from(title.as_str()),
                    WS_OVERLAPPEDWINDOW,
                    -10000,
                    -10000,
                    width as i32,
                    height as i32,
                    None,
                    None,
                    instance,
                    None,
                )
                .expect("cask: the window");
                let handle = CaskWindow(Rc::new(Inner {
                    hwnd,
                    controller: RefCell::new(None),
                    webview: RefCell::new(None),
                    handler: RefCell::new(None),
                    ready: RefCell::new(None),
                    pending: RefCell::new(None),
                    queued: RefCell::new(Vec::new()),
                }));
                WINDOWS.with(|windows| windows.borrow_mut().push(handle.clone()));
                handle.create_webview();
                handle
            }
        }

        impl CaskWindow {
            // the WebView2 environment, then its controller, then the WebView: three callbacks on the UI thread
            fn create_webview(&self) {
                let handle = self.clone();
                let hwnd = self.0.hwnd;
                let environment_done = CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
                    move |result, environment| {
                        result?;
                        let environment = environment.ok_or_else(|| windows::core::Error::from(E_FAIL))?;
                        let handle = handle.clone();
                        let controller_done = CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
                            move |result, controller| {
                                result?;
                                let controller = controller.ok_or_else(|| windows::core::Error::from(E_FAIL))?;
                                unsafe {
                                    let webview = controller.CoreWebView2()?;
                                    webview.AddScriptToExecuteOnDocumentCreated(
                                        &HSTRING::from(bridge_shim("window.chrome.webview.postMessage(String(text))")),
                                        &AddScriptToExecuteOnDocumentCreatedCompletedHandler::create(Box::new(|_, _| Ok(()))),
                                    )?;
                                    let receiver = handle.clone();
                                    let mut token = EventRegistrationToken::default();
                                    webview.add_WebMessageReceived(
                                        &WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                                            if let Some(args) = args {
                                                let mut text = PWSTR::null();
                                                if args.TryGetWebMessageAsString(&mut text).is_ok() {
                                                    let owned = text.to_string().unwrap_or_default();
                                                    CoTaskMemFree(Some(text.0 as *const _));
                                                    receiver.receive(owned);
                                                }
                                            }
                                            Ok(())
                                        })),
                                        &mut token,
                                    )?;
                                    let loaded = handle.clone();
                                    webview.add_NavigationCompleted(
                                        &NavigationCompletedEventHandler::create(Box::new(move |_, _| {
                                            let ready = loaded.0.ready.borrow().clone();
                                            if let Some(ready) = ready {
                                                ready();
                                            }
                                            Ok(())
                                        })),
                                        &mut token,
                                    )?;
                                    *handle.0.webview.borrow_mut() = Some(webview);
                                    *handle.0.controller.borrow_mut() = Some(controller);
                                }
                                handle.fit();
                                handle.apply_pending();
                                Ok(())
                            },
                        ));
                        unsafe { environment.CreateCoreWebView2Controller(hwnd, &controller_done) }
                    },
                ));
                // the WebView2 user data goes in the app's own data directory, since an installed app's own
                // directory is not writable
                let name = std::env::current_exe()
                    .ok()
                    .and_then(|exe| exe.file_stem().map(|stem| stem.to_string_lossy().to_string()))
                    .unwrap_or_else(|| "TermCask".to_string());
                let data = HSTRING::from(super::data_path(name));
                unsafe {
                    CreateCoreWebView2EnvironmentWithOptions(PCWSTR::null(), &data, None, &environment_done)
                        .expect("cask: the WebView2 runtime. Is Microsoft Edge WebView2 installed?");
                }
            }

            // the WebView fills the window's client area
            fn fit(&self) {
                if let Some(controller) = self.0.controller.borrow().as_ref() {
                    unsafe {
                        let mut rect = RECT::default();
                        let _ = GetClientRect(self.0.hwnd, &mut rect);
                        let _ = controller.SetBounds(rect);
                    }
                }
            }

            fn apply_pending(&self) {
                let load = self.0.pending.borrow_mut().take();
                if let (Some(load), Some(webview)) = (load, self.0.webview.borrow().as_ref()) {
                    let url = match load {
                        Load::Bundle(path) => format!("file:///{}/index.html", path.replace('\\', "/")),
                        Load::Url(url) => url,
                    };
                    unsafe {
                        let _ = webview.Navigate(&HSTRING::from(url));
                    }
                }
                let queued: Vec<String> = std::mem::take(&mut *self.0.queued.borrow_mut());
                for script in queued {
                    self.eval(&script);
                }
            }

            fn receive(&self, text: String) {
                if trace() {
                    println!("cask <- {}", text);
                }
                let handler = self.0.handler.borrow().clone();
                let Some(handler) = handler else { return };
                let this = self.clone();
                spawn_local(self.0.hwnd, async move {
                    let reply = handler(text).await;
                    if trace() {
                        println!("cask -> {}", reply);
                    }
                    this.eval(&format!("window.term.reply({})", reply));
                });
            }

            fn eval(&self, script: &str) {
                if let Some(webview) = self.0.webview.borrow().as_ref() {
                    unsafe {
                        let _ = webview.ExecuteScript(
                            &HSTRING::from(script),
                            &ExecuteScriptCompletedHandler::create(Box::new(|_, _| Ok(()))),
                        );
                    }
                } else {
                    self.0.queued.borrow_mut().push(script.to_string());
                }
            }

            fn load(&self, load: Load) {
                *self.0.pending.borrow_mut() = Some(load);
                if self.0.webview.borrow().is_some() {
                    self.apply_pending();
                }
            }
        }

        pub fn load_bundle(handle: CaskWindow, path: String) -> () {
            handle.load(Load::Bundle(path));
        }

        pub fn load_url(handle: CaskWindow, url: String) -> () {
            handle.load(Load::Url(url));
        }

        pub fn eval(handle: CaskWindow, script: String) -> () {
            handle.eval(&script);
        }

        pub fn emit(handle: CaskWindow, name: String, text: String) -> () {
            handle.eval(&format!("window.term.push({}, {})", quote(&name), quote(&text)));
        }

        pub fn on_message(handle: CaskWindow, handler: Handler) -> () {
            *handle.0.handler.borrow_mut() = Some(handler);
        }

        pub fn on_ready(handle: CaskWindow, handler: Ready) -> () {
            *handle.0.ready.borrow_mut() = Some(handler);
        }

        // the page as a PNG at `path`, then `done`
        pub fn snapshot(handle: CaskWindow, path: String, done: Ready) -> () {
            let Some(webview) = handle.0.webview.borrow().clone() else {
                done();
                return;
            };
            unsafe {
                let stream = SHCreateStreamOnFileEx(
                    &HSTRING::from(path),
                    (STGM_CREATE | STGM_WRITE).0,
                    FILE_ATTRIBUTE_NORMAL.0,
                    true,
                    None,
                );
                match stream {
                    Ok(stream) => {
                        let _ = webview.CapturePreview(
                            COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                            &stream,
                            &CapturePreviewCompletedHandler::create(Box::new(move |_| {
                                done();
                                Ok(())
                            })),
                        );
                    }
                    Err(_) => done(),
                }
            }
        }

        // the window comes on screen, behind whatever is in front, without taking the focus
        pub fn show(handle: CaskWindow) -> () {
            unsafe {
                let _ = SetWindowPos(
                    handle.0.hwnd,
                    None,
                    120,
                    120,
                    0,
                    0,
                    SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW,
                );
            }
        }

        pub fn activate(handle: CaskWindow) -> () {
            show(handle.clone());
            unsafe {
                let _ = SetForegroundWindow(handle.0.hwnd);
            }
        }

        // the message loop, which returns when `quit` is called or the window is destroyed. A tokio runtime is
        // entered first so the stdlib's asynchronous natives have their pool
        pub fn run() -> () {
            let runtime = tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .expect("cask: the tokio runtime could not start");
            let _entered = runtime.enter();
            unsafe {
                let mut message = MSG::default();
                while GetMessageW(&mut message, None, 0, 0).as_bool() {
                    let _ = TranslateMessage(&message);
                    DispatchMessageW(&message);
                }
            }
        }

        pub fn quit() -> () {
            unsafe { PostQuitMessage(0) }
        }
    }

    // ---- anywhere else: signatures only, so the program typechecks before a Linux or Windows box builds it ----

    #[cfg(not(any(target_os = "linux", windows)))]
    mod imp {
        use super::{Handler, Ready};

        #[derive(Clone)]
        pub struct CaskWindow;

        const ELSEWHERE: &str = "the Rust cask runs on Linux and Windows; on this platform use `term make --target macos`";

        pub fn open_window(_title: String, _width: i64, _height: i64) -> CaskWindow {
            unimplemented!("{}", ELSEWHERE)
        }
        pub fn load_bundle(_handle: CaskWindow, _path: String) -> () {
            unimplemented!("{}", ELSEWHERE)
        }
        pub fn load_url(_handle: CaskWindow, _url: String) -> () {
            unimplemented!("{}", ELSEWHERE)
        }
        pub fn eval(_handle: CaskWindow, _script: String) -> () {
            unimplemented!("{}", ELSEWHERE)
        }
        pub fn emit(_handle: CaskWindow, _name: String, _text: String) -> () {
            unimplemented!("{}", ELSEWHERE)
        }
        pub fn on_message(_handle: CaskWindow, _handler: Handler) -> () {
            unimplemented!("{}", ELSEWHERE)
        }
        pub fn on_ready(_handle: CaskWindow, _handler: Ready) -> () {
            unimplemented!("{}", ELSEWHERE)
        }
        pub fn snapshot(_handle: CaskWindow, _path: String, _done: Ready) -> () {
            unimplemented!("{}", ELSEWHERE)
        }
        pub fn show(_handle: CaskWindow) -> () {
            unimplemented!("{}", ELSEWHERE)
        }
        pub fn activate(_handle: CaskWindow) -> () {
            unimplemented!("{}", ELSEWHERE)
        }
        pub fn run() -> () {
            unimplemented!("{}", ELSEWHERE)
        }
        pub fn quit() -> () {
            unimplemented!("{}", ELSEWHERE)
        }
    }

    pub use imp::*;
}
