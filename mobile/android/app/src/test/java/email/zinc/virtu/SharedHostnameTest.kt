package email.zinc.virtu

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SharedHostnameTest {
  @Test
  fun `plain page URL`() {
    assertEquals("news.ycombinator.com", SharedHostname.from("https://news.ycombinator.com/item?id=1"))
  }

  @Test
  fun `URL embedded in prose, with trailing punctuation`() {
    assertEquals(
      "x.test",
      SharedHostname.from("Check this out! https://x.test/page, it's great"),
    )
  }

  @Test
  fun `www is folded into the bare host`() {
    assertEquals("qmail.com", SharedHostname.from("http://WWW.QMAIL.COM/signup"))
  }

  @Test
  fun `bare domain text`() {
    assertEquals("sub.example.org", SharedHostname.from("  sub.example.org "))
  }

  @Test
  fun `prose without a URL yields nothing`() {
    assertNull(SharedHostname.from("my shopping list: eggs, milk"))
    assertNull(SharedHostname.from(null))
    assertNull(SharedHostname.from(""))
  }

  @Test
  fun `a single word is not a domain`() {
    assertNull(SharedHostname.from("hello"))
  }
}
