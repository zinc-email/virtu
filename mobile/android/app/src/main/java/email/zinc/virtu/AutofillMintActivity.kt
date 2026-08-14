package email.zinc.virtu

import android.content.Intent
import android.os.Bundle
import android.service.autofill.Dataset
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.view.autofill.AutofillValue
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.core.content.IntentCompat

/**
 * The dataset-authentication half of the autofill flow (Track F): launched
 * when the user taps the "virtu alias" chip. Translucent — the fill UI stays
 * on screen underneath while we do the one network round trip: reuse the
 * site's existing alias if the server recommends one, else mint a random
 * alias with `?hostname=` recorded (the exact flow the share target uses).
 * The result is a filled Dataset handed back via EXTRA_AUTHENTICATION_RESULT;
 * the framework fills the field(s) and the session ends.
 */
class AutofillMintActivity : ComponentActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)

    val emailIds =
      IntentCompat.getParcelableArrayListExtra(intent, EXTRA_EMAIL_IDS, AutofillId::class.java)
    val hostname = intent.getStringExtra(EXTRA_HOSTNAME)
    val key = ApiKeyStore(this).load()
    if (emailIds.isNullOrEmpty() || key == null) {
      // Key revoked between the fill request and the tap, or a malformed
      // launch: nothing to fill.
      if (key == null) toast(R.string.share_logged_out)
      finishCanceled()
      return
    }

    Thread {
      val outcome = runCatching {
        val api = VirtuApi(BuildConfig.WEB_ORIGIN, key)
        val options = api.aliasOptions(hostname)
        val existing = options.recommendation
        when {
          existing != null -> existing.alias
          !options.can_create -> throw AliasLimitReached()
          else -> api.newRandomAlias(hostname).alias
        }
      }
      runOnUiThread {
        if (isFinishing || isDestroyed) return@runOnUiThread
        outcome.fold(
          onSuccess = { alias -> finishFilled(emailIds, alias) },
          onFailure = { cause ->
            toast(
              when {
                cause is AliasLimitReached -> R.string.share_limit_reached
                cause is VirtuApi.ApiException && cause.status == 401 -> R.string.share_logged_out
                else -> R.string.share_failed
              },
            )
            finishCanceled()
          },
        )
      }
    }.start()
  }

  // Same pre-API-33 Dataset APIs as the service, same reason: they work on
  // every supported level.
  @Suppress("DEPRECATION")
  private fun finishFilled(emailIds: List<AutofillId>, alias: String) {
    // A result dataset carries real values and needs no presentation.
    val dataset = Dataset.Builder()
      .apply { emailIds.forEach { setValue(it, AutofillValue.forText(alias)) } }
      .build()
    setResult(RESULT_OK, Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset))
    finish()
  }

  private fun finishCanceled() {
    setResult(RESULT_CANCELED)
    finish()
  }

  private fun toast(message: Int) {
    Toast.makeText(this, message, Toast.LENGTH_LONG).show()
  }

  private class AliasLimitReached : Exception()

  companion object {
    const val EXTRA_EMAIL_IDS = "email.zinc.virtu.autofill.EMAIL_IDS"
    const val EXTRA_HOSTNAME = "email.zinc.virtu.autofill.HOSTNAME"
  }
}
