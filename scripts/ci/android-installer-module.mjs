import fs from 'node:fs';
import path from 'node:path';

/**
 * Generates and registers Hallyu's native Android `HallyuApkInstaller` React Native module inside
 * the prebuilt Android project (`android/app/src/main/java/com/hallyu/app/`).
 *
 * Uses official public Android OS APIs across SDK 23–36:
 *   - `Build.SUPPORTED_ABIS`, `Build.SUPPORTED_64_BIT_ABIS`, `Build.SUPPORTED_32_BIT_ABIS`
 *   - `android.system.Os.uname().machine` (distinguishes 64-bit CPU silicon from 32-bit Android OS!)
 *   - `PackageManager.getPackageInfo` & `getPackageArchiveInfo` (package ID, versionCode, versionName,
 *     minSdkVersion, targetSdkVersion, and X.509 SHA-256 signing certificate fingerprints)
 *   - `java.util.zip.ZipFile` central-directory validation + `lib/<abi>/*.so` inspection + streaming SHA-256
 *   - `android.content.pm.PackageInstaller.Session` with authentic `BroadcastReceiver` status reporting
 *     (`STATUS_PENDING_USER_ACTION`, `STATUS_SUCCESS`, `STATUS_FAILURE_ABORTED`,
 *     `STATUS_FAILURE_INCOMPATIBLE`, `STATUS_FAILURE_CONFLICT`, `STATUS_FAILURE_STORAGE`,
 *     `STATUS_FAILURE_INVALID`, `STATUS_FAILURE_BLOCKED`)
 */
export function injectNativeApkInstallerModule(androidProjectRoot = path.resolve('android')) {
  const pkgDir = path.join(androidProjectRoot, 'app/src/main/java/com/hallyu/app');
  const mainAppPath = path.join(pkgDir, 'MainApplication.kt');

  if (!fs.existsSync(mainAppPath)) {
    throw new Error(`Expected generated MainApplication.kt at ${mainAppPath}`);
  }

  const moduleKt = `package com.hallyu.app

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.system.Os
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.util.zip.ZipFile

class HallyuApkInstallerModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val ioExecutor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun getName(): String = "HallyuApkInstaller"

    private fun toWritableStringArray(items: Collection<String>): WritableArray {
        val arr = Arguments.createArray()
        for (item in items) {
            arr.pushString(item)
        }
        return arr
    }

    private fun resolveLocalFile(pathOrUri: String): File {
        val trimmed = pathOrUri.trim()
        return if (trimmed.startsWith("file://")) {
            val parsed = Uri.parse(trimmed)
            File(parsed.path ?: trimmed.removePrefix("file://"))
        } else {
            File(trimmed)
        }
    }

    private fun sha256ColonHex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString(":") { b -> "%02X".format(b) }
    }

    private fun computeFileSha256Hex(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(65536)
        FileInputStream(file).use { fis ->
            var read = fis.read(buf)
            while (read > 0) {
                md.update(buf, 0, read)
                read = fis.read(buf)
            }
        }
        return md.digest().joinToString("") { b -> "%02x".format(b) }
    }

    @Suppress("DEPRECATION")
    private fun extractVersionCode(pkgInfo: PackageInfo): Long {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            pkgInfo.longVersionCode
        } else {
            pkgInfo.versionCode.toLong()
        }
    }

    @Suppress("DEPRECATION")
    private fun extractSigningFingerprints(pkgInfo: PackageInfo): List<String> {
        val sigs: Array<Signature>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val signingInfo = pkgInfo.signingInfo
            if (signingInfo == null) {
                pkgInfo.signatures
            } else if (signingInfo.hasMultipleSigners()) {
                signingInfo.apkContentsSigners
            } else {
                signingInfo.signingCertificateHistory
            }
        } else {
            pkgInfo.signatures
        }
        return sigs?.map { sha256ColonHex(it.toByteArray()) }?.distinct() ?: emptyList()
    }

    @Suppress("DEPRECATION")
    private fun getInstalledPackageDetails(pm: PackageManager, pkgName: String): PackageInfo {
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }
        return pm.getPackageInfo(pkgName, flags)
    }

    private fun extractMinSdk(appInfo: ApplicationInfo?): Int {
        if (appInfo == null) return 23
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            appInfo.minSdkVersion
        } else {
            23
        }
    }

    @ReactMethod
    fun getDeviceEnvironment(promise: Promise) {
        try {
            val ctx = reactContext.applicationContext
            val pm = ctx.packageManager
            val supportedAbis = Build.SUPPORTED_ABIS?.toList() ?: emptyList()
            val supported64 = Build.SUPPORTED_64_BIT_ABIS?.toList() ?: emptyList()
            val supported32 = Build.SUPPORTED_32_BIT_ABIS?.toList() ?: emptyList()
            val kernelArch = runCatching { Os.uname().machine }.getOrNull()
                ?: (System.getProperty("os.arch") ?: "")
            val cpuLooks64Bit = kernelArch.contains("64") ||
                kernelArch.contains("aarch64", ignoreCase = true) ||
                kernelArch.contains("armv8", ignoreCase = true)
            val cpu64BitCapableOs32BitOnly = cpuLooks64Bit && supported64.isEmpty() && supported32.isNotEmpty()

            val pkgInfo = getInstalledPackageDetails(pm, ctx.packageName)
            val installedSigs = extractSigningFingerprints(pkgInfo)
            val appInfo = pkgInfo.applicationInfo
            val canInstall = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                pm.canRequestPackageInstalls()
            } else {
                true
            }

            val map: WritableMap = Arguments.createMap()
            map.putArray("supportedAbis", toWritableStringArray(supportedAbis))
            map.putArray("supported64BitAbis", toWritableStringArray(supported64))
            map.putArray("supported32BitAbis", toWritableStringArray(supported32))
            map.putString("kernelArch", kernelArch)
            map.putBoolean("cpu64BitCapableOs32BitOnly", cpu64BitCapableOs32BitOnly)
            map.putInt("sdkInt", Build.VERSION.SDK_INT)
            map.putString("androidRelease", Build.VERSION.RELEASE ?: "")
            map.putString("brand", Build.BRAND ?: "")
            map.putString("manufacturer", Build.MANUFACTURER ?: "")
            map.putString("model", Build.MODEL ?: "")
            map.putString("device", Build.DEVICE ?: "")
            map.putBoolean("canRequestPackageInstalls", canInstall)

            val installedMap = Arguments.createMap()
            installedMap.putString("packageName", ctx.packageName)
            installedMap.putString("versionName", pkgInfo.versionName ?: "")
            installedMap.putDouble("versionCode", extractVersionCode(pkgInfo).toDouble())
            installedMap.putInt("minSdkVersion", extractMinSdk(appInfo))
            installedMap.putInt("targetSdkVersion", appInfo?.targetSdkVersion ?: 34)
            installedMap.putString("nativeLibraryDir", appInfo?.nativeLibraryDir ?: "")
            installedMap.putString("signingSha256", installedSigs.firstOrNull() ?: "")
            installedMap.putArray("signingSha256List", toWritableStringArray(installedSigs))
            map.putMap("installed", installedMap)

            promise.resolve(map)
        } catch (t: Throwable) {
            promise.reject("ENV_INSPECT_ERROR", t.message ?: "Failed to inspect Android environment", t)
        }
    }

    @Suppress("DEPRECATION")
    @ReactMethod
    fun inspectApkArchive(filePathOrUri: String, expectedSha256: String?, promise: Promise) {
        ioExecutor.execute {
            try {
                val ctx = reactContext.applicationContext
                val pm = ctx.packageManager
                val file = resolveLocalFile(filePathOrUri)
                val out = Arguments.createMap()

                if (!file.exists() || !file.isFile || file.length() <= 0L) {
                    out.putBoolean("ok", false)
                    out.putString("reasonCode", "FILE_MISSING")
                    out.putString("message", "Downloaded APK file could not be found on storage.")
                    promise.resolve(out)
                    return@execute
                }

                val sizeBytes = file.length()
                out.putDouble("sizeBytes", sizeBytes.toDouble())

                // 1. Streaming SHA-256 verification
                val actualSha256 = computeFileSha256Hex(file)
                out.putString("actualSha256", actualSha256)

                if (!expectedSha256.isNullOrBlank() &&
                    !actualSha256.equals(expectedSha256.trim(), ignoreCase = true)
                ) {
                    out.putBoolean("ok", false)
                    out.putString("reasonCode", "SHA256_MISMATCH")
                    out.putString(
                        "message",
                        "Downloaded APK checksum mismatch (corrupted or stale cached file)."
                    )
                    promise.resolve(out)
                    return@execute
                }

                // 2. Full ZIP central-directory & native lib/<abi>/*.so inspection
                val apkAbis = linkedSetOf<String>()
                var hasNativeLibs = false
                try {
                    ZipFile(file).use { zf ->
                        val entries = zf.entries()
                        while (entries.hasMoreElements()) {
                            val entry = entries.nextElement()
                            val name = entry.name
                            if (name.startsWith("lib/") && name.endsWith(".so")) {
                                hasNativeLibs = true
                                val parts = name.split("/")
                                if (parts.size >= 3 && parts[1].isNotEmpty()) {
                                    apkAbis.add(parts[1])
                                }
                            }
                        }
                    }
                } catch (zipErr: Throwable) {
                    out.putBoolean("ok", false)
                    out.putString("reasonCode", "INVALID_ZIP_ARCHIVE")
                    out.putString(
                        "message",
                        "Downloaded APK archive is incomplete or corrupted (\${zipErr.message ?: "bad zip"})."
                    )
                    promise.resolve(out)
                    return@execute
                }

                // 3. Android PackageManager archive parse (manifest, SDK bounds & signing certs)
                val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                    PackageManager.GET_SIGNING_CERTIFICATES
                } else {
                    PackageManager.GET_SIGNATURES
                }
                val archiveInfo = pm.getPackageArchiveInfo(file.absolutePath, flags)
                if (archiveInfo == null) {
                    out.putBoolean("ok", false)
                    out.putString("reasonCode", "INVALID_APK_MANIFEST")
                    out.putString("message", "Android PackageManager could not parse the downloaded APK.")
                    promise.resolve(out)
                    return@execute
                }
                archiveInfo.applicationInfo?.let {
                    it.sourceDir = file.absolutePath
                    it.publicSourceDir = file.absolutePath
                }

                val installedInfo = getInstalledPackageDetails(pm, ctx.packageName)
                val installedCode = extractVersionCode(installedInfo)
                val installedSigs = extractSigningFingerprints(installedInfo)

                val archivePkg = archiveInfo.packageName ?: ""
                val archiveVerName = archiveInfo.versionName ?: ""
                val archiveCode = extractVersionCode(archiveInfo)
                val archiveMinSdk = extractMinSdk(archiveInfo.applicationInfo)
                val archiveTargetSdk = archiveInfo.applicationInfo?.targetSdkVersion ?: 34
                val archiveSigs = extractSigningFingerprints(archiveInfo)

                val deviceAbis = Build.SUPPORTED_ABIS?.toList() ?: emptyList()
                val matchedAbi = deviceAbis.firstOrNull { apkAbis.contains(it) }

                val packageMatches = archivePkg == ctx.packageName
                val signatureMatches = installedSigs.isEmpty() ||
                    (archiveSigs.isNotEmpty() && archiveSigs.intersect(installedSigs.toSet()).isNotEmpty())
                val sdkCompatible = archiveMinSdk <= Build.VERSION.SDK_INT
                val abiCompatible = !hasNativeLibs || matchedAbi != null
                val versionNotDowngrade = archiveCode >= installedCode

                out.putString("packageName", archivePkg)
                out.putString("versionName", archiveVerName)
                out.putDouble("versionCode", archiveCode.toDouble())
                out.putInt("minSdkVersion", archiveMinSdk)
                out.putInt("targetSdkVersion", archiveTargetSdk)
                out.putArray("apkAbis", toWritableStringArray(apkAbis))
                out.putArray("deviceAbis", toWritableStringArray(deviceAbis))
                out.putString("matchedAbi", matchedAbi)
                out.putString("signingSha256", archiveSigs.firstOrNull() ?: "")
                out.putBoolean("packageMatches", packageMatches)
                out.putBoolean("signatureMatches", signatureMatches)
                out.putBoolean("sdkCompatible", sdkCompatible)
                out.putBoolean("abiCompatible", abiCompatible)
                out.putBoolean("versionNotDowngrade", versionNotDowngrade)

                when {
                    !packageMatches -> {
                        out.putBoolean("ok", false)
                        out.putString("reasonCode", "PACKAGE_ID_MISMATCH")
                        out.putString(
                            "message",
                            "Package ID mismatch: APK is \${archivePkg}, installed app is \${ctx.packageName}."
                        )
                    }
                    !signatureMatches -> {
                        out.putBoolean("ok", false)
                        out.putString("reasonCode", "SIGNATURE_MISMATCH")
                        out.putString(
                            "message",
                            "Signing certificate mismatch: your currently installed Hallyu copy was signed with an older key (\${installedSigs.firstOrNull()?.take(14) ?: "unknown"}…) while official releases use permanent key \${archiveSigs.firstOrNull()?.take(14) ?: "unknown"}…."
                        )
                    }
                    !sdkCompatible -> {
                        out.putBoolean("ok", false)
                        out.putString("reasonCode", "SDK_INCOMPATIBLE")
                        out.putString(
                            "message",
                            "This update requires Android SDK \${archiveMinSdk}, while this phone runs Android SDK \${Build.VERSION.SDK_INT}."
                        )
                    }
                    !abiCompatible -> {
                        out.putBoolean("ok", false)
                        out.putString("reasonCode", "ABI_INCOMPATIBLE")
                        out.putString(
                            "message",
                            "Architecture mismatch: APK only contains [\${apkAbis.joinToString(", ")}], while this phone's Android OS supports [\${deviceAbis.joinToString(", ")}]."
                        )
                    }
                    !versionNotDowngrade -> {
                        out.putBoolean("ok", false)
                        out.putString("reasonCode", "VERSION_DOWNGRADE")
                        out.putString(
                            "message",
                            "Downloaded build (\${archiveCode}) is older than your installed build (\${installedCode})."
                        )
                    }
                    else -> {
                        out.putBoolean("ok", true)
                        out.putString("reasonCode", "OK")
                        out.putString("message", "Verified compatible signed APK.")
                    }
                }

                promise.resolve(out)
            } catch (t: Throwable) {
                promise.reject("APK_INSPECT_ERROR", t.message ?: "Failed to inspect APK archive", t)
            }
        }
    }

    @ReactMethod
    fun installApkSession(filePathOrUri: String, promise: Promise) {
        ioExecutor.execute {
            val ctx = reactContext.applicationContext
            val pm = ctx.packageManager

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !pm.canRequestPackageInstalls()) {
                val res = Arguments.createMap()
                res.putString("status", "needs_unknown_sources_permission")
                res.putString("reasonCode", "UNKNOWN_SOURCES_PERMISSION_REQUIRED")
                res.putString("message", "Enable 'Install unknown apps' for Hallyu to install updates directly.")
                promise.resolve(res)
                return@execute
            }

            val file = resolveLocalFile(filePathOrUri)
            if (!file.exists() || file.length() <= 0L) {
                val res = Arguments.createMap()
                res.putString("status", "install_failed")
                res.putString("reasonCode", "FILE_MISSING")
                res.putString("message", "Downloaded APK file could not be found on storage.")
                promise.resolve(res)
                return@execute
            }

            val packageInstaller = pm.packageInstaller
            var sessionId = -1
            try {
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
                params.setAppPackageName(ctx.packageName)
                params.setSize(file.length())

                sessionId = packageInstaller.createSession(params)
                val session = packageInstaller.openSession(sessionId)
                session.use { s ->
                    FileInputStream(file).use { input ->
                        s.openWrite("hallyu-update.apk", 0, file.length()).use { out ->
                            val buffer = ByteArray(65536)
                            var c = input.read(buffer)
                            while (c >= 0) {
                                out.write(buffer, 0, c)
                                c = input.read(buffer)
                            }
                            s.fsync(out)
                        }
                    }

                    val action = "\${ctx.packageName}.INSTALL_COMMIT.\$sessionId"
                    val settled = AtomicBoolean(false)

                    val receiver = object : BroadcastReceiver() {
                        override fun onReceive(context: Context, intent: Intent) {
                            val status = intent.getIntExtra(
                                PackageInstaller.EXTRA_STATUS,
                                PackageInstaller.STATUS_FAILURE
                            )
                            val statusMessage = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)

                            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                                @Suppress("DEPRECATION")
                                val confirmIntent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                    intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java)
                                } else {
                                    intent.getParcelableExtra(Intent.EXTRA_INTENT)
                                }
                                if (confirmIntent != null) {
                                    val selfReceiver = this
                                    confirmIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                    ctx.startActivity(confirmIntent)
                                    // Safety net for OEM ROMs that don't dispatch a final abort broadcast
                                    // after user dismisses the confirmation prompt without tapping Update:
                                    mainHandler.postDelayed({
                                        if (settled.compareAndSet(false, true)) {
                                            runCatching { ctx.unregisterReceiver(selfReceiver) }
                                            val out = Arguments.createMap()
                                            out.putString("status", "awaiting_user_install")
                                            out.putInt("androidStatus", status)
                                            out.putString("reasonCode", "AWAITING_USER_APPROVAL")
                                            out.putString(
                                                "message",
                                                "Android package installer opened — awaiting confirmation."
                                            )
                                            promise.resolve(out)
                                        }
                                    }, 25000L)
                                } else if (settled.compareAndSet(false, true)) {
                                    runCatching { ctx.unregisterReceiver(this) }
                                    val out = Arguments.createMap()
                                    out.putString("status", "install_failed")
                                    out.putString("reasonCode", "MISSING_CONFIRM_INTENT")
                                    out.putString("message", "Android did not return a package confirmation prompt.")
                                    promise.resolve(out)
                                }
                                return
                            }

                            if (!settled.compareAndSet(false, true)) return
                            runCatching { ctx.unregisterReceiver(this) }

                            val out = Arguments.createMap()
                            out.putInt("androidStatus", status)
                            when (status) {
                                PackageInstaller.STATUS_SUCCESS -> {
                                    out.putString("status", "installed")
                                    out.putString("reasonCode", "INSTALLED")
                                    out.putString("message", "Update installed successfully.")
                                }
                                PackageInstaller.STATUS_FAILURE_ABORTED -> {
                                    out.putString("status", "cancelled_by_user")
                                    out.putString("reasonCode", "INSTALL_CANCELLED")
                                    out.putString(
                                        "message",
                                        "Installation was cancelled — your phone is still running the previous version."
                                    )
                                }
                                PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> {
                                    out.putString("status", "install_failed")
                                    out.putString("reasonCode", "INSTALL_FAILED_INCOMPATIBLE")
                                    out.putString(
                                        "message",
                                        statusMessage ?: "Android reported this package is not compatible with this device."
                                    )
                                }
                                PackageInstaller.STATUS_FAILURE_CONFLICT -> {
                                    out.putString("status", "install_failed")
                                    out.putString("reasonCode", "INSTALL_FAILED_CONFLICT")
                                    out.putString(
                                        "message",
                                        statusMessage ?: "Update conflicted with an existing installation signed with a different key."
                                    )
                                }
                                PackageInstaller.STATUS_FAILURE_STORAGE -> {
                                    out.putString("status", "install_failed")
                                    out.putString("reasonCode", "INSTALL_FAILED_STORAGE")
                                    out.putString(
                                        "message",
                                        statusMessage ?: "Insufficient phone storage space to complete the update."
                                    )
                                }
                                PackageInstaller.STATUS_FAILURE_INVALID -> {
                                    out.putString("status", "install_failed")
                                    out.putString("reasonCode", "INSTALL_FAILED_INVALID")
                                    out.putString(
                                        "message",
                                        statusMessage ?: "Downloaded APK package was rejected as invalid."
                                    )
                                }
                                PackageInstaller.STATUS_FAILURE_BLOCKED -> {
                                    out.putString("status", "install_failed")
                                    out.putString("reasonCode", "INSTALL_FAILED_BLOCKED")
                                    out.putString(
                                        "message",
                                        statusMessage ?: "Installation was blocked by device security settings."
                                    )
                                }
                                else -> {
                                    out.putString("status", "install_failed")
                                    out.putString("reasonCode", "INSTALL_FAILED_UNKNOWN")
                                    out.putString(
                                        "message",
                                        statusMessage ?: "Android could not complete package installation (code \$status)."
                                    )
                                }
                            }
                            promise.resolve(out)
                        }
                    }

                    val filter = IntentFilter(action)
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                        ctx.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
                    } else {
                        ctx.registerReceiver(receiver, filter)
                    }

                    val callbackIntent = Intent(action).apply {
                        setPackage(ctx.packageName)
                    }
                    val pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT or
                        (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
                    val pendingIntent = PendingIntent.getBroadcast(
                        ctx,
                        sessionId,
                        callbackIntent,
                        pendingFlags
                    )
                    s.commit(pendingIntent.intentSender)
                }
            } catch (t: Throwable) {
                if (sessionId >= 0) {
                    runCatching { packageInstaller.abandonSession(sessionId) }
                }
                val res = Arguments.createMap()
                res.putString("status", "install_failed")
                res.putString("reasonCode", "SESSION_EXCEPTION")
                res.putString("message", t.message ?: "Failed to start Android package installer session.")
                promise.resolve(res)
            }
        }
    }
}
`;

  const packageKt = `package com.hallyu.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class HallyuApkInstallerPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(HallyuApkInstallerModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
`;

  fs.writeFileSync(path.join(pkgDir, 'HallyuApkInstallerModule.kt'), moduleKt, 'utf8');
  fs.writeFileSync(path.join(pkgDir, 'HallyuApkInstallerPackage.kt'), packageKt, 'utf8');

  let mainSrc = fs.readFileSync(mainAppPath, 'utf8');
  if (!mainSrc.includes('HallyuApkInstallerPackage')) {
    if (!mainSrc.includes('return PackageList(this).packages')) {
      throw new Error(
        `Could not locate "return PackageList(this).packages" in ${mainAppPath}`,
      );
    }
    mainSrc = mainSrc.replace(
      'return PackageList(this).packages',
      'return PackageList(this).packages.apply { add(HallyuApkInstallerPackage()) }',
    );
    fs.writeFileSync(mainAppPath, mainSrc, 'utf8');
  }
}
