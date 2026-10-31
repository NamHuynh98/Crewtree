import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enCommon from './locales/en/common.json';
import viCommon from './locales/vi/common.json';
import { getBoot } from '../lib/boot';

const bootLang = getBoot().language;

i18n.use(initReactI18next).init({
  resources: {
    en: { common: enCommon },
    vi: { common: viCommon },
  },
  lng: bootLang,
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
