package email.zinc.virtu

import email.zinc.virtu.ShellProtocol.Command
import email.zinc.virtu.ShellProtocol.Inbound
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * Protocol v1 conformance against client/src/shell.md — mirrors the shapes
 * the web-side dom tests exercise with their fake shell.
 */
class ShellProtocolTest {
  private fun envelope(id: Long, message: String): String {
    // Build with the serializer so `message` is correctly escaped as a JSON
    // string field, the same way the shim's JSON.stringify does it.
    return kotlinx.serialization.json.buildJsonObject {
      put("id", kotlinx.serialization.json.JsonPrimitive(id))
      put("message", kotlinx.serialization.json.JsonPrimitive(message))
    }.toString()
  }

  @Test
  fun `apiKey_store carries the key`() {
    val inbound = ShellProtocol.parse(envelope(1, """{"type":"apiKey.store","key":"sk-123"}"""))
    assertEquals(Inbound.Request(1, Command.StoreApiKey("sk-123")), inbound)
  }

  @Test
  fun `apiKey_store without a key is bad-payload`() {
    val inbound = ShellProtocol.parse(envelope(2, """{"type":"apiKey.store"}"""))
    assertEquals(Inbound.Malformed(2, "bad-payload"), inbound)
  }

  @Test
  fun `apiKey_store with an empty key is bad-payload`() {
    val inbound = ShellProtocol.parse(envelope(3, """{"type":"apiKey.store","key":""}"""))
    assertEquals(Inbound.Malformed(3, "bad-payload"), inbound)
  }

  @Test
  fun `apiKey_clear has no fields`() {
    val inbound = ShellProtocol.parse(envelope(4, """{"type":"apiKey.clear"}"""))
    assertEquals(Inbound.Request(4, Command.ClearApiKey), inbound)
  }

  @Test
  fun `share needs at least one of text or url`() {
    assertEquals(
      Inbound.Request(5, Command.Share(title = null, text = null, url = "https://x.test/")),
      ShellProtocol.parse(envelope(5, """{"type":"share","url":"https://x.test/"}""")),
    )
    assertEquals(
      Inbound.Request(6, Command.Share(title = "t", text = "body", url = null)),
      ShellProtocol.parse(envelope(6, """{"type":"share","title":"t","text":"body"}""")),
    )
    assertEquals(
      Inbound.Malformed(7, "bad-payload"),
      ShellProtocol.parse(envelope(7, """{"type":"share","title":"only a title"}""")),
    )
  }

  @Test
  fun `external_open takes http and https only`() {
    assertEquals(
      Inbound.Request(8, Command.OpenExternal("https://docs.example/page")),
      ShellProtocol.parse(envelope(8, """{"type":"external.open","url":"https://docs.example/page"}""")),
    )
    assertEquals(
      Inbound.Malformed(9, "bad-payload"),
      ShellProtocol.parse(envelope(9, """{"type":"external.open","url":"javascript:alert(1)"}""")),
    )
    assertEquals(
      Inbound.Malformed(10, "bad-payload"),
      ShellProtocol.parse(envelope(10, """{"type":"external.open"}""")),
    )
  }

  @Test
  fun `unknown type gets the unknown-message slug with the request id`() {
    // Forward compatibility: a newer web app talking to this older shell
    // must get unknown-message back, never a crash or a dropped reply.
    val inbound = ShellProtocol.parse(envelope(11, """{"type":"push.register"}"""))
    assertEquals(Inbound.Malformed(11, "unknown-message"), inbound)
  }

  @Test
  fun `unreadable envelope has no id to reply to`() {
    assertEquals(Inbound.Malformed(null, "bad-payload"), ShellProtocol.parse("not json"))
    assertEquals(Inbound.Malformed(null, "bad-payload"), ShellProtocol.parse("""{"message":"{}"}"""))
    assertEquals(Inbound.Malformed(null, "bad-payload"), ShellProtocol.parse("""[1,2,3]"""))
  }

  @Test
  fun `message must be a JSON-encoded string, not an inline object`() {
    val inbound = ShellProtocol.parse("""{"id":12,"message":{"type":"apiKey.clear"}}""")
    assertEquals(Inbound.Malformed(12, "bad-payload"), inbound)
  }

  @Test
  fun `message that is not valid JSON is bad-payload`() {
    val inbound = ShellProtocol.parse(envelope(13, "garbage"))
    assertEquals(Inbound.Malformed(13, "bad-payload"), inbound)
  }

  @Test
  fun `replies are an envelope whose reply field is a JSON string`() {
    val ok = Json.parseToJsonElement(ShellProtocol.okReply(21)).jsonObject
    assertEquals(21L, ok["id"]!!.jsonPrimitive.long)
    val okReply = Json.parseToJsonElement(ok["reply"]!!.jsonPrimitive.content).jsonObject
    assertEquals(true, okReply["ok"]!!.jsonPrimitive.boolean)
    assertNull(okReply["error"])

    val err = Json.parseToJsonElement(ShellProtocol.errorReply(22, "failed")).jsonObject
    assertEquals(22L, err["id"]!!.jsonPrimitive.long)
    val errReply = Json.parseToJsonElement(err["reply"]!!.jsonPrimitive.content).jsonObject
    assertEquals(false, errReply["ok"]!!.jsonPrimitive.boolean)
    assertEquals("failed", errReply["error"]!!.jsonPrimitive.content)
  }

  @Test
  fun `extra fields are tolerated`() {
    // A newer web app may add optional fields; protocol v1 shells must not
    // reject on their presence.
    val inbound = ShellProtocol.parse(envelope(23, """{"type":"apiKey.clear","reason":"logout"}"""))
    assertEquals(Inbound.Request(23, Command.ClearApiKey), inbound)
  }
}
