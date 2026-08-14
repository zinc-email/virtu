package email.zinc.virtu

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class EmailFieldTest {
  // InputType values as in EmailField's comments.
  private val text = 0x00000001
  private val emailAddress = text or 0x00000020
  private val webEmailAddress = text or 0x000000d0
  private val password = text or 0x00000080
  private val webPassword = text or 0x000000e0
  private val phone = 0x00000003

  @Test
  fun `native autofill hint`() {
    assertTrue(EmailField.matches(EmailField.Traits(autofillHints = listOf("emailAddress"))))
  }

  @Test
  fun `web autocomplete hint`() {
    assertTrue(EmailField.matches(EmailField.Traits(autofillHints = listOf("email"))))
  }

  @Test
  fun `email input type, native and web variations`() {
    assertTrue(EmailField.matches(EmailField.Traits(inputType = emailAddress)))
    assertTrue(EmailField.matches(EmailField.Traits(inputType = webEmailAddress)))
  }

  @Test
  fun `html input type email`() {
    assertTrue(EmailField.matches(EmailField.Traits(htmlInputType = "email")))
    assertTrue(EmailField.matches(EmailField.Traits(htmlInputType = "EMAIL")))
  }

  @Test
  fun `name fallback on resource id and hint text`() {
    assertTrue(EmailField.matches(EmailField.Traits(idEntry = "user_email", inputType = text)))
    assertTrue(EmailField.matches(EmailField.Traits(hint = "E-mail address")))
    assertTrue(EmailField.matches(EmailField.Traits(idEntry = "signupEmailField", inputType = 0)))
  }

  @Test
  fun `password fields never match, whatever else says email`() {
    assertFalse(EmailField.matches(EmailField.Traits(autofillHints = listOf("password"), idEntry = "email")))
    assertFalse(EmailField.matches(EmailField.Traits(autofillHints = listOf("new-password"), hint = "email")))
    assertFalse(EmailField.matches(EmailField.Traits(inputType = password, idEntry = "email_password")))
    assertFalse(EmailField.matches(EmailField.Traits(inputType = webPassword, hint = "email")))
    assertFalse(EmailField.matches(EmailField.Traits(htmlInputType = "password", idEntry = "email")))
  }

  @Test
  fun `name fallback requires a text field`() {
    assertFalse(EmailField.matches(EmailField.Traits(idEntry = "email", inputType = phone)))
  }

  @Test
  fun `unrelated fields stay quiet`() {
    assertFalse(EmailField.matches(EmailField.Traits(idEntry = "username", inputType = text)))
    assertFalse(EmailField.matches(EmailField.Traits(hint = "Full name")))
    assertFalse(EmailField.matches(EmailField.Traits()))
  }
}
