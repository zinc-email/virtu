package email.zinc.virtu

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The API key at rest: AES-GCM ciphertext in SharedPreferences under a key
 * that lives in the hardware-backed AndroidKeyStore and never leaves it
 * (plans/mobile.md, Auth). The future share target and autofill service read
 * the key from here — this class is the one storage they and the bridge share.
 */
class ApiKeyStore(context: Context) {
  private val prefs = context.getSharedPreferences("virtu-shell", Context.MODE_PRIVATE)

  fun store(apiKey: String) {
    val cipher = Cipher.getInstance(TRANSFORMATION)
    cipher.init(Cipher.ENCRYPT_MODE, secretKey())
    val ciphertext = cipher.doFinal(apiKey.toByteArray(Charsets.UTF_8))
    prefs.edit()
      .putString(PREF_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
      .putString(PREF_CIPHERTEXT, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
      .apply()
  }

  fun load(): String? {
    val iv = prefs.getString(PREF_IV, null) ?: return null
    val ciphertext = prefs.getString(PREF_CIPHERTEXT, null) ?: return null
    return try {
      val cipher = Cipher.getInstance(TRANSFORMATION)
      cipher.init(
        Cipher.DECRYPT_MODE,
        secretKey(),
        GCMParameterSpec(GCM_TAG_BITS, Base64.decode(iv, Base64.NO_WRAP)),
      )
      String(cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP)), Charsets.UTF_8)
    } catch (e: Exception) {
      // Undecryptable (Keystore key rotated/invalidated, e.g. after a
      // restore): treat as logged out rather than crash — the SPA will show
      // the login screen and a fresh login re-stores the key.
      null
    }
  }

  fun clear() {
    prefs.edit().remove(PREF_IV).remove(PREF_CIPHERTEXT).apply()
  }

  private fun secretKey(): SecretKey {
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (keyStore.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
      KeyGenParameterSpec.Builder(
        KEY_ALIAS,
        KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
      )
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .build(),
    )
    return generator.generateKey()
  }

  private companion object {
    const val KEYSTORE = "AndroidKeyStore"
    const val KEY_ALIAS = "virtu-api-key"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val GCM_TAG_BITS = 128
    const val PREF_IV = "apiKey.iv"
    const val PREF_CIPHERTEXT = "apiKey.ciphertext"
  }
}
