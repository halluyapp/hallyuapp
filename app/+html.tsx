import { ScrollViewStyleReset } from 'expo-router/html';
import React, { type PropsWithChildren } from 'react';

export default function Root({ children }: PropsWithChildren) {
  const basePath = (process.env.EXPO_PUBLIC_BASE_PATH || '').replace(/\/$/, '');
  const prefix = basePath || '.';

  return (
    <html lang="en" style={{ backgroundColor: '#000000' }}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"
        />
        <meta name="theme-color" content="#000000" />
        <meta name="background-color" content="#000000" />

        {/* Full-Screen iPhone / iPad Standalone App Configuration */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Hallyu" />

        <title>Hallyu — Every Episode Night. Together.</title>
        <meta
          name="description"
          content="Social timeline, live synchronized Watch Parties, DMs & spoiler-safe threads across K-Dramas, C-Dramas, Anime & Cinema."
        />

        {/* OpenGraph & Social Preview Cards (WhatsApp, X, Instagram, Discord, TikTok) */}
        <meta property="og:site_name" content="Hallyu" />
        <meta property="og:type" content="website" />
        <meta property="og:title" content="Hallyu — Every Episode Night. Together." />
        <meta
          property="og:description"
          content="Join live Watch Parties, vote in episode predictions, react with friends & track K-Dramas, C-Dramas, Anime & Cinema with zero spoilers."
        />
        <meta property="og:image" content={`${prefix}/apple-touch-icon.png`} />
        <meta name="twitter:card" content="summary" />
        <meta name="twitter:title" content="Hallyu — Every Episode Night. Together." />
        <meta
          name="twitter:description"
          content="Live Watch Parties, social reactions & spoiler-protected rooms across K-Drama, C-Drama, Anime & Cinema."
        />

        <link rel="manifest" href={`${prefix}/manifest.json`} />
        <link rel="apple-touch-icon" href={`${prefix}/apple-touch-icon.png`} />

        <ScrollViewStyleReset />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              html, body, #root {
                background-color: #000000 !important;
                color: #F5F5F7;
                overscroll-behavior-y: none;
              }
            `,
          }}
        />
      </head>
      <body style={{ backgroundColor: '#000000' }}>{children}</body>
    </html>
  );
}
