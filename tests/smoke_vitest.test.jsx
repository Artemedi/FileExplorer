import React from 'react';
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { I18nProvider, useTranslation } from '../src/i18n/index.jsx';

afterEach(() => {
    cleanup();
    localStorage.clear();
});

function I18nSmokeHarness() {
    const { language, setLanguage, t } = useTranslation();
    return (
        <div>
            <span data-testid="lang">{language}</span>
            <h1 data-testid="title">{t('settings.title')}</h1>
            <button type="button" onClick={() => setLanguage('ru')}>
                Switch to RU
            </button>
        </div>
    );
}

describe('Vitest + React Testing Library smoke test', () => {
    test('renders I18nProvider and switches translations cleanly', () => {
        localStorage.setItem('explr_language', 'en');
        render(
            <I18nProvider>
                <I18nSmokeHarness />
            </I18nProvider>
        );

        expect(screen.getByTestId('lang')).toHaveTextContent('en');
        expect(screen.getByTestId('title')).toHaveTextContent('Settings');

        fireEvent.click(screen.getByRole('button', { name: 'Switch to RU' }));

        expect(screen.getByTestId('lang')).toHaveTextContent('ru');
        expect(screen.getByTestId('title')).toHaveTextContent('Настройки');
        expect(screen.getByTestId('title')).toBeInTheDocument();
    });
});
