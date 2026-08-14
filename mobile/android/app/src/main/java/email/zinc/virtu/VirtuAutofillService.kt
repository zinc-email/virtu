package email.zinc.virtu

import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.content.Intent
import android.os.Build
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.Dataset
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.InlinePresentation
import android.service.autofill.SaveCallback
import android.service.autofill.SaveRequest
import android.view.View
import android.view.autofill.AutofillId
import android.widget.RemoteViews
import androidx.annotation.RequiresApi
import androidx.autofill.inline.UiVersions
import androidx.autofill.inline.v1.InlineSuggestionUi

/**
 * Track F (plans/mobile.md): the inline "virtu alias" chip in other apps'
 * email fields. The fill response never touches the network — it offers a
 * single dataset whose value is produced by dataset authentication: tapping
 * the chip launches [AutofillMintActivity], which reuses the site's existing
 * alias or mints one (the same options→mint flow as the share target) and
 * hands the framework the filled dataset.
 *
 * Site context comes from the browser's webDomain when present (Chrome's
 * third-party autofill passes it on Android 14+); native-app fills mint
 * without a hostname — better none than a wrong one recorded server-side.
 */
class VirtuAutofillService : AutofillService() {

  override fun onFillRequest(
    request: FillRequest,
    cancellationSignal: CancellationSignal,
    callback: FillCallback,
  ) {
    // Logged out: stay silent rather than advertise a chip that can't fill.
    if (ApiKeyStore(this).load() == null) {
      callback.onSuccess(null)
      return
    }

    val structure = request.fillContexts.last().structure
    val fields = parse(structure)
    if (fields.emailIds.isEmpty()) {
      callback.onSuccess(null)
      return
    }

    val label =
      if (fields.hostname != null) getString(R.string.autofill_fill_site, fields.hostname)
      else getString(R.string.autofill_fill)
    callback.onSuccess(
      FillResponse.Builder()
        .addDataset(authenticatedDataset(fields, label, inlinePresentation(request, label)))
        .build(),
    )
  }

  // We never set SaveInfo (there is nothing to save — aliases live server-side),
  // so this shouldn't be called; acknowledge if it somehow is.
  override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
    callback.onSuccess()
  }

  private data class EmailFields(val emailIds: List<AutofillId>, val hostname: String?)

  private fun parse(structure: AssistStructure): EmailFields {
    val ids = mutableListOf<AutofillId>()
    var domain: String? = null

    fun walk(node: AssistStructure.ViewNode) {
      if (domain == null) node.webDomain?.takeIf { it.isNotEmpty() }?.let { domain = it }
      val id = node.autofillId
      if (id != null && node.autofillType == View.AUTOFILL_TYPE_TEXT && EmailField.matches(node.emailTraits())) {
        ids += id
      }
      for (i in 0 until node.childCount) walk(node.getChildAt(i))
    }

    for (i in 0 until structure.windowNodeCount) walk(structure.getWindowNodeAt(i).rootViewNode)
    return EmailFields(ids, domain?.let(SharedHostname::normalize))
  }

  private fun AssistStructure.ViewNode.emailTraits() = EmailField.Traits(
    autofillHints = autofillHints?.toList() ?: emptyList(),
    inputType = inputType,
    idEntry = idEntry,
    hint = hint,
    htmlInputType = htmlInfo?.attributes
      ?.firstOrNull { it.first.equals("type", ignoreCase = true) }?.second,
  )

  // Pre-API-33 presentation APIs, deliberately: they work on every supported
  // level (minSdk 26), where the Presentations replacement is 33-only.
  @Suppress("DEPRECATION")
  private fun authenticatedDataset(
    fields: EmailFields,
    label: String,
    inline: InlinePresentation?,
  ): Dataset {
    val presentation = RemoteViews(packageName, R.layout.autofill_chip).apply {
      setTextViewText(R.id.autofillChipText, label)
    }
    val mintIntent = Intent(this, AutofillMintActivity::class.java).apply {
      putParcelableArrayListExtra(AutofillMintActivity.EXTRA_EMAIL_IDS, ArrayList(fields.emailIds))
      putExtra(AutofillMintActivity.EXTRA_HOSTNAME, fields.hostname)
    }
    // MUTABLE (the framework merges its fill-in intent into this one; the
    // flag itself is API 31+, older platforms are mutable by default) +
    // UPDATE_CURRENT (successive fill requests refresh the ids/hostname).
    val mutable = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
    val sender = PendingIntent.getActivity(
      this,
      0,
      mintIntent,
      mutable or PendingIntent.FLAG_UPDATE_CURRENT,
    ).intentSender

    return Dataset.Builder(presentation)
      .apply {
        fields.emailIds.forEach { id ->
          // Value null: dataset authentication supplies it on tap.
          if (inline != null && Build.VERSION.SDK_INT >= 30) {
            setValue(id, null, presentation, inline)
          } else {
            setValue(id, null, presentation)
          }
        }
      }
      .setAuthentication(sender)
      .build()
  }

  /** The chip above the keyboard, for IMEs that support inline suggestions (API 30+). */
  private fun inlinePresentation(request: FillRequest, label: String): InlinePresentation? {
    if (Build.VERSION.SDK_INT < 30) return null
    return inlinePresentation30(request, label)
  }

  @RequiresApi(30)
  private fun inlinePresentation30(request: FillRequest, label: String): InlinePresentation? {
    val spec = request.inlineSuggestionsRequest?.inlinePresentationSpecs?.firstOrNull() ?: return null
    if (!UiVersions.getVersions(spec.style).contains(UiVersions.INLINE_UI_VERSION_1)) return null
    // Long-pressing the chip shows this attribution: our setup screen.
    val attribution = PendingIntent.getActivity(
      this,
      0,
      Intent(this, AutofillSetupActivity::class.java),
      PendingIntent.FLAG_IMMUTABLE,
    )
    val content = InlineSuggestionUi.newContentBuilder(attribution).setTitle(label).build()
    return InlinePresentation(content.slice, spec, false)
  }
}
