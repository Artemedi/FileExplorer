import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import en from './en.json';
import ru from './ru.json';

const dictionaries = { en, ru };

const getPluralCategory = (count, lang) => {
    const absCount = Math.abs(Number(count));
    if (!Number.isFinite(absCount)) return 'other';
    try {
        if (typeof Intl !== 'undefined' && typeof Intl.PluralRules === 'function') {
            return new Intl.PluralRules(lang).select(absCount);
        }
    } catch (_) {}
    if (lang === 'ru') {
        const mod10 = absCount % 10;
        const mod100 = absCount % 100;
        if (mod10 === 1 && mod100 !== 11) return 'one';
        if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'few';
        return 'many';
    }
    return absCount === 1 ? 'one' : 'other';
};

const interpolate = (template, params) => {
    if (!params || typeof params !== 'object') return template;
    return template.replace(/\{(\w+)\}/g, (match, key) => (
        Object.prototype.hasOwnProperty.call(params, key) && params[key] !== undefined && params[key] !== null
            ? String(params[key])
            : match
    ));
};

const resolvePath = (dict, keys) => {
    let current = dict;
    for (const k of keys) {
        if (current && typeof current === 'object' && k in current) {
            current = current[k];
        } else {
            return undefined;
        }
    }
    return current;
};

const I18nContext = createContext({
    language: 'en',
    setLanguage: () => {},
    t: (key, paramsOrFallback, maybeFallback) => (typeof paramsOrFallback === 'string' ? paramsOrFallback : maybeFallback) || key,
});

export const I18nProvider = ({ children }) => {
    const [language, setLanguageState] = useState(() => {
        try {
            const saved = localStorage.getItem('explr_language');
            if (saved && saved in dictionaries) {
                return saved;
            }
            if (typeof navigator !== 'undefined' && navigator.language && navigator.language.toLowerCase().startsWith('ru')) {
                return 'ru';
            }
        } catch (_) {}
        return 'en';
    });

    useEffect(() => {
        if (typeof document !== 'undefined' && document.documentElement) {
            document.documentElement.lang = language;
        }
    }, [language]);

    const setLanguage = useCallback((lang) => {
        if (!lang || !(lang in dictionaries)) {
            return;
        }
        setLanguageState(lang);
        try {
            localStorage.setItem('explr_language', lang);
        } catch (_) {}
    }, []);

    const t = useCallback((path, paramsOrFallback = '', maybeFallback = '') => {
        const hasParams = paramsOrFallback !== null && typeof paramsOrFallback === 'object' && !Array.isArray(paramsOrFallback);
        const params = hasParams ? paramsOrFallback : null;
        const fallback = hasParams ? maybeFallback : (typeof paramsOrFallback === 'string' ? paramsOrFallback : '');

        const dict = dictionaries[language] || dictionaries.en;
        const keys = path.split('.');
        let current = resolvePath(dict, keys);
        let activeLang = language;

        if (current === undefined && language !== 'en') {
            current = resolvePath(dictionaries.en, keys);
            activeLang = 'en';
        }

        if (current && typeof current === 'object' && !Array.isArray(current)) {
            const count = params && typeof params.count === 'number' ? params.count : 0;
            const category = getPluralCategory(count, activeLang);
            const pluralTemplate = current[category] || current.other || current.many || current.one;
            if (typeof pluralTemplate === 'string') {
                return interpolate(pluralTemplate, params);
            }
        }

        if (typeof current === 'string') {
            return interpolate(current, params);
        }

        return interpolate(fallback || path, params);
    }, [language]);

    return (
        <I18nContext.Provider value={{ language, setLanguage, t }}>
            {children}
        </I18nContext.Provider>
    );
};

export const useTranslation = () => useContext(I18nContext);
export default I18nProvider;
