import { useEffect } from 'react';
import { useSettings } from '../providers/SettingsProvider';

/**
 * Component that applies settings to the DOM/CSS variables
 * This component doesn't render anything, it just applies settings as side effects
 */
const SettingsApplier = () => {
    const { settings } = useSettings();

    useEffect(() => {
        // Apply font size settings
        if (settings.font_size) {
            const fontSizeClass = `font-size-${settings.font_size.toLowerCase()}`;

            // Remove existing font size classes
            document.documentElement.classList.remove('font-size-small', 'font-size-medium', 'font-size-large');

            // Add the current font size class
            if (settings.font_size !== 'Medium') {
                document.documentElement.classList.add(fontSizeClass);
            }
        }

        // Apply accent color
        let effectiveAccent = settings.accent_color;
        // Never allow pure black (#000000) as accent color as it destroys visibility in dark theme
        if (!effectiveAccent || effectiveAccent.toLowerCase() === '#000000' || effectiveAccent.toLowerCase() === '#000') {
            effectiveAccent = '#0672ef';
        }

        // Convert 3-digit or 6-digit hex to RGB for CSS variables that need RGB values
        const hexToRgb = (hex) => {
            if (typeof hex !== 'string') return null;
            const clean = hex.trim().replace(/^#/, '');
            const full = clean.length === 3
                ? clean.split('').map(c => c + c).join('')
                : clean;
            const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(full);
            return result ? {
                r: parseInt(result[1], 16),
                g: parseInt(result[2], 16),
                b: parseInt(result[3], 16)
            } : null;
        };

        const rgb = hexToRgb(effectiveAccent);
        if (rgb) {
            // Check luminance to ensure dark mode visibility
            const luminance = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
            // If the color is too dark for dark mode, brighten it for dark mode
            const darkAccent = luminance < 60 ? '#3b82f6' : effectiveAccent;

            const darkerAccent = `color-mix(in srgb, ${effectiveAccent} 85%, black)`;
            const lighterAccent = `color-mix(in srgb, ${effectiveAccent} 15%, transparent)`;
            const darkAccentSurface = `color-mix(in srgb, ${darkAccent} 20%, transparent)`;
            const darkAccentHover = `color-mix(in srgb, ${darkAccent} 85%, white)`;

            // Apply accent color variables
            document.documentElement.style.setProperty('--light-accent', effectiveAccent);
            document.documentElement.style.setProperty('--dark-accent', darkAccent);
            document.documentElement.style.setProperty('--light-accent-hover', darkerAccent);
            document.documentElement.style.setProperty('--dark-accent-hover', darkAccentHover);
            document.documentElement.style.setProperty('--light-accent-surface', lighterAccent);
            document.documentElement.style.setProperty('--dark-accent-surface', darkAccentSurface);

            // Apply to current theme
            const isDark = document.documentElement.classList.contains('theme-dark') ||
                           (!document.documentElement.classList.contains('theme-light') &&
                            typeof window !== 'undefined' &&
                            window.matchMedia &&
                            window.matchMedia('(prefers-color-scheme: dark)').matches);
            const currentAccent = isDark ? darkAccent : effectiveAccent;
            const currentHover = isDark ? darkAccentHover : darkerAccent;
            const currentSurface = isDark ? darkAccentSurface : lighterAccent;
            const currentRgb = hexToRgb(currentAccent) || rgb;

            // Update RGB values for transparency effects matching the active theme's accent
            document.documentElement.style.setProperty('--accent-rgb', `${currentRgb.r}, ${currentRgb.g}, ${currentRgb.b}`);
            document.documentElement.style.setProperty('--accent', currentAccent);
            document.documentElement.style.setProperty('--accent-hover', currentHover);
            document.documentElement.style.setProperty('--accent-surface', currentSurface);
        }

        // Apply animation settings
        if (settings.enable_animations_and_transitions === false) {
            document.documentElement.classList.add('reduce-motion');
        } else {
            document.documentElement.classList.remove('reduce-motion');
        }

        // Apply terminal height
        if (settings.terminal_height) {
            document.documentElement.style.setProperty('--terminal-height', `${settings.terminal_height}px`);
        }

        console.log('Settings applied to DOM:', {
            font_size: settings.font_size,
            accent_color: settings.accent_color,
            enable_animations_and_transitions: settings.enable_animations_and_transitions,
            terminal_height: settings.terminal_height
        });

    }, [settings.darkmode, settings.font_size, settings.accent_color, settings.enable_animations_and_transitions, settings.terminal_height]);

    // This component doesn't render anything
    return null;
};

export default SettingsApplier;