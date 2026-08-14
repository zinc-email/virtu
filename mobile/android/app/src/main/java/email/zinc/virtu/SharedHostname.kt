package email.zinc.virtu

import java.net.URI

/**
 * Best-effort hostname from a share-sheet payload (pure JVM — unit-tested).
 * Browsers share the page URL in EXTRA_TEXT, sometimes with surrounding prose
 * ("Check this out! https://x.test/page"); some apps share a bare domain.
 * The result feeds `?hostname=` on the alias endpoints, which drives the
 * server's per-site recommendation (alias_used_on).
 */
object SharedHostname {
  private val URL_PATTERN = Regex("""https?://\S+""", RegexOption.IGNORE_CASE)
  private val BARE_DOMAIN = Regex("""[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+""", RegexOption.IGNORE_CASE)

  fun from(sharedText: String?): String? {
    if (sharedText == null) return null
    val url = URL_PATTERN.find(sharedText)?.value?.trimEnd('.', ',', ';', ')', ']', '}', '>', '"', '\'')
    if (url != null) {
      val host = runCatching { URI(url).host }.getOrNull()
      if (host != null) return normalize(host)
    }
    // No URL: a share of a bare domain ("qmail.com") still counts; prose
    // does not — better no hostname than a wrong one recorded server-side.
    val trimmed = sharedText.trim()
    if (BARE_DOMAIN.matches(trimmed)) return normalize(trimmed)
    return null
  }

  // "www." adds nothing for alias bookkeeping and would split the
  // recommendation history between www and bare shares of the same site.
  // Also used directly by the autofill service on a browser's webDomain.
  fun normalize(host: String): String =
    host.lowercase().removePrefix("www.")
}
