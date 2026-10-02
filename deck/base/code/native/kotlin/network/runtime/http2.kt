// HTTP/2 server runtime for the kotlin target, over Ktor's NETTY engine.
//
// A SECOND ENGINE, NOT A SETTING. Ktor's CIO engine, which answers network/server, has no HTTP/2 support at all.
// Netty's does, so h2 on this target means Netty, and that is why two engines sit on this classpath. It is the
// one place in this surface where the platform answer is a different dependency rather than a different call.
//
// TWO WAYS IN:
//
//   secure   TLS with ALPN advertising h2 (`enableHttp2`). The only way a browser speaks HTTP/2. Netty does the
//            negotiation through the JDK's own ALPN, so no tcnative and no native library to ship.
//   clear    h2c with prior knowledge (`enableH2c`). No ALPN, no upgrade dance.
//
// Reached only through the public network/http2 API. See note/term/stdlib/native-async-file-and-server.md.
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.connector
import io.ktor.server.engine.embeddedServer
import io.ktor.server.engine.sslConnector
import io.ktor.server.netty.Netty
import io.ktor.server.netty.NettyApplicationEngine
import io.ktor.server.request.receiveText
import io.ktor.server.request.uri
import io.ktor.server.response.header
import io.ktor.server.response.respondText
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import kotlinx.coroutines.withTimeoutOrNull

object http2 {
  class Running(
    val engine: EmbeddedServer<NettyApplicationEngine, NettyApplicationEngine.Configuration>?,
    val port: Int,
  )

  fun serve(
    port: Long,
    host: String,
    handler: (Request) -> Response,
    secure: Boolean,
    certificate: String,
    key: String,
  ) {
    build(port, host, handler, secure, certificate, key).start(wait = true)
  }

  suspend fun start(
    port: Long,
    host: String,
    handler: (Request) -> Response,
    secure: Boolean,
    certificate: String,
    key: String,
  ): Running {
    val engine = build(port, host, handler, secure, certificate, key)
    engine.start(wait = false)

    return Running(engine, port.toInt())
  }

  suspend fun stop(server: Running) {
    server.engine?.stop(1000L, 2000L)
  }

  private fun build(
    port: Long,
    host: String,
    handler: (Request) -> Response,
    secure: Boolean,
    certificate: String,
    key: String,
  ): EmbeddedServer<NettyApplicationEngine, NettyApplicationEngine.Configuration> {
    val store = if (secure) keyStore(certificate, key) else null
    val scheme = if (secure) "https" else "http"

    return embeddedServer(
      Netty,
      configure = {
        // h2 over TLS, and h2c without it. Both are Netty settings; neither exists on CIO.
        enableHttp2 = true
        enableH2c = !secure

        if (store != null) {
          sslConnector(
            keyStore = store,
            keyAlias = "term",
            keyStorePassword = { PASSWORD.toCharArray() },
            privateKeyPassword = { PASSWORD.toCharArray() },
          ) {
            this.port = port.toInt()
            this.host = host
          }
        } else {
          connector {
            this.port = port.toInt()
            this.host = host
          }
        }
      },
    ) {
      routing {
        // ONE catch-all route: the Term API routes inside the handler, so Ktor's router is not used for dispatch
        route("{...}") {
          handle {
            // DO NOT ask for a body that was never announced. `call.receiveText()` HANGS on Ktor's Netty engine
            // over h2c when the request has no body: curl sends the headers with END_STREAM, the server never
            // completes the body channel, and the request times out with the connection still open. The same
            // handler over HTTP/1.1 answers instantly, which is what makes it look like an h2 problem rather
            // than a body-reading one.
            //
            // So the content-length decides. Absent, it is read under a bounded wait rather than forever, so a
            // streaming upload still works and a body-less GET still answers.
            val declared = call.request.headers["content-length"]?.toLongOrNull()
            val body =
              when {
                declared == 0L -> ""
                declared != null -> call.receiveText()
                else -> withTimeoutOrNull(500L) { call.receiveText() } ?: ""
              }
            val headers = mutableMapOf<String, String>()

            for (name in call.request.headers.names()) {
              headers[name.lowercase()] = call.request.headers[name] ?: ""
            }

            val target = call.request.uri
            val split = target.indexOf('?')
            val path = if (split >= 0) target.substring(0, split) else target

            // the pseudo-headers, in the SAME map the HTTP/1.1 server fills, which is what lets one handler
            // serve both and what network/http2/shared/request.tree reads
            headers[":method"] = call.request.local.method.value
            headers[":scheme"] = scheme
            headers[":authority"] = headers["host"] ?: ""
            headers[":path"] = path
            // Ktor does not surface the h2 stream id to a route, so it is reported as 0 rather than invented
            headers["x-term-stream"] = "0"

            val answered =
              handler(
                Request(
                  call.request.local.method.value,
                  target,
                  path,
                  if (split >= 0) target.substring(split + 1) else "",
                  headers,
                  body,
                  0L,
                )
              )

            for (header in answered.headers) {
              // RFC 9113 forbids the connection-specific fields; a response carrying one is malformed
              if (isConnectionHeader(header.name)) continue

              call.response.header(header.name, header.value)
            }

            call.respondText(
              answered.body,
              status = HttpStatusCode.fromValue(answered.status.toInt()),
            )
          }
        }
      }
    }
  }

  private fun isConnectionHeader(name: String): Boolean =
    when (name.lowercase()) {
      "connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade" -> true
      else -> false
    }

  // The Term API takes a certificate and a key as PEM text, which is what every other backend's TLS wants. The
  // JVM wants a KeyStore, so this is the conversion, on JDK classes only. Same as network/runtime/server.kt.
  private const val PASSWORD = "term"

  private fun keyStore(certificate: String, key: String): java.security.KeyStore? {
    return try {
      val chain =
        java.security.cert.CertificateFactory.getInstance("X.509")
          .generateCertificates(
            java.io.ByteArrayInputStream(certificate.toByteArray(Charsets.UTF_8))
          )
          .toTypedArray()
      val body =
        key
          .replace("-----BEGIN PRIVATE KEY-----", "")
          .replace("-----END PRIVATE KEY-----", "")
          .replace("-----BEGIN RSA PRIVATE KEY-----", "")
          .replace("-----END RSA PRIVATE KEY-----", "")
          .replace("-----BEGIN EC PRIVATE KEY-----", "")
          .replace("-----END EC PRIVATE KEY-----", "")
          .replace(Regex("\\s"), "")
      val raw = java.util.Base64.getDecoder().decode(body)
      val spec = java.security.spec.PKCS8EncodedKeySpec(raw)
      val private =
        try {
          java.security.KeyFactory.getInstance("RSA").generatePrivate(spec)
        } catch (error: Exception) {
          java.security.KeyFactory.getInstance("EC").generatePrivate(spec)
        }
      val store = java.security.KeyStore.getInstance("PKCS12")
      store.load(null, PASSWORD.toCharArray())
      store.setKeyEntry("term", private, PASSWORD.toCharArray(), chain)

      store
    } catch (error: Exception) {
      System.err.println("http2 tls: certificate or key did not parse")

      null
    }
  }
}
