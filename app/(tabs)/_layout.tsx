import { Tabs } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { CreateSheet } from '../../components/create/CreateSheet';
import { TabBar } from '../../components/navigation/TabBar';
import { TabBarMotionProvider } from '../../components/navigation/TabBarMotion';
import { useCanvasColor } from '../../components/ui/Screen';
import { sizes } from '../../constants/theme';
import { useLayout } from '../../lib/hooks';
import { useI18n } from '../../lib/i18n';
import type { PostContext } from '../../lib/model';
import { onOpenGlobalCreateSheet } from '../../lib/tabEvents';

export default function TabsLayout() {
  const { wc } = useLayout();
  const rail = wc !== 'compact';
  const canvasColor = useCanvasColor();
  const { t } = useI18n();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [sheetCtx, setSheetCtx] = useState<PostContext | undefined>(undefined);

  useEffect(() => {
    return onOpenGlobalCreateSheet((ctx) => {
      setSheetCtx(ctx);
      setSheetOpen(true);
    });
  }, []);

  return (
    <TabBarMotionProvider>
      <View style={{ flex: 1, backgroundColor: canvasColor, paddingLeft: rail ? sizes.rail : 0 }}>
        <Tabs
          tabBar={(props) => <TabBar {...props} />}
          screenOptions={{ headerShown: false, lazy: true }}
          sceneContainerStyle={{ backgroundColor: canvasColor }}
          backBehavior="history"
        >
          <Tabs.Screen name="index" options={{ title: t('nav.home') }} />
          <Tabs.Screen name="explore" options={{ title: t('nav.explore') }} />
          <Tabs.Screen name="create" options={{ title: t('nav.create') }} listeners={{ tabPress: (e) => e.preventDefault() }} />
          <Tabs.Screen name="activity" options={{ title: t('nav.activity') }} />
          <Tabs.Screen name="you" options={{ title: t('nav.you') }} />
        </Tabs>
        <CreateSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} context={sheetCtx} />
      </View>
    </TabBarMotionProvider>
  );
}
