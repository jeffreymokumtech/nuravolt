'use client';

import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import enMessages from '../../messages/en.json';

export type Language = 'en' | 'es' | 'ca' | 'ar';

export const LANGUAGES: { value: Language; label: string; nativeLabel: string }[] = [
  { value: 'en', label: 'English', nativeLabel: 'English' },
  { value: 'es', label: 'Spanish', nativeLabel: 'Español' },
  { value: 'ca', label: 'Catalan', nativeLabel: 'Català' },
  { value: 'ar', label: 'Arabic', nativeLabel: 'العربية' },
];

const VALID_LANGUAGES = new Set<string>(LANGUAGES.map(l => l.value));

interface LanguageContextType {
  language: Language;
  setLanguage: (lang: Language) => void;
  t: (key: string) => string;
  isRTL: boolean;
  loading: boolean;
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined);

// English loaded synchronously so there's never a flash of untranslated keys
const enTranslations: Record<string, string> = enMessages as Record<string, string>;

// Cache for other languages
const translationCache: Partial<Record<Language, Record<string, string>>> = {
  en: enTranslations,
};

async function loadTranslations(lang: Language): Promise<Record<string, string>> {
  if (translationCache[lang]) return translationCache[lang]!;

  try {
    let mod: any;
    switch (lang) {
      case 'es':
        mod = await import('../../messages/es.json');
        break;
      case 'ca':
        mod = await import('../../messages/ca.json');
        break;
      case 'ar':
        mod = await import('../../messages/ar.json');
        break;
      default:
        return enTranslations;
    }
    const msgs: Record<string, string> = mod.default || mod;
    translationCache[lang] = msgs;
    return msgs;
  } catch (err) {
    console.error(`Failed to load translations for ${lang}:`, err);
    return enTranslations;
  }
}

export function LanguageProvider({ children }: { children: React.ReactNode }) {
  const [language, setLanguageState] = useState<Language>('en');
  const [translations, setTranslations] = useState<Record<string, string>>(enTranslations);
  const [loading, setLoading] = useState(false);

  // Initialize language from localStorage or browser (runs once)
  useEffect(() => {
    const savedLang = localStorage.getItem('language');
    if (savedLang && VALID_LANGUAGES.has(savedLang) && savedLang !== 'en') {
      setLanguageState(savedLang as Language);
    } else {
      const browserLang = navigator.language.toLowerCase();
      if (browserLang.startsWith('ar')) setLanguageState('ar');
      else if (browserLang.startsWith('ca')) setLanguageState('ca');
      else if (browserLang.startsWith('es')) setLanguageState('es');
    }
  }, []);

  // Load translations when language changes (English is already loaded)
  useEffect(() => {
    if (language === 'en') {
      setTranslations(enTranslations);
      return;
    }
    let cancelled = false;
    setLoading(true);
    loadTranslations(language).then(msgs => {
      if (!cancelled) {
        setTranslations(msgs);
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, [language]);

  // Persist language and update document attributes
  useEffect(() => {
    localStorage.setItem('language', language);
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.lang = language;
  }, [language]);

  const setLanguage = useCallback((lang: Language) => {
    setLanguageState(lang);
  }, []);

  const t = useCallback((key: string): string => {
    return translations[key] || key;
  }, [translations]);

  const value = {
    language,
    setLanguage,
    t,
    isRTL: language === 'ar',
    loading,
  };

  return (
    <LanguageContext.Provider value={value}>
      {children}
    </LanguageContext.Provider>
  );
}

export function useLanguage() {
  const context = useContext(LanguageContext);
  if (!context) {
    throw new Error('useLanguage must be used within a LanguageProvider');
  }
  return context;
}
