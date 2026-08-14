package email.zinc.virtu

/**
 * Is this form field asking for an email address? (pure JVM — unit-tested).
 * The autofill service walks the AssistStructure and asks this of every text
 * node; only email fields get the "virtu alias" chip. Deliberately layered
 * from strongest signal to weakest: explicit autofill/autocomplete hints, then
 * the platform input type, then the HTML input type, then name matching —
 * with password fields excluded up front so a "login" dataset never lands in
 * a password box.
 *
 * The traits are plain values copied out of ViewNode so this logic never
 * touches the Android framework (same pattern as [SharedHostname]).
 */
object EmailField {
  data class Traits(
    /** ViewNode.autofillHints — native `android:autofillHints` or, in browsers, the W3C `autocomplete` attribute. */
    val autofillHints: List<String> = emptyList(),
    /** ViewNode.inputType — android.text.InputType bits; 0 for most web nodes. */
    val inputType: Int = 0,
    /** ViewNode.idEntry — the view's resource-id name. */
    val idEntry: String? = null,
    /** ViewNode.hint — the field's placeholder/label text. */
    val hint: String? = null,
    /** The `type` attribute from ViewNode.htmlInfo, for web form nodes. */
    val htmlInputType: String? = null,
  )

  fun matches(field: Traits): Boolean {
    val hints = field.autofillHints.map { it.lowercase() }
    if (hints.any { it in PASSWORD_HINTS }) return false
    if (isPasswordInput(field.inputType)) return false
    if (field.htmlInputType?.lowercase() == "password") return false

    if (hints.any { it in EMAIL_HINTS }) return true
    if (field.htmlInputType?.lowercase() == "email") return true
    if (isEmailInput(field.inputType)) return true

    // Name fallback: only for plain text fields (or web nodes, which report
    // inputType 0) — a phone/number field named "email" is not an email field.
    val textClass = field.inputType and TYPE_MASK_CLASS
    if (textClass != 0 && textClass != TYPE_CLASS_TEXT) return false
    return listOfNotNull(field.idEntry, field.hint).any { EMAIL_NAME.containsMatchIn(it) }
  }

  private fun isEmailInput(inputType: Int): Boolean {
    if (inputType and TYPE_MASK_CLASS != TYPE_CLASS_TEXT) return false
    val variation = inputType and TYPE_MASK_VARIATION
    return variation == TYPE_TEXT_VARIATION_EMAIL_ADDRESS ||
      variation == TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS
  }

  private fun isPasswordInput(inputType: Int): Boolean {
    if (inputType and TYPE_MASK_CLASS != TYPE_CLASS_TEXT) return false
    val variation = inputType and TYPE_MASK_VARIATION
    return variation in PASSWORD_VARIATIONS
  }

  // View.AUTOFILL_HINT_EMAIL_ADDRESS is "emailAddress"; browsers surface the
  // autocomplete attribute value ("email") directly.
  private val EMAIL_HINTS = setOf("emailaddress", "email")
  private val PASSWORD_HINTS = setOf("password", "current-password", "new-password")

  // Matches "email", "e-mail", "e_mail" inside resource ids and hint text.
  private val EMAIL_NAME = Regex("""e[-_]?mail""", RegexOption.IGNORE_CASE)

  // android.text.InputType values, copied so this object stays framework-free
  // (the values are stable public API).
  private const val TYPE_MASK_CLASS = 0x0000000f
  private const val TYPE_MASK_VARIATION = 0x00000ff0
  private const val TYPE_CLASS_TEXT = 0x00000001
  private const val TYPE_TEXT_VARIATION_EMAIL_ADDRESS = 0x00000020
  private const val TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS = 0x000000d0
  private val PASSWORD_VARIATIONS = setOf(
    0x00000080, // TYPE_TEXT_VARIATION_PASSWORD
    0x00000090, // TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
    0x000000e0, // TYPE_TEXT_VARIATION_WEB_PASSWORD
  )
}
