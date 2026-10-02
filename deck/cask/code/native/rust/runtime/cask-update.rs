// Over-the-air page updates on Linux and Windows (native-dom-0032): the client half, the twin of the Apple one
// (../../swift/runtime/cask-update.swift), which documents the order a launch runs in, and the Android one
// (../../kotlin/runtime/cask-update.kt). The publisher is deck/call/code/update.ts. Reached through ../cask.tree as
// `cask_update::launch_path`, `cask_update::check`, `cask_update::ready`.
//
// The same files and the same layout as the other two: `<resources>/runtime-version` and
// `<resources>/update-key.spki.der` shipped inside the app, `<data>/updates/<id>/` per staged update, and `current`,
// `launching` and `bad` beside them. The same statuses: `none`, `current`, `applied <id>`, `refused: <reason>`.
//
// Nothing here trusts the network: a manifest is used only after its exact bytes verify (RSASSA-PKCS1-v1_5 over
// SHA-256) against the key inside the app, and an asset only after its sha256 equals the one the signed manifest
// names. A file:// base works as well as https://, which is how the tests serve updates.
//
// The fetch runs on its own thread, never the UI one, and `done` is called back on the UI thread through the cask's
// executor (`cask::on_ui`), because the Term handler is not `Send`.
#[allow(dead_code)]
mod cask_update {
    use std::path::{Path, PathBuf};
    use std::rc::Rc;

    pub type Done = Rc<dyn Fn(String) -> ()>;

    fn trace() -> bool {
        std::env::var_os("CASK_TRACE").is_some()
    }

    fn embedded_version(resources: &str) -> String {
        std::fs::read_to_string(Path::new(resources).join("runtime-version"))
            .map(|text| text.trim().to_string())
            .unwrap_or_default()
    }

    // the platform name a manifest is published under, the publisher's own spelling
    fn platform() -> &'static str {
        std::env::consts::OS
    }

    fn updates(data: &str) -> PathBuf {
        Path::new(data).join("updates")
    }

    fn read(path: &Path) -> Option<String> {
        std::fs::read_to_string(path).ok().map(|text| text.trim().to_string())
    }

    fn bad(data: &str) -> Vec<String> {
        read(&updates(data).join("bad"))
            .unwrap_or_default()
            .split('\n')
            .filter(|line| !line.is_empty())
            .map(String::from)
            .collect()
    }

    fn mark_bad(data: &str, id: &str) {
        let mut lines = bad(data);
        lines.push(id.to_string());
        let _ = std::fs::write(updates(data).join("bad"), lines.join("\n"));
    }

    // the page directory to load: `<resources>/<page>` as shipped, or the newest downloaded update that matches this
    // binary and has not failed a launch. Records which update this launch runs, so a crash before `ready` is known
    // about at the next launch
    pub fn launch_path(resources: String, page: String, data: String) -> String {
        let embedded = Path::new(&resources).join(&page).to_string_lossy().to_string();
        let root = updates(&data);
        let _ = std::fs::create_dir_all(&root);
        let launching = root.join("launching");

        // the last launch never reached its first render: what it ran is bad, and it is no longer current
        if let Some(failed) = read(&launching).filter(|id| !id.is_empty()) {
            mark_bad(&data, &failed);
            if read(&root.join("current")).as_deref() == Some(failed.as_str()) {
                let _ = std::fs::remove_file(root.join("current"));
            }
            let _ = std::fs::remove_file(&launching);
        }

        let current = match read(&root.join("current")).filter(|id| !id.is_empty() && !bad(&data).contains(id)) {
            Some(id) => id,
            None => return embedded,
        };
        let directory = root.join(&current);

        if read(&directory.join(".runtime-version")).as_deref() != Some(embedded_version(&resources).as_str())
            || !directory.join("index.html").exists()
        {
            return embedded;
        }

        let _ = std::fs::write(&launching, &current);
        directory.to_string_lossy().to_string()
    }

    // the first render happened: whatever this launch ran is good
    pub fn ready(data: String) -> () {
        let _ = std::fs::remove_file(updates(&data).join("launching"));
    }

    // `sig=":<base64>:", keyid="root", alg="rsa-v1_5-sha256"`, the form the publisher writes
    fn signature(header: &str) -> Option<Vec<u8>> {
        use base64::Engine;
        let start = header.find("sig=\":")? + 6;
        let end = start + header[start..].find(":\"")?;
        base64::engine::general_purpose::STANDARD.decode(&header[start..end]).ok()
    }

    fn verified(resources: &str, manifest: &[u8], header: &str) -> bool {
        use rsa::pkcs1v15::{Signature, VerifyingKey};
        use rsa::pkcs8::DecodePublicKey;
        use rsa::signature::Verifier;

        let Ok(der) = std::fs::read(Path::new(resources).join("update-key.spki.der")) else {
            return false;
        };
        let Some(bytes) = signature(header) else {
            return false;
        };
        let Ok(key) = rsa::RsaPublicKey::from_public_key_der(&der) else {
            return false;
        };
        let Ok(signature) = Signature::try_from(bytes.as_slice()) else {
            return false;
        };

        VerifyingKey::<sha2::Sha256>::new(key).verify(manifest, &signature).is_ok()
    }

    // base64url sha256, the manifest's encoding
    fn hash(bytes: &[u8]) -> String {
        use base64::Engine;
        use sha2::Digest;
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sha2::Sha256::digest(bytes))
    }

    fn fetch(url: &str) -> Option<Vec<u8>> {
        if let Some(path) = url.strip_prefix("file://") {
            return std::fs::read(path).ok();
        }

        let response = reqwest::blocking::get(url).ok()?;

        if !response.status().is_success() {
            return None;
        }

        response.bytes().ok().map(|bytes| bytes.to_vec())
    }

    // fetch, check and stage the newest update off the UI thread, then call `done` ON THE UI THREAD with `none`,
    // `current`, `applied <id>` or `refused: <reason>`. Never touches the page that is running
    pub fn check(resources: String, data: String, base: String, channel: String, done: Done) -> () {
        let answer = std::sync::Arc::new(std::sync::Mutex::new(Answer { status: None, waker: None }));
        let worker = answer.clone();

        std::thread::spawn(move || {
            let status = apply(&resources, &data, &base, &channel);
            let mut slot = worker.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
            slot.status = Some(status);

            if let Some(waker) = slot.waker.take() {
                waker.wake();
            }
        });

        on_ui(async move {
            let status = Answered(answer).await;

            if trace() {
                eprintln!("cask update: {}", status);
            }

            done(status)
        });
    }

    // where `done` runs. Linux: glib's main context, the GTK UI thread's own executor. Windows: the cask's executor,
    // polled on a window message, so it needs the cask runtime, which every Windows app that opens a window has. Anywhere
    // else there is no UI thread: the future runs to completion on the calling thread, parked between polls, which is
    // how the client's logic is tested on a machine with no Rust toolkit (test/call/update-rust.ts)
    #[cfg(target_os = "linux")]
    fn on_ui(future: impl std::future::Future<Output = ()> + 'static) {
        gtk4::glib::MainContext::default().spawn_local(future);
    }

    #[cfg(windows)]
    fn on_ui(future: impl std::future::Future<Output = ()> + 'static) {
        super::cask::on_ui(future)
    }

    #[cfg(not(any(target_os = "linux", windows)))]
    fn on_ui(future: impl std::future::Future<Output = ()> + 'static) {
        use std::sync::Arc;
        use std::task::{Context, Wake, Waker};

        struct Unpark(std::thread::Thread);

        impl Wake for Unpark {
            fn wake(self: Arc<Self>) {
                self.0.unpark()
            }
        }

        let waker: Waker = Arc::new(Unpark(std::thread::current())).into();
        let mut context = Context::from_waker(&waker);
        let mut future = Box::pin(future);

        while future.as_mut().poll(&mut context).is_pending() {
            std::thread::park();
        }
    }

    // the worker's answer, and the waker of the UI-thread future waiting for it
    struct Answer {
        status: Option<String>,
        waker: Option<std::task::Waker>,
    }

    // ready once the worker has answered. Until then it leaves its waker, which the worker wakes from its own thread:
    // a `Waker` is `Send`, so this is how a result crosses back to the UI thread without polling
    struct Answered(std::sync::Arc<std::sync::Mutex<Answer>>);

    impl std::future::Future for Answered {
        type Output = String;

        fn poll(self: std::pin::Pin<&mut Self>, context: &mut std::task::Context<'_>) -> std::task::Poll<String> {
            let mut slot = self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

            match slot.status.take() {
                Some(status) => std::task::Poll::Ready(status),
                None => {
                    slot.waker = Some(context.waker().clone());
                    std::task::Poll::Pending
                }
            }
        }
    }

    fn apply(resources: &str, data: &str, base: &str, channel: &str) -> String {
        let version = embedded_version(resources);

        if version.is_empty() {
            return "refused: no runtime version in the app".to_string();
        }

        let root = if base.ends_with('/') { base.to_string() } else { format!("{}/", base) };
        let manifest_url = format!("{}{}/{}/{}.json", root, platform(), version, channel);
        let Some(manifest) = fetch(&manifest_url) else {
            return "none".to_string();
        };
        let header = fetch(&format!("{}.sig", manifest_url)).map(|bytes| String::from_utf8_lossy(&bytes).to_string());

        if !header.map(|header| verified(resources, &manifest, &header)).unwrap_or(false) {
            return "refused: the signature does not verify".to_string();
        }

        let Ok(json) = serde_json::from_slice::<serde_json::Value>(&manifest) else {
            return "refused: not a manifest".to_string();
        };
        let id = json["id"].as_str().unwrap_or_default().to_string();

        if id.is_empty() {
            return "refused: not a manifest".to_string();
        }

        if json["runtimeVersion"].as_str() != Some(version.as_str()) {
            return "refused: built for another runtime version".to_string();
        }

        let store = updates(data);

        if bad(data).contains(&id) {
            return format!("refused: {} failed a launch", id);
        }

        if read(&store.join("current")).as_deref() == Some(id.as_str()) {
            return "current".to_string();
        }

        // staged under a name no launch reads, swapped in only once every asset is there and checks
        let staging = store.join(format!(".staging-{}", id));
        let _ = std::fs::remove_dir_all(&staging);
        let mut assets = vec![json["launchAsset"].clone()];
        assets.extend(json["assets"].as_array().cloned().unwrap_or_default());

        for asset in assets {
            let key = asset["key"].as_str().unwrap_or_default();
            let path = asset["url"].as_str().unwrap_or_default();
            let want = asset["hash"].as_str().unwrap_or_default();

            if key.is_empty() || key.contains("..") || key.starts_with('/') {
                return "refused: an asset could not be fetched".to_string();
            }

            let Some(bytes) = fetch(&format!("{}{}", root, path)) else {
                return "refused: an asset could not be fetched".to_string();
            };

            if hash(&bytes) != want {
                return format!("refused: {} does not match its hash", key);
            }

            let target = staging.join(key);

            if let Some(parent) = target.parent() {
                let _ = std::fs::create_dir_all(parent);
            }

            if std::fs::write(&target, &bytes).is_err() {
                return "refused: the update could not be staged".to_string();
            }
        }

        let _ = std::fs::write(staging.join(".runtime-version"), &version);
        let last = store.join(&id);
        let _ = std::fs::remove_dir_all(&last);

        if std::fs::rename(&staging, &last).is_err() {
            return "refused: the update could not be moved into place".to_string();
        }

        let _ = std::fs::write(store.join("current"), &id);
        format!("applied {}", id)
    }
}
