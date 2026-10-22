# Builds the sideloadable debug APK, the same way the CI workflow does.
#
# Why a script: the Gradle build has two environment requirements that a plain
# `gradlew` on this machine does not meet by default.
#
#   1. JAVA_HOME must point at a JDK 21. The Capacitor Android modules compile
#      with `--release 21` (they carry no Java toolchain block, so Gradle's own
#      JVM is what compiles them), while Android Gradle Plugin 8.13 needs at
#      least 17. `.github/workflows/android.yml` installs Temurin 21 and lets
#      `actions/setup-java` set JAVA_HOME; this script does the same locally.
#      The Java 21 *toolchain* path in `~/.gradle/gradle.properties` is not
#      enough on its own — that resolves `languageVersion = 21` for the plugins
#      that ask for a toolchain, not the compiler Gradle runs on.
#   2. The Android SDK has to be where `android/local.properties` says it is
#      (`sdk.dir`), and `platforms;android-36` / `build-tools;36.0.0` have to be
#      installed (`android/variables.gradle`: compileSdk/targetSdk 36).
#
# Steps, in the order CI runs them (they share `.next`, so they cannot overlap):
#
#   pnpm build:app            the static export that goes inside the APK
#   pnpm exec cap sync android copies it into android/app/src/main/assets/public
#   gradlew assembleDebug     packages and signs the debug APK
#
# Output: dist/nba-score-debug.apk (also left where Gradle writes it,
# android/app/build/outputs/apk/debug/app-debug.apk) with its SHA256 printed.

param(
    [string]$JavaHome = "$env:LOCALAPPDATA\Programs\jdk-21",
    [string]$AndroidHome = "$env:LOCALAPPDATA\Android\Sdk",
    [switch]$SkipWeb  # reuse the existing out/ export and Android assets
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$android = Join-Path $repo 'android'

if (-not (Test-Path (Join-Path $JavaHome 'bin\java.exe'))) {
    throw "No JDK 21 at '$JavaHome'. Install one and pass -JavaHome, or set JAVA_HOME to a JDK 21."
}
$javaVersion = (& (Join-Path $JavaHome 'bin\java.exe') -version 2>&1 | Select-Object -First 1)
if ($javaVersion -notmatch '"21\.') {
    throw "JAVA_HOME must be a JDK 21 (found: $javaVersion)."
}
foreach ($component in @('platforms\android-36\android.jar', 'build-tools\36.0.0\aapt2.exe')) {
    if (-not (Test-Path (Join-Path $AndroidHome $component))) {
        throw "Android SDK component missing: $component under '$AndroidHome'."
    }
}

$env:JAVA_HOME = $JavaHome
$env:ANDROID_HOME = $AndroidHome
$env:ANDROID_SDK_ROOT = $AndroidHome
Write-Host "JAVA_HOME    = $JavaHome  ($javaVersion)"
Write-Host "ANDROID_HOME = $AndroidHome"
Write-Host ""

if (-not $SkipWeb) {
    Write-Host '== pnpm build:app =='
    & pnpm build:app
    if ($LASTEXITCODE -ne 0) { throw "pnpm build:app failed with $LASTEXITCODE" }

    Write-Host '== pnpm exec cap sync android =='
    & pnpm exec cap sync android
    if ($LASTEXITCODE -ne 0) { throw "cap sync failed with $LASTEXITCODE" }
}

Write-Host '== gradlew assembleDebug =='
Push-Location $android
try {
    & .\gradlew.bat assembleDebug --no-daemon --stacktrace --console=plain
    if ($LASTEXITCODE -ne 0) { throw "gradlew assembleDebug failed with $LASTEXITCODE" }
} finally {
    Pop-Location
}

$built = Join-Path $android 'app\build\outputs\apk\debug\app-debug.apk'
if (-not (Test-Path $built)) { throw "Gradle reported success but $built does not exist." }

$dist = Join-Path $repo 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$delivered = Join-Path $dist 'nba-score-debug.apk'
Copy-Item $built $delivered -Force

$hash = (Get-FileHash $delivered -Algorithm SHA256).Hash
$size = (Get-Item $delivered).Length
Write-Host ''
Write-Host "APK      : $delivered"
Write-Host "Bytes    : $size"
Write-Host "SHA256   : $hash"
