/* eslint-env node */
const fs = require('node:fs');
const path = require('node:path');

/**
 * Dynamic Expo configuration wrapper around `app.json`.
 *
 * Security & Portability Guarantees:
 *   1. Never commits credentials into Git: `google-services.json` is materialized cleanly in the
 *      build workspace at CI build time and wired dynamically when present.
 *   2. Assigns monotonically increasing `versionCode` across CI builds so Android upgrades cleanly
 *      in-place using Hallyu's permanent 4096-bit release keystore — never requiring uninstall.
 *   3. Configures root Android App Links & iOS Associated Domains for `https://hallyuapp.github.io`
 *      while remaining dynamically compatible with optional subpath previews (`EXPO_PUBLIC_BASE_PATH`).
 */
module.exports = ({ config }) => {
  const hasGoogleServices = fs.existsSync(path.join(__dirname, 'google-services.json'));
  const buildCode = Number.parseInt(
    process.env.EXPO_PUBLIC_BUILD_NUMBER || process.env.ANDROID_VERSION_CODE || '100',
    10,
  );
  const appVersion = (process.env.EXPO_PUBLIC_APP_VERSION || config.version || '1.0.0').trim();
  const basePath = (process.env.EXPO_PUBLIC_BASE_PATH || '').trim();

  const existingPermissions = Array.isArray(config.android?.permissions)
    ? config.android.permissions
    : [];
  const permissions = Array.from(
    new Set([
      ...existingPermissions,
      'POST_NOTIFICATIONS',
      'RECEIVE_BOOT_COMPLETED',
      'VIBRATE',
      'REQUEST_INSTALL_PACKAGES',
    ]),
  );

  const existingFilters = Array.isArray(config.android?.intentFilters)
    ? config.android.intentFilters
    : [];

  return {
    ...config,
    version: appVersion,
    ios: {
      ...config.ios,
      associatedDomains: ['applinks:halluyapp.github.io', 'applinks:hallyuapp.github.io'],
    },
    android: {
      ...config.android,
      versionCode: Number.isFinite(buildCode) && buildCode > 0 ? buildCode : 100,
      permissions,
      ...(hasGoogleServices ? { googleServicesFile: './google-services.json' } : {}),
      intentFilters: [
        ...existingFilters,
        {
          action: 'VIEW',
          autoVerify: true,
          data: [
            {
              scheme: 'https',
              host: 'halluyapp.github.io',
              pathPrefix: '/hallyuapp',
            },
          ],
          category: ['BROWSABLE', 'DEFAULT'],
        },
      ],
    },
    experiments: {
      ...config.experiments,
      typedRoutes: false,
      ...(basePath ? { baseUrl: basePath } : {}),
    },
  };
};
