package email.zinc.virtu

import android.annotation.SuppressLint
import android.app.Dialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.core.splashscreen.SplashScreen.Companion.installSplashScreen
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * The shell: a WebView on the deployed SPA (BuildConfig.START_URL) plus the
 * few native behaviors a browser tab can't provide — the bridge (ShellBridge),
 * a native offline/error screen, edge-to-edge inset padding done natively so
 * the web app stays ignorant of insets, and link routing (external hosts to
 * the system browser; window.open/blob URLs to an in-app child WebView — see
 * shell.md, known gaps).
 */
class MainActivity : ComponentActivity() {
  private lateinit var webView: WebView
  private lateinit var errorScreen: View
  private var mainFrameFailed = false

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    installSplashScreen()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_main)

    // Edge-to-edge is mandatory at targetSdk 36, and WebView's
    // env(safe-area-inset-*) is unreliable — so the shell pads for system
    // bars/cutout/keyboard natively and the SPA never learns about insets
    // (plans/mobile.md, platform gotchas).
    val root = findViewById<View>(R.id.root)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars()
          or WindowInsetsCompat.Type.displayCutout()
          or WindowInsetsCompat.Type.ime(),
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }

    webView = findViewById(R.id.webView)
    errorScreen = findViewById(R.id.errorScreen)
    findViewById<Button>(R.id.retry).setOnClickListener {
      errorScreen.visibility = View.GONE
      webView.reload()
    }

    webView.settings.apply {
      javaScriptEnabled = true
      domStorageEnabled = true
      // window.open must work: the SPA's zone-file viewer opens a blob URL.
      // Deliberately gesture-gated (no javaScriptCanOpenWindowsAutomatically),
      // matching onCreateWindow's isUserGesture check: programmatic popups
      // stay impossible.
      setSupportMultipleWindows(true)
    }

    webView.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
        routeAwayFromApp(request.url)

      override fun onPageStarted(view: WebView, url: String, favicon: android.graphics.Bitmap?) {
        mainFrameFailed = false
      }

      override fun onReceivedError(
        view: WebView,
        request: WebResourceRequest,
        error: WebResourceError,
      ) {
        // Subresource failures are the web app's business; only a dead main
        // frame gets the native screen (the airplane-mode case). Filtered to
        // connectivity errors because superseded/aborted navigations can
        // surface here as ERROR_UNKNOWN on some WebView versions and would
        // flash the offline screen over a healthy app.
        if (request.isForMainFrame && error.errorCode in CONNECTIVITY_ERRORS) {
          mainFrameFailed = true
          errorScreen.visibility = View.VISIBLE
        }
      }

      override fun onPageFinished(view: WebView, url: String) {
        if (!mainFrameFailed) errorScreen.visibility = View.GONE
      }
    }

    webView.webChromeClient = object : WebChromeClient() {
      override fun onCreateWindow(
        view: WebView,
        isDialog: Boolean,
        isUserGesture: Boolean,
        resultMsg: Message,
      ): Boolean {
        if (!isUserGesture) return false
        openChildWindow(resultMsg)
        return true
      }
    }

    onBackPressedDispatcher.addCallback(this) {
      if (webView.canGoBack()) webView.goBack() else finish()
    }

    ShellBridge(this, ApiKeyStore(this), BuildConfig.WEB_ORIGIN).attach(webView)
    publishShareShortcut()

    // restoreState can come back empty (WebView updated between save and
    // restore, or state trimmed by the system) — without the fallback that's
    // a permanently blank screen on the cold path after process death.
    val restored = savedInstanceState?.let { webView.restoreState(it) }
    if (restored?.currentItem == null) {
      webView.loadUrl(BuildConfig.START_URL)
    }
  }

  override fun onSaveInstanceState(outState: Bundle) {
    super.onSaveInstanceState(outState)
    webView.saveState(outState)
  }

  /**
   * True (and diverts to the system) for any navigation leaving the app
   * origin. In-origin and blob: URLs load in place — blob content can't
   * cross the process boundary (shell.md, known gaps). Only web and
   * communication schemes may leave the app: the bridge's external.open
   * already enforces http/https, and this path must not be the looser one —
   * webview content must never be able to fire intent:/market:/arbitrary
   * deep-link schemes at other apps. Links inside email bodies don't reach
   * here at all: the web app sends those over the bridge as external.open.
   */
  private fun routeAwayFromApp(url: Uri): Boolean {
    if (url.scheme == "blob" || sameOrigin(url)) return false
    if (url.scheme?.lowercase() !in EXTERNAL_SCHEMES) return true // swallow
    return try {
      startActivity(Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE))
      true
    } catch (e: ActivityNotFoundException) {
      true // nothing can handle it; swallowing beats navigating the shell
    }
  }

  private fun sameOrigin(url: Uri): Boolean {
    val app = Uri.parse(BuildConfig.WEB_ORIGIN)
    // Normalize case and default ports so e.g. HTTPS://ZINC.EMAIL:443 stays
    // in-app instead of misrouting to the browser (fails closed either way).
    fun defaultedPort(u: Uri): Int = when {
      u.port != -1 -> u.port
      u.scheme.equals("http", ignoreCase = true) -> 80
      u.scheme.equals("https", ignoreCase = true) -> 443
      else -> -1
    }
    return url.host != null &&
      url.scheme.equals(app.scheme, ignoreCase = true) &&
      url.host.equals(app.host, ignoreCase = true) &&
      defaultedPort(url) == defaultedPort(app)
  }

  /**
   * Child window for window.open/target=_blank from the SPA: a minimal
   * full-screen dialog hosting a WebView attached through the standard
   * WebViewTransport handshake, which keeps it in the parent's browsing
   * context — that's what lets a blob: URL from the parent's JS resolve here.
   * External-host navigations divert to the system browser and close it.
   */
  private fun openChildWindow(resultMsg: Message) {
    val child = WebView(this)
    child.settings.javaScriptEnabled = true

    val dialog = Dialog(this, android.R.style.Theme_Material_NoActionBar)
    val container = FrameLayout(this)
    container.addView(
      child,
      FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
    )
    val close = Button(this)
    close.text = getString(R.string.child_window_close)
    close.setOnClickListener { dialog.dismiss() }
    val closeParams = FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.WRAP_CONTENT,
      ViewGroup.LayoutParams.WRAP_CONTENT,
      android.view.Gravity.TOP or android.view.Gravity.END,
    )
    container.addView(close, closeParams)
    ViewCompat.setOnApplyWindowInsetsListener(container) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars()
          or WindowInsetsCompat.Type.displayCutout()
          or WindowInsetsCompat.Type.ime(),
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }
    dialog.setContentView(container)
    dialog.setOnDismissListener { child.destroy() }

    child.webViewClient = object : WebViewClient() {
      override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
        val handled = routeAwayFromApp(request.url)
        if (handled) dialog.dismiss()
        return handled
      }
    }
    child.webChromeClient = object : WebChromeClient() {
      override fun onCloseWindow(window: WebView) {
        dialog.dismiss()
      }
    }

    dialog.show()

    // The API hands the transport as Message.obj: Any — the documented
    // contract is that it IS a WebViewTransport, so this cast is the one the
    // platform forces on every onCreateWindow implementation.
    val transport = resultMsg.obj as WebView.WebViewTransport
    transport.webView = child
    resultMsg.sendToTarget()
  }

  /**
   * The "New alias" direct-share row (Track E): a dynamic sharing shortcut
   * matched to res/xml/shortcuts.xml's share-target, so virtu ranks in the
   * share sheet's top row. Idempotent — pushing the same id updates in place.
   */
  private fun publishShareShortcut() {
    val shortcut = ShortcutInfoCompat.Builder(this, "new-alias")
      .setShortLabel(getString(R.string.share_shortcut_label))
      .setIcon(IconCompat.createWithResource(this, R.mipmap.ic_launcher))
      .setIntent(Intent(this, ShareActivity::class.java).setAction(Intent.ACTION_SEND))
      .setCategories(setOf("email.zinc.virtu.category.NEW_ALIAS"))
      .setLongLived(true)
      .build()
    ShortcutManagerCompat.pushDynamicShortcut(this, shortcut)
  }

  private companion object {
    /** Schemes allowed to leave the app from a plain link navigation. */
    val EXTERNAL_SCHEMES = setOf("http", "https", "mailto", "tel")

    /** Main-frame errors that mean "you're offline", not "load was aborted". */
    val CONNECTIVITY_ERRORS = setOf(
      WebViewClient.ERROR_HOST_LOOKUP,
      WebViewClient.ERROR_CONNECT,
      WebViewClient.ERROR_IO,
      WebViewClient.ERROR_TIMEOUT,
    )
  }
}
