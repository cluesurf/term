// The network for a Rust program (device-layer-0014), docked by ../network.tree as `<global:native-network>`. No crate:
// a UDP socket connected toward a public address, which sends nothing and fails when the machine has no route out, so
// it answers whether a route exists without a packet. The kind of link is not visible from std, so it is `other`.
mod native_network {
    use std::net::UdpSocket;

    // `<online|offline> <kind>`
    pub fn read() -> String {
        let routed = UdpSocket::bind("0.0.0.0:0")
            .and_then(|socket| socket.connect("192.0.2.1:9").map(|_| socket))
            .and_then(|socket| socket.local_addr())
            .map(|address| !address.ip().is_loopback() && !address.ip().is_unspecified())
            .unwrap_or(false);
        if routed { "online other".to_string() } else { "offline none".to_string() }
    }
}
