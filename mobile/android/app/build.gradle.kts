plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.kotlin.android)
  alias(libs.plugins.kotlin.serialization)
}

// Which deployment the shell fronts. Debug defaults to the local dev stack
// (`just up`; 10.0.2.2 is the emulator's route to the host's localhost),
// release to zinc (prod). Override either with
//   ./gradlew assembleRelease -PvirtuWebOrigin=https://lmnop.email
val webOrigin: String? = providers.gradleProperty("virtuWebOrigin").orNull

fun com.android.build.api.dsl.BuildType.webOriginConfig(default: String) {
  val origin = webOrigin ?: default
  buildConfigField("String", "WEB_ORIGIN", "\"$origin\"")
  buildConfigField("String", "START_URL", "\"$origin/app/\"")
}

android {
  namespace = "email.zinc.virtu"
  compileSdk = 36

  defaultConfig {
    // PERMANENT once the first build is uploaded to Play. The store
    // name/branding is still an open question (plans/mobile.md) — settle it
    // before creating the Play app record.
    applicationId = "email.zinc.virtu"
    minSdk = 26
    targetSdk = 36
    versionCode = 1
    versionName = "0.1.0"
  }

  buildFeatures {
    buildConfig = true
  }

  buildTypes {
    debug {
      webOriginConfig("http://10.0.2.2:8080")
    }
    release {
      webOriginConfig("https://zinc.email")
      isMinifyEnabled = true
      isShrinkResources = true
      proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
      // Play App Signing: the upload keystore is per-machine, never committed
      // (see README "Release").
    }
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
}

kotlin {
  compilerOptions {
    jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
  }
}

dependencies {
  implementation(libs.androidx.core.ktx)
  implementation(libs.androidx.activity.ktx)
  implementation(libs.androidx.webkit)
  implementation(libs.androidx.splashscreen)
  implementation(libs.androidx.autofill)
  implementation(libs.kotlinx.serialization.json)
  testImplementation(libs.junit)
}
