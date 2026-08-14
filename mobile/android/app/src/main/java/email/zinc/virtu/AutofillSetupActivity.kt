package email.zinc.virtu

import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.autofill.AutofillManager
import android.widget.Button
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

/**
 * The autofill onboarding screen (Track F): explains the feature, deep-links
 * to the system "set autofill service" dialog, and walks through Chrome's
 * extra toggle. Reached from the app's long-press "Set up autofill" shortcut
 * and as the service's settingsActivity (the gear in system settings); it is
 * also the attribution target for the inline chip.
 */
class AutofillSetupActivity : ComponentActivity() {
  private lateinit var status: TextView
  private lateinit var enable: Button

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    setContentView(R.layout.autofill_setup_activity)

    // Same native inset padding as MainActivity (edge-to-edge, targetSdk 36).
    val root = findViewById<View>(R.id.setupRoot)
    ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
      )
      view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
      insets
    }

    status = findViewById(R.id.autofillStatus)
    enable = findViewById(R.id.autofillEnable)
    enable.setOnClickListener {
      try {
        startActivity(
          Intent(Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE, Uri.parse("package:$packageName")),
        )
      } catch (e: ActivityNotFoundException) {
        // Some OEM builds hide the picker; the generic settings page is the
        // best remaining route.
        startActivity(Intent(Settings.ACTION_SETTINGS))
      }
    }
  }

  // The system picker returns here; re-read rather than track a result code.
  override fun onResume() {
    super.onResume()
    val enabled =
      getSystemService(AutofillManager::class.java)?.hasEnabledAutofillServices() == true
    status.text =
      getString(if (enabled) R.string.autofill_status_on else R.string.autofill_status_off)
    enable.visibility = if (enabled) View.GONE else View.VISIBLE
  }
}
