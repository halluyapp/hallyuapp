import { Tabs } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { CreateSheet } from '../../components/create/CreateSheet';
import { TabBar } from '../../components/navigation/TabBar';
import { TabBarMotionProvider } from '../../components/navigation/TabBarMotion';
import { colors, sizes } from '../../constants/theme';
import { useLayout } from '../../lib/hooks';
import type { PostContext } from '../../lib/model';
import { onOpenGlobalCreateSheet } from '../../lib/tabEvents';

export default function TabsLayout() {
  const { wc } = useLayout();
  const rail = wc !== 'compact';
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
      <View style={{ flex: 1, backgroundColor: colors.canvas, paddingLeft: rail ? sizes.rail : 0 }}>
        <Tabs
          tabBar={(props) => <TabBar {...props} />}
          screenOptions={{ headerShown: false, lazy: true }}
          sceneContainerStyle={{ backgroundColor: colors.canvas }}
          backBehavior="history"
        >
          <Tabs.Screen name="index" options={{ title: 'Home' }} />
          <Tabs.Screen name="explore" options={{ title: 'Explore' }} />
          <Tabs.Screen name="create" options={{ title: 'Create' }} listeners={{ tabPress: (e) => e.preventDefault() }} />
          <Tabs.Screen name="activity" options={{ title: 'Activity' }} />
          <Tabs.Screen name="you" options={{ title: 'You' }} />
        </Tabs>
        <CreateSheet visible={sheetOpen} onClose={() => setSheetOpen(false)} context={sheetCtx} />
      </View>
    </TabBarMotionProvider>
  );
}
