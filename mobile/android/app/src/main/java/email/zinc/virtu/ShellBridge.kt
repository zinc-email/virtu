package email.zinc.virtu

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/**
 * The native half of bridge protocol v1 (client/src/shell.md): receives the
 * web app's messages over an origin-allowlisted WebMessageListener (never
 * `addJavascriptInterface` — plans/mobile.md, platform gotchas) and injects
 * the document-start shim that presents the uniform `window.virtuShell`.
 * Message parsing/serialization lives in [ShellProtocol]; this class is only
 * the Android glue.
 */
class ShellBridge(
  private val activity: Activity,
  private val apiKeyStore: ApiKeyStore,
  private val webOrigin: String,
) {
  private var webView: WebView? = null
  private var healingScript: ScriptHandler? = null

  /**
   * Returns false when the device's WebView predates the required features
   * (rare on minSdk 26+, but possible with a never-updated system WebView).
   * Nothing is injected then and the SPA behaves as a plain browser tab —
   * exactly the degradation shell.md promises.
   */
  fun attach(webView: WebView): Boolean {
    if (
      !WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) ||
      !WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    ) {
      return false
    }
    this.webView = webView

    WebViewCompat.addWebMessageListener(webView, PORT_NAME, setOf(webOrigin)) {
        _, message, _, isMainFrame, replyProxy ->
      val data = message.data
      if (data != null) handle(data, replyProxy, isMainFrame)
    }

    val shim = activity.assets.open("shell-bridge.js").bufferedReader().use { it.readText() }
      .replace("__SHELL_VERSION__", BuildConfig.VERSION_NAME)
    WebViewCompat.addDocumentStartJavaScript(webView, shim, setOf(webOrigin))

    refreshHealingScript()
    return true
  }

  private fun handle(envelopeJson: String, replyProxy: JavaScriptReplyProxy, isMainFrame: Boolean) {
    when (val inbound = ShellProtocol.parse(envelopeJson)) {
      is ShellProtocol.Inbound.Malformed -> {
        // A null id means the envelope itself was unreadable — no reply to
        // correlate, so drop it (only our own shim produces envelopes; the
        // seam's reply timeout covers the impossible case).
        val id = inbound.id ?: return
        replyProxy.postMessage(ShellProtocol.errorReply(id, inbound.error))
      }
      is ShellProtocol.Inbound.Request -> {
        // Only the main frame drives native behavior; a same-origin subframe
        // gets an error reply, never a silent drop — every dropped reply is a
        // web-side promise that hangs until the seam's timeout.
        val ok = isMainFrame && runCatching { execute(inbound.command) }.getOrDefault(false)
        replyProxy.postMessage(
          if (ok) ShellProtocol.okReply(inbound.id)
          else ShellProtocol.errorReply(inbound.id, "failed"),
        )
      }
    }
  }

  private fun execute(command: ShellProtocol.Command): Boolean = when (command) {
    is ShellProtocol.Command.StoreApiKey -> {
      apiKeyStore.store(command.key)
      refreshHealingScript()
      true
    }
    is ShellProtocol.Command.ClearApiKey -> {
      apiKeyStore.clear()
      refreshHealingScript()
      true
    }
    is ShellProtocol.Command.Share -> {
      val send = Intent(Intent.ACTION_SEND).setType("text/plain")
      command.title?.let { send.putExtra(Intent.EXTRA_SUBJECT, it) }
      send.putExtra(Intent.EXTRA_TEXT, listOfNotNull(command.text, command.url).joinToString("\n"))
      activity.startActivity(Intent.createChooser(send, null))
      // ok = "sheet presented"; the protocol deliberately does not report
      // whether the user completed the share (shell.md).
      true
    }
    is ShellProtocol.Command.OpenExternal -> try {
      activity.startActivity(
        Intent(Intent.ACTION_VIEW, Uri.parse(command.url)).addCategory(Intent.CATEGORY_BROWSABLE),
      )
      true
    } catch (e: ActivityNotFoundException) {
      false
    }
  }

  /**
   * The localStorage safety net (plans/mobile.md, Auth): if the WebView's
   * storage is ever evicted while Keystore still holds the key, re-seed it at
   * document start instead of forcing a re-login. Re-registered on every
   * store/clear so it always reflects the current key; takes effect on the
   * next (re)load, which is exactly when eviction would bite.
   */
  private fun refreshHealingScript() {
    val target = webView ?: return
    healingScript?.remove()
    healingScript = null
    val key = apiKeyStore.load() ?: return
    // JSONObject.quote emits a JSON string literal, which is also a valid JS
    // string literal — safe interpolation into the script.
    val script =
      """if (!localStorage.getItem("virtu.apiKey")) localStorage.setItem("virtu.apiKey", ${JSONObject.quote(key)});"""
    healingScript = WebViewCompat.addDocumentStartJavaScript(target, script, setOf(webOrigin))
  }

  private companion object {
    /** The raw port object the shim wraps; the web app never touches it. */
    const val PORT_NAME = "virtuShellPort"
  }
}
