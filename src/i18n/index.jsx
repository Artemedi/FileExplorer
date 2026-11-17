import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import en from './en.json';
import ru from './ru.json';

const dictionaries = { en, ru };

const I18nContext = createContext({
    language: 'en',
    setLanguage: () => {},
    t: (key, fallback) => fallback || key,
});

export const I18nProvider = ({ children }) => {
    const [language, setLanguageState] = useState(() => {
        try {
            const saved = localStorage.getItem('explr_language');
            if (saved && (saved === 'ru' || saved === 'en')) {
                return saved;
            }
            if (navigator.language && navigator.language.toLowerCase().startsWith('ru')) {
                return 'ru';
            }
        } catch (_) {}
        return 'en';
    });

    const setLanguage = useCallback((lang) => {
        setLanguageState(lang);
        try {
            localStorage.setItem('explr_language', lang);
        } catch (_) {}
    }, []);

    const t = useCallback((path, fallback = '') => {
        const dict = dictionaries[language] || dictionaries.en;
        const keys = path.split('.');
        let current = dict;
        for (const k of keys) {
            if (current && typeof current === 'object' && k in current) {
                current = current[k];
            } else {
                current = undefined;
                break;
            }
        }

        if (typeof current === 'string') {
            return current;
        }

        // Fallback to English dictionary if not found in Russian
        if (language !== 'en') {
            let fallbackVal = dictionaries.en;
            for (const k of keys) {
                if (fallbackVal && typeof fallbackVal === 'object' && k in fallbackVal) {
                    fallbackVal = fallbackVal[k];
                } else {
                    fallbackVal = undefined;
                    break;
                }
            }
            if (typeof fallbackVal === 'string') return fallbackVal;
        }

        return fallback || path;
    }, [language]);

    return (
        <I18nContext.Provider value={{ language, setLanguage, t }}>
            {children}
        </I18nContext.Provider>
    );
};

export const useTranslation = () => useContext(I18nContext);
export default I18nProvider;
