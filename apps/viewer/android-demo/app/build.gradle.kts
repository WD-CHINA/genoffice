plugins {
    id("com.android.application")
}

val webRoot = rootProject.layout.projectDirectory.dir("../releases/genoffice-viewer")
val syncViewerWeb = tasks.register<Sync>("syncViewerWeb") {
    from(webRoot) {
        exclude("**/*.gz")
    }
    into(layout.buildDirectory.dir("generated/viewerWeb"))
}

android {
    namespace = "com.genoffice.viewerdemo"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.genoffice.viewerdemo"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }
    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    androidResources {
        noCompress += listOf("wasm", "ttf", "woff", "woff2", "bcmap", "pfb", "gz", "mjs")
    }
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/viewerWeb"))
}

tasks.configureEach {
    if (name == "preBuild" || name == "mergeDebugAssets" || name == "mergeReleaseAssets") {
        dependsOn(syncViewerWeb)
    }
}
