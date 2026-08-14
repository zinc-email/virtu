package email.zinc.virtu

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.TextView
import androidx.activity.ComponentActivity

/**
 * The share target (plans/mobile.md, Track E — the headline flow): share a
 * page from any browser, get an alias for that site, copy, done — without
 * launching the main app. Reuses the site's existing alias when the server
 * knows one (the options `recommendation`), else mints a random alias with
 * `?hostname=` recorded. Also the entry point for the "New alias" sharing
 * shortcut, which arrives with no shared text and just mints.
 *
 * Deliberately a dialog-themed mini-activity, not a screen: the whole flow
 * is show-copy-dismiss.
 */
class ShareActivity : ComponentActivity() {
  private lateinit var subtitle: TextView
  private lateinit var alias: TextView
  private lateinit var copy: Button
  private lateinit var done: Button
  private lateinit var openApp: Button

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.share_activity)
    subtitle = findViewById(R.id.subtitle)
    alias = findViewById(R.id.alias)
    copy = findViewById(R.id.copy)
    done = findViewById(R.id.done)
    openApp = findViewById(R.id.openApp)

    done.setOnClickListener { finish() }
    openApp.setOnClickListener {
      startActivity(Intent(this, MainActivity::class.java))
      finish()
    }

    val key = ApiKeyStore(this).load()
    if (key == null) {
      showLoggedOut()
      return
    }
    val hostname = SharedHostname.from(intent.getStringExtra(Intent.EXTRA_TEXT))
    mint(key, hostname)
  }

  private fun mint(key: String, hostname: String?) {
    subtitle.text = getString(R.string.share_minting)
    Thread {
      val outcome = runCatching {
        val api = VirtuApi(BuildConfig.WEB_ORIGIN, key)
        val options = api.aliasOptions(hostname)
        val existing = options.recommendation
        when {
          existing != null -> Minted(existing.alias, reused = true)
          !options.can_create -> throw AliasLimitReached()
          else -> Minted(api.newRandomAlias(hostname).alias, reused = false)
        }
      }
      runOnUiThread {
        if (isFinishing || isDestroyed) return@runOnUiThread
        outcome.fold(
          onSuccess = { showAlias(it, hostname) },
          onFailure = { showFailure(it) },
        )
      }
    }.start()
  }

  private data class Minted(val alias: String, val reused: Boolean)

  private class AliasLimitReached : Exception()

  private fun showAlias(minted: Minted, hostname: String?) {
    subtitle.text = when {
      minted.reused && hostname != null -> getString(R.string.share_reused, hostname)
      hostname != null -> getString(R.string.share_fresh, hostname)
      else -> getString(R.string.share_fresh_no_site)
    }
    alias.text = minted.alias
    alias.visibility = View.VISIBLE
    copy.visibility = View.VISIBLE
    copy.setOnClickListener {
      val clipboard = getSystemService(ClipboardManager::class.java)
      clipboard.setPrimaryClip(ClipData.newPlainText("virtu alias", minted.alias))
      // Android 13+ shows its own clip confirmation; the label change covers
      // older versions.
      copy.text = getString(R.string.share_copied)
    }
  }

  private fun showFailure(cause: Throwable) {
    subtitle.text = when {
      cause is AliasLimitReached -> getString(R.string.share_limit_reached)
      cause is VirtuApi.ApiException && cause.status == 401 -> {
        openApp.visibility = View.VISIBLE
        getString(R.string.share_logged_out)
      }
      else -> getString(R.string.share_failed)
    }
  }

  private fun showLoggedOut() {
    subtitle.text = getString(R.string.share_logged_out)
    openApp.visibility = View.VISIBLE
  }
}
