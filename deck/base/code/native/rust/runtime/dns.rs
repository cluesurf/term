mod dns {
    use std::net::ToSocketAddrs;
    fn lookup(hostname: String) -> Vec<String> {
        format!("{}:0", hostname)
            .to_socket_addrs()
            .map(|iter| iter.map(|addr| addr.ip().to_string()).collect())
            .unwrap_or_default()
    }
    pub fn resolve(hostname: String) -> Vec<String> { lookup(hostname) }
    pub fn resolve_one(hostname: String) -> String { lookup(hostname).into_iter().next().unwrap_or_default() }
}
