package email.zinc.virtu

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put

/**
 * Bridge protocol v1, pure message layer — no Android types, so this runs as
 * a plain JVM unit test. The contract is `client/src/shell.md` in this repo;
 * a change to either side is a change to both, in the same review.
 *
 * Wire shape (Android-specific plumbing the web app never sees): the
 * document-start shim (assets/shell-bridge.js) correlates requests to replies
 * by id, so what crosses the WebMessageListener port is an envelope
 * `{id, message}` in and `{id, reply}` out, where `message`/`reply` are the
 * JSON strings the shell.md contract defines.
 */
object ShellProtocol {
  const val VERSION = 1

  sealed interface Command {
    data class StoreApiKey(val key: String) : Command
    data object ClearApiKey : Command
    data class Share(val title: String?, val text: String?, val url: String?) : Command
    data class OpenExternal(val url: String) : Command
  }

  sealed interface Inbound {
    data class Request(val id: Long, val command: Command) : Inbound

    /**
     * Unusable input. `error` is the shell.md slug (`bad-payload` /
     * `unknown-message`); a null [id] means the envelope itself was unreadable
     * and no reply can be correlated — the bridge drops it, and the web seam's
     * reply timeout turns the hung promise into "capability unavailable".
     */
    data class Malformed(val id: Long?, val error: String) : Inbound
  }

  private val json = Json { ignoreUnknownKeys = true }

  fun parse(envelopeJson: String): Inbound {
    val envelope = parseObject(envelopeJson) ?: return Inbound.Malformed(null, "bad-payload")
    val id = (envelope["id"] as? JsonPrimitive)?.longOrNull ?: return Inbound.Malformed(null, "bad-payload")
    val messageJson = envelope.stringField("message") ?: return Inbound.Malformed(id, "bad-payload")
    val message = parseObject(messageJson) ?: return Inbound.Malformed(id, "bad-payload")

    return when (message.stringField("type")) {
      "apiKey.store" -> {
        val key = message.stringField("key")?.takeIf { it.isNotEmpty() }
          ?: return Inbound.Malformed(id, "bad-payload")
        Inbound.Request(id, Command.StoreApiKey(key))
      }
      "apiKey.clear" -> Inbound.Request(id, Command.ClearApiKey)
      "share" -> {
        val title = message.stringField("title")
        val text = message.stringField("text")
        val url = message.stringField("url")
        if (text == null && url == null) return Inbound.Malformed(id, "bad-payload")
        Inbound.Request(id, Command.Share(title, text, url))
      }
      "external.open" -> {
        val url = message.stringField("url")
        if (url == null || !(url.startsWith("https://") || url.startsWith("http://"))) {
          return Inbound.Malformed(id, "bad-payload")
        }
        Inbound.Request(id, Command.OpenExternal(url))
      }
      null -> Inbound.Malformed(id, "bad-payload")
      else -> Inbound.Malformed(id, "unknown-message")
    }
  }

  fun okReply(id: Long): String = replyEnvelope(id, buildJsonObject { put("ok", true) })

  fun errorReply(id: Long, error: String): String =
    replyEnvelope(id, buildJsonObject {
      put("ok", false)
      put("error", error)
    })

  private fun replyEnvelope(id: Long, reply: JsonObject): String =
    buildJsonObject {
      put("id", id)
      put("reply", reply.toString())
    }.toString()

  private fun parseObject(raw: String): JsonObject? =
    runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull()

  private fun JsonObject.stringField(name: String): String? =
    (this[name] as? JsonPrimitive)?.takeIf { it.isString }?.content
}
