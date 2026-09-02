// HTTP server runtime for the kotlin target, over Ktor's CIO engine -- the kotlin ecosystem's server, and
// coroutine-native, which is the same concurrency model the rest of this target uses.
//
// WHAT com.sun.net.httpserver DID NOT DO. The previous shim used the JDK's built-in server, which is genuinely
// built in and genuinely a toy: a thread per request, no HTTP/2, no coroutine integration (so every `suspend`
// handler had to be bridged by blocking a thread), and a TLS story that is an `HttpsConfigurator` nobody wants to
// write. It also passed an EMPTY header map to the handler, so no Term handler could read a header at all.
//
// Reached only through the public network/server API. See note/term/stdlib/native-async-file-and-server.md.
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.application.install
import io.ktor.server.cio.CIO
import io.ktor.server.cio.CIOApplicationEngine
import io.ktor.server.engine.EmbeddedServer
import io.ktor.server.engine.embeddedServer
import io.ktor.server.engine.connector
import io.ktor.server.engine.sslConnector
import io.ktor.server.request.receiveText
import io.ktor.server.request.uri
import io.ktor.server.response.header
import io.ktor.server.response.respondText
import io.ktor.server.routing.Routing
import io.ktor.server.routing.route
import io.ktor.server.routing.routing

object runtime {
  // a running server: the engine, so `stop` has something to stop, and the port it bound
  class Running(
    val engine: EmbeddedServer<CIOApplicationEngine, CIOApplicationEngine.Configuration>?,
    val port: Int,
  )

  // Run the server and block for the life of the process: the entry point of a server binary.
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

  // Bind the port and answer, without blocking.
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
  ): EmbeddedServer<CIOApplicationEngine, CIOApplicationEngine.Configuration> {
    val store = if (secure) keyStore(certificate, key) else null

    return embeddedServer(
      CIO,
      configure = {
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
        // ONE catch-all route. The Term API routes inside the handler (network/server/route, and the `dock`
        // routing DSL that lowers to a dispatcher), so Ktor's router is deliberately not used for dispatch: two
        // routers in one stack is how a request ends up matched twice and answered once.
        route("{...}") {
          handle {
            val body = call.receiveText()
            val headers = mutableMapOf<String, String>()

            for (name in call.request.headers.names()) {
              headers[name.lowercase()] = call.request.headers[name] ?: ""
            }

            val target = call.request.uri
            val split = target.indexOf('?')
            val answered =
              handler(
                Request(
                  call.request.local.method.value,
                  target,
                  if (split >= 0) target.substring(0, split) else target,
                  if (split >= 0) target.substring(split + 1) else "",
                  headers,
                  body,
                  0L,
                )
              )

            // appended, not set, so repeats survive: several set-cookie headers is the ordinary case and the
            // reason the Term response holds a LIST of headers rather than a map
            for (header in answered.headers) {
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

  // The Term API takes a certificate and a key as PEM text, which is what every other backend's TLS wants. The
  // JVM wants a KeyStore, so this is the conversion, on JDK classes only.
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
      // whichever algorithm the key actually is: RSA covers most certificates, EC the rest
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
      System.err.println("server tls: certificate or key did not parse")

      null
    }
  }
}
