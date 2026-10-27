import { useSlice } from './store';

export type AppLanguage = 'en' | 'ko' | 'ja' | 'zh' | 'fr';

export interface LanguageOption {
  code: AppLanguage;
  key: AppLanguage;
  nativeLabel: string;
  label: string;
  englishLabel: string;
  regionHint: string;
}

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { code: 'en', key: 'en', nativeLabel: 'English', label: 'English', englishLabel: 'English', regionHint: 'Global default' },
  { code: 'ko', key: 'ko', nativeLabel: '한국어', label: 'Korean', englishLabel: 'Korean', regionHint: '서울 · K-Drama native' },
  { code: 'ja', key: 'ja', nativeLabel: '日本語', label: 'Japanese', englishLabel: 'Japanese', regionHint: '東京 · Anime native' },
  { code: 'zh', key: 'zh', nativeLabel: '简体中文', label: 'Chinese', englishLabel: 'Chinese', regionHint: '华语 · C-Drama native' },
  { code: 'fr', key: 'fr', nativeLabel: 'Français', label: 'French', englishLabel: 'French', regionHint: 'International' },
];

export const APP_LANGUAGES = SUPPORTED_LANGUAGES;

export type TranslationKey =
  | 'nav.home'
  | 'nav.explore'
  | 'nav.create'
  | 'nav.activity'
  | 'nav.you'
  | 'home.forYou'
  | 'home.following'
  | 'home.liveEvents'
  | 'home.newPosts'
  | 'settings.title'
  | 'settings.appearance'
  | 'settings.language'
  | 'settings.notifications'
  | 'settings.account'
  | 'settings.content'
  | 'settings.privacy'
  | 'settings.app'
  | 'settings.data'
  | 'settings.support'
  | 'settings.bugReport'
  | 'settings.help'
  | 'settings.about'
  | 'settings.updates'
  | 'settings.signOut'
  | 'settings.trueBlack'
  | 'settings.cinemaCharcoal';

const DICTIONARY: Record<AppLanguage, Record<TranslationKey, string>> = {
  en: {
    'nav.home': 'Home',
    'nav.explore': 'Explore',
    'nav.create': 'Post',
    'nav.activity': 'Activity',
    'nav.you': 'Profile',
    'home.forYou': 'For you',
    'home.following': 'Following',
    'home.liveEvents': 'Live Events',
    'home.newPosts': 'New posts',
    'settings.title': 'Settings',
    'settings.appearance': 'Appearance',
    'settings.language': 'Language',
    'settings.notifications': 'Notifications',
    'settings.account': 'Account',
    'settings.content': 'Content & spoilers',
    'settings.privacy': 'Privacy & safety',
    'settings.app': 'App',
    'settings.data': 'Data & storage',
    'settings.support': 'Support',
    'settings.bugReport': 'Report a bug or feedback',
    'settings.help': 'Help & support',
    'settings.about': 'About Hallyu',
    'settings.updates': 'App updates',
    'settings.signOut': 'Sign out',
    'settings.trueBlack': 'True Black OLED',
    'settings.cinemaCharcoal': 'Cinema Charcoal',
  },
  ko: {
    'nav.home': '홈',
    'nav.explore': '탐색',
    'nav.create': '작성',
    'nav.activity': '활동',
    'nav.you': '프로필',
    'home.forYou': '추천',
    'home.following': '팔로잉',
    'home.liveEvents': '라이브 이벤트',
    'home.newPosts': '새 게시물',
    'settings.title': '설정',
    'settings.appearance': '화면 테마',
    'settings.language': '언어',
    'settings.notifications': '알림',
    'settings.account': '계정',
    'settings.content': '콘텐츠 및 스포일러 방지',
    'settings.privacy': '개인정보 및 안전',
    'settings.app': '앱 설정',
    'settings.data': '데이터 및 저장공간',
    'settings.support': '고객 지원',
    'settings.bugReport': '버그 신고 / 작품 요청',
    'settings.help': '도움말 및 문의',
    'settings.about': 'Hallyu 정보',
    'settings.updates': '앱 업데이트',
    'settings.signOut': '로그아웃',
    'settings.trueBlack': '트루 블랙 OLED',
    'settings.cinemaCharcoal': '시네마 차콜',
  },
  ja: {
    'nav.home': 'ホーム',
    'nav.explore': '探索',
    'nav.create': '投稿',
    'nav.activity': '通知',
    'nav.you': 'マイページ',
    'home.forYou': 'おすすめ',
    'home.following': 'フォロー中',
    'home.liveEvents': 'ライブイベント',
    'home.newPosts': '新しい投稿',
    'settings.title': '設定',
    'settings.appearance': '外観テーマ',
    'settings.language': '言語',
    'settings.notifications': '通知設定',
    'settings.account': 'アカウント',
    'settings.content': 'ネタバレ防止と表示設定',
    'settings.privacy': 'プライバシーと安全',
    'settings.app': 'アプリ',
    'settings.data': 'データ通信とストレージ',
    'settings.support': 'サポート',
    'settings.bugReport': '不具合報告・作品リクエスト',
    'settings.help': 'ヘルプとお問い合わせ',
    'settings.about': 'Hallyuについて',
    'settings.updates': 'アプリ更新',
    'settings.signOut': 'ログアウト',
    'settings.trueBlack': 'トゥルーブラック OLED',
    'settings.cinemaCharcoal': 'シネマチャコール',
  },
  zh: {
    'nav.home': '首页',
    'nav.explore': '发现',
    'nav.create': '发布',
    'nav.activity': '动态',
    'nav.you': '我的',
    'home.forYou': '为你推荐',
    'home.following': '关注中',
    'home.liveEvents': '直播派对',
    'home.newPosts': '有新动态',
    'settings.title': '设置',
    'settings.appearance': '外观主题',
    'settings.language': '语言',
    'settings.notifications': '通知提醒',
    'settings.account': '账号安全',
    'settings.content': '内容与防剧透设置',
    'settings.privacy': '隐私与安全',
    'settings.app': '应用设置',
    'settings.data': '数据与缓存',
    'settings.support': '帮助与支持',
    'settings.bugReport': '问题反馈 / 求片',
    'settings.help': '常见问题与联系我们',
    'settings.about': '关于 Hallyu',
    'settings.updates': '版本更新',
    'settings.signOut': '退出登录',
    'settings.trueBlack': '纯黑 OLED',
    'settings.cinemaCharcoal': '影院深灰',
  },
  fr: {
    'nav.home': 'Accueil',
    'nav.explore': 'Explorer',
    'nav.create': 'Publier',
    'nav.activity': 'Activité',
    'nav.you': 'Profil',
    'home.forYou': 'Pour vous',
    'home.following': 'Abonnements',
    'home.liveEvents': 'Soirées Live',
    'home.newPosts': 'Nouveaux posts',
    'settings.title': 'Paramètres',
    'settings.appearance': 'Apparence',
    'settings.language': 'Langue',
    'settings.notifications': 'Notifications',
    'settings.account': 'Compte',
    'settings.content': 'Contenu et anti-spoilers',
    'settings.privacy': 'Confidentialité',
    'settings.app': 'Application',
    'settings.data': 'Données et stockage',
    'settings.support': 'Assistance',
    'settings.bugReport': 'Signaler un bug / série',
    'settings.help': 'Aide et support',
    'settings.about': 'À propos de Hallyu',
    'settings.updates': 'Mises à jour',
    'settings.signOut': 'Se déconnecter',
    'settings.trueBlack': 'Noir Absolu OLED',
    'settings.cinemaCharcoal': 'Anthracite Cinéma',
  },
};

export function translate(lang: AppLanguage | string | undefined, key: TranslationKey): string {
  const safeLang: AppLanguage =
    lang === 'ko' || lang === 'ja' || lang === 'zh' || lang === 'fr' ? lang : 'en';
  return DICTIONARY[safeLang][key] ?? DICTIONARY.en[key];
}

export function useI18n() {
  const language = useSlice((s) => s.prefs.language);
  return {
    language,
    t: (key: TranslationKey) => translate(language, key),
  };
}
