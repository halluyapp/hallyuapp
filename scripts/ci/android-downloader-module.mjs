import fs from 'node:fs';
import path from 'node:path';

/**
 * Generates `HallyuDownloader`, a small native React Native module that runs Hallyu TV movie downloads through
 * Android's built-in DownloadManager. The system keeps a DownloadManager job running when the app is in the
 * background or closed. The app asks for its status when it opens (query), and removes jobs (remove).
 *
 * It uses only public Android APIs (android.app.DownloadManager, SharedPreferences) and the React Native bridge
 * already in the project. It does not pause: DownloadManager cannot pause, so the app does not offer pause for these.
 * Files are written to the app's own external files folder (no storage permission needed) and stay there: they are
 * app-private, playable in place, and moving them would need a second full copy of the file.
 *
 * The request must look like the player. Playback sends a Referer and a browser User-Agent, and the media host
 * refuses a request without them. DownloadManager would otherwise introduce itself as "AndroidDownloadManager",
 * which is why a title could stream in the app and still fail to download. `MEDIA_REFERER` and `MEDIA_USER_AGENT`
 * below are copies of the constants in lib/watchRules.ts; scripts/test-watch.mjs fails if they drift apart.
 */

export const MEDIA_REFERER = 'https://moviebox.ph/';
export const MEDIA_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1';

/** The two Kotlin files, as text. Kept pure so a unit test can assert on them without touching a project. */
export function buildDownloaderSources() {
  const moduleKt = `package com.hallyu.app

import android.app.DownloadManager
import android.content.Context
import android.content.SharedPreferences
import android.database.Cursor
import android.net.Uri
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File

class HallyuDownloaderModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val prefs: SharedPreferences =
        reactContext.getSharedPreferences("hallyu_downloads", Context.MODE_PRIVATE)

    override fun getName(): String = "HallyuDownloader"

    private fun safeName(key: String): String = key.replace(Regex("[^A-Za-z0-9_-]"), "_")

    private fun relativePath(key: String): String = "hallyu-dl/" + safeName(key) + ".mp4"

    private fun targetFile(key: String): File {
        val base = reactContext.getExternalFilesDir(null) ?: reactContext.filesDir
        return File(base, relativePath(key))
    }

    private fun downloadManager(): DownloadManager =
        reactContext.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager

    @ReactMethod
    fun start(key: String, url: String, title: String, promise: Promise) {
        try {
            val dm = downloadManager()
            val old = prefs.getLong(key, -1L)
            if (old >= 0) dm.remove(old)
            val file = targetFile(key)
            file.parentFile?.mkdirs()
            if (file.exists()) file.delete()
            val safeTitle = if (title.trim().startsWith("Hallyu")) title.trim().take(80) else "Hallyu · " + title.trim().take(70)
            val request = DownloadManager.Request(Uri.parse(url))
                .setTitle(safeTitle.ifEmpty { "Hallyu TV" })
                .setDescription("Saving for offline viewing in Hallyu")
                .setMimeType("video/mp4")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedOverRoaming(false)
                .setUserAgent("${MEDIA_USER_AGENT}")
                .addRequestHeader("Referer", "${MEDIA_REFERER}")
                .setDestinationInExternalFilesDir(reactContext, null, relativePath(key))
            // setAllowedOverMetered exists from API 24; the app supports API 23, where mobile data is
            // already allowed by default. Guarded instead of suppressed, so nothing crashes on Android 6.
            if (android.os.Build.VERSION.SDK_INT >= 24) request.setAllowedOverMetered(true)
            val id = dm.enqueue(request)
            prefs.edit().putLong(key, id).apply()
            promise.resolve(id.toString())
        } catch (e: Exception) {
            promise.reject("E_START", e.message ?: "start failed", e)
        }
    }

    @ReactMethod
    fun query(key: String, promise: Promise) {
        var cursor: Cursor? = null
        try {
            val out = Arguments.createMap()
            val id = prefs.getLong(key, -1L)
            if (id < 0) {
                out.putString("status", "missing")
                out.putDouble("reason", -1.0)
                promise.resolve(out)
                return
            }
            cursor = downloadManager().query(DownloadManager.Query().setFilterById(id))
            if (cursor == null || !cursor.moveToFirst()) {
                out.putString("status", "missing")
                out.putDouble("reason", -1.0)
            } else {
                val state = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                val soFar = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                val total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                // COLUMN_REASON is the only thing the system tells us about a failure: no space, an HTTP
                // error, too many redirects, a blocked network. The app turns it into one plain sentence.
                val reason = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))
                val label = when (state) {
                    DownloadManager.STATUS_SUCCESSFUL -> "successful"
                    DownloadManager.STATUS_FAILED -> "failed"
                    DownloadManager.STATUS_PAUSED -> "paused"
                    else -> "running"
                }
                out.putString("status", label)
                out.putDouble("bytes", soFar.toDouble())
                out.putDouble("total", total.toDouble())
                out.putDouble("reason", reason.toDouble())
                out.putString("localPath", targetFile(key).absolutePath)
            }
            promise.resolve(out)
        } catch (e: Exception) {
            promise.reject("E_QUERY", e.message ?: "query failed", e)
        } finally {
            cursor?.close()
        }
    }

    @ReactMethod
    fun remove(key: String, promise: Promise) {
        try {
            val id = prefs.getLong(key, -1L)
            if (id >= 0) downloadManager().remove(id)
            prefs.edit().remove(key).apply()
            targetFile(key).delete()
            promise.resolve(null)
        } catch (e: Exception) {
            promise.reject("E_REMOVE", e.message ?: "remove failed", e)
        }
    }
}
`;

  const packageKt = `package com.hallyu.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class HallyuDownloaderPackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> {
        return listOf(HallyuDownloaderModule(reactContext))
    }

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> {
        return emptyList()
    }
}
`;

  return { moduleKt, packageKt };
}

export function injectNativeDownloaderModule(androidProjectRoot = path.resolve('android')) {
  const pkgDir = path.join(androidProjectRoot, 'app/src/main/java/com/hallyu/app');
  const mainAppPath = path.join(pkgDir, 'MainApplication.kt');

  if (!fs.existsSync(mainAppPath)) {
    throw new Error(`Expected generated MainApplication.kt at ${mainAppPath}`);
  }

  const { moduleKt, packageKt } = buildDownloaderSources();

  fs.writeFileSync(path.join(pkgDir, 'HallyuDownloaderModule.kt'), moduleKt, 'utf8');
  fs.writeFileSync(path.join(pkgDir, 'HallyuDownloaderPackage.kt'), packageKt, 'utf8');

  let mainSrc = fs.readFileSync(mainAppPath, 'utf8');
  if (!mainSrc.includes('HallyuDownloaderPackage')) {
    const anchor = 'add(HallyuApkInstallerPackage())';
    if (!mainSrc.includes(anchor)) {
      throw new Error(`Could not locate "${anchor}" in ${mainAppPath}`);
    }
    mainSrc = mainSrc.replace(anchor, `${anchor}; add(HallyuDownloaderPackage())`);
    fs.writeFileSync(mainAppPath, mainSrc, 'utf8');
  }
}
