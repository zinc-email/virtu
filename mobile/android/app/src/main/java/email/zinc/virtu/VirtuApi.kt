package email.zinc.virtu

import java.net.HttpURLConnection
import java.net.URI
import java.net.URLEncoder
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The tiny slice of the virtu API the native components call directly (the
 * same SimpleLogin-compatible endpoints the SPA uses, same `Authentication`
 * API-key header — plans/mobile.md, Auth). Blocking; call from a background
 * thread. Shapes verified against the running stack and the committed
 * `server/spec/openapi.json`.
 */
class VirtuApi(private val origin: String, private val apiKey: String) {
  private val json = Json { ignoreUnknownKeys = true }

  @Serializable
  data class Recommendation(val alias: String, val hostname: String)

  @Serializable
  data class AliasOptions(val can_create: Boolean, val recommendation: Recommendation? = null)

  @Serializable
  data class CreatedAlias(val alias: String)

  /** Non-2xx from the API; 401 means the stored key is no longer valid. */
  class ApiException(val status: Int, message: String) : Exception(message)

  /** GET /v5/alias/options — `recommendation` is the already-minted alias for this hostname, if any. */
  fun aliasOptions(hostname: String?): AliasOptions =
    json.decodeFromString(request("GET", "/api/v5/alias/options${hostnameQuery(hostname)}"))

  /** POST /alias/random/new — mint; `?hostname=` is recorded for future recommendations. */
  fun newRandomAlias(hostname: String?): CreatedAlias =
    json.decodeFromString(request("POST", "/api/alias/random/new${hostnameQuery(hostname)}", body = "{}"))

  private fun hostnameQuery(hostname: String?): String =
    if (hostname == null) "" else "?hostname=${URLEncoder.encode(hostname, "UTF-8")}"

  private fun request(method: String, path: String, body: String? = null): String {
    // openConnection() returns URLConnection; for an http(s) URL it is
    // documented to be an HttpURLConnection — the platform forces this cast.
    val connection = URI(origin + path).toURL().openConnection() as HttpURLConnection
    try {
      connection.requestMethod = method
      connection.connectTimeout = 10_000
      connection.readTimeout = 15_000
      connection.setRequestProperty("Authentication", apiKey)
      if (body != null) {
        connection.setRequestProperty("Content-Type", "application/json")
        connection.doOutput = true
        connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      }
      val status = connection.responseCode
      if (status !in 200..299) {
        val error = connection.errorStream?.bufferedReader()?.use { it.readText() } ?: ""
        throw ApiException(status, "$method $path -> $status $error")
      }
      return connection.inputStream.bufferedReader().use { it.readText() }
    } finally {
      connection.disconnect()
    }
  }
}
