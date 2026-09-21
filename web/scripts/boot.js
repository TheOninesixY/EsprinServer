/* 首屏外观引导：在样式表生效前把主题、主题风格、圆角、应用名颜色、侧边栏形态与界面布局
   写成 <html> 上的类名 / 属性，因此不会先画一遍默认外观再切换。
   与桌面版 src/renderer/boot.js 同一职责，只是配置来源换成浏览器的 localStorage。

   本文件在 <head> 里同步执行，只读配置、不碰任何 DOM 元素；
   配置里缺失或非法的取值一律回退到默认值，与 scripts/store.js 的 loadConfig 保持一致。 */

const WEB_CONFIG_KEY = 'esprin.nemo.config';

// 与桌面版一致的类名常量（scripts/mode.js、scripts/app.js 共用）
const MODERN_LAYOUT_CLASS = 'modern-layout';
const TABS_DISABLED_CLASS = 'tabs-disabled';
const SIDEBAR_COLLAPSED_CLASS = 'sidebar-collapsed';
const LIGHT_THEME_CLASS = 'light';
// 与 styles/motion.css 的 --motion-crossfade 一致；多留 60ms 再摘类，避免过渡被提前掐断
const APPEARANCE_FADE_MS = 250;

const THEME_VALUES = ['system', 'dark', 'light'];
const THEME_STYLE_VALUES = ['default', 'alom'];
const BRAND_COLOR_VALUES = ['brand', 'mono', 'accent'];
const CORNER_RADIUS_VALUES = ['square', 'slight', 'default', 'large'];
const UI_MODE_VALUES = ['classic', 'modern'];
const AI_SCOPE_VALUES = ['current', 'all', 'none'];

function readStoredConfig() {
    try {
        const parsed = JSON.parse(localStorage.getItem(WEB_CONFIG_KEY) || 'null');
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        return {};
    }
}

const BOOT_CONFIG = readStoredConfig();

// 现代布局先后叫过「Line 模式」「无Tab模式」与「极简模式」，旧配置里存的仍是 line / notab / minimal
function normalizeUiMode(value) {
    if (value === 'line' || value === 'notab' || value === 'minimal') return 'modern';
    if (value === 'standard') return 'classic';
    return UI_MODE_VALUES.includes(value) ? value : 'modern';
}

function isModernLayout() {
    return State.uiMode === 'modern';
}

/* ---------------- 主题色的亮度换算 ----------------
   强调色底面上的文字色按相对亮度取黑或白（浅色主题色上不会出现白字看不清），
   与 scripts/app.js 的 accentForeground 同一套算法 */

function normalizeAccentHex(value) {
    const text = String(value || '').trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(text)) return '';
    return text.toUpperCase();
}

function bootAccentForeground(hex) {
    const channel = (value) => (value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4));
    const r = channel(parseInt(hex.slice(1, 3), 16) / 255);
    const g = channel(parseInt(hex.slice(3, 5), 16) / 255);
    const b = channel(parseInt(hex.slice(5, 7), 16) / 255);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance > 0.5 ? '#000000' : '#ffffff';
}

function bootResolvedTheme() {
    const theme = THEME_VALUES.includes(BOOT_CONFIG.theme) ? BOOT_CONFIG.theme : 'system';
    if (theme !== 'system') return theme;
    try {
        return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    } catch (error) {
        return 'dark';
    }
}

// 把用户填写的字体族名转成可用的 font-family 值（含空格的族名要加引号）
function quoteFontFamily(name) {
    const text = String(name || '').trim();
    if (!text) return '';
    return /^[\w-]+$/.test(text) ? text : `"${text.replace(/"/g, '')}"`;
}

(function applyBootAppearance() {
    const root = document.documentElement;
    const stored = BOOT_CONFIG;

    // 明暗主题
    root.classList.toggle(LIGHT_THEME_CLASS, bootResolvedTheme() === 'light');

    // 主题风格（默认风格写 default：alom.css 只匹配 alom，写什么都不会误触发）
    root.dataset.themeStyle = THEME_STYLE_VALUES.includes(stored.themeStyle) ? stored.themeStyle : 'default';

    // 圆角尺度
    root.dataset.radius = CORNER_RADIUS_VALUES.includes(stored.cornerRadius) ? stored.cornerRadius : 'default';

    // 应用名颜色
    root.dataset.brandColor = BRAND_COLOR_VALUES.includes(stored.brandColor) ? stored.brandColor : 'brand';

    // 界面布局：现代（默认）不排标题栏；「禁用标签页」只属于现代布局
    const uiMode = normalizeUiMode(stored.uiMode);
    root.classList.toggle(MODERN_LAYOUT_CLASS, uiMode === 'modern');
    root.classList.toggle(TABS_DISABLED_CLASS, uiMode === 'modern' && !!stored.tabsDisabled);

    // 侧边栏收起态：首屏按收起态绘制，不出现展开后补播动画
    root.classList.toggle(SIDEBAR_COLLAPSED_CLASS, !!stored.sidebarCollapsed);

    // 主题色：写在内联样式上，高于 tokens.css 里的默认值
    const accent = normalizeAccentHex(stored.accentColor);
    if (accent) {
        const r = parseInt(accent.slice(1, 3), 16);
        const g = parseInt(accent.slice(3, 5), 16);
        const b = parseInt(accent.slice(5, 7), 16);
        root.style.setProperty('--accent', accent);
        root.style.setProperty('--accent-bg', `rgba(${r}, ${g}, ${b}, 0.15)`);
        root.style.setProperty('--accent-fg', bootAccentForeground(accent));
    }

    // 字体：界面字体与文档字体分别覆盖，西文与 CJK 按顺序回退
    const fonts = stored.fonts && typeof stored.fonts === 'object' ? stored.fonts : {};
    const uiFamilies = [quoteFontFamily(fonts.uiLatin), quoteFontFamily(fonts.uiCjk)].filter(Boolean);
    if (uiFamilies.length) root.style.setProperty('--font-sans', `${uiFamilies.join(', ')}, sans-serif`);
    const docFamilies = [quoteFontFamily(fonts.docLatin), quoteFontFamily(fonts.docCjk)].filter(Boolean);
    if (docFamilies.length) {
        const fallback = quoteFontFamily(fonts.uiCjk);
        root.style.setProperty('--font-doc', `${docFamilies.join(', ')}${fallback ? `, ${fallback}` : ''}, sans-serif`);
    }
})();
