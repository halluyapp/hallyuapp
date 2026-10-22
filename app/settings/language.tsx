import React from 'react';
import { SettingsChoice, SettingsGroup } from '../../components/settings/Rows';
import { Screen, ScrollScreen } from '../../components/ui/Screen';
import { TopBar } from '../../components/ui/TopBar';
import { useApp } from '../../lib/hooks';
import { APP_LANGUAGES, type AppLanguage, useI18n } from '../../lib/i18n';

export default function LanguageSettings() {
  const { state, dispatch } = useApp();
  const { t } = useI18n();
  return (
    <Screen header={<TopBar mode="stack" title={t('settings.language')} />}>
      <ScrollScreen>
        <SettingsGroup
          title={t('settings.language')}
          footer="Navigation tabs, feed controls, and core interface actions adapt instantly without restarting Hallyu. Show and film titles display both English and original-script names."
        >
          <SettingsChoice<AppLanguage>
            value={state.prefs.language}
            onChange={(v) => dispatch({ type: 'prefs', patch: { language: v } })}
            options={APP_LANGUAGES.map((l) => ({
              key: l.key,
              label: l.nativeLabel,
              detail: l.label !== l.nativeLabel ? l.label : undefined,
            }))}
          />
        </SettingsGroup>
      </ScrollScreen>
    </Screen>
  );
}
