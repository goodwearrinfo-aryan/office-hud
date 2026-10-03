/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        hud: {
          bg: 'rgb(var(--hud-bg-rgb) / <alpha-value>)',
          panel: 'rgb(var(--hud-panel-rgb) / <alpha-value>)',
          surface: 'rgb(var(--hud-surface-rgb) / <alpha-value>)',
          edge: 'rgb(var(--hud-edge-rgb) / <alpha-value>)',
          'edge-strong': 'var(--hud-edge-strong)',
          text: 'rgb(var(--hud-text-rgb) / <alpha-value>)',
          dim: 'rgb(var(--hud-dim-rgb) / <alpha-value>)',
          amber: 'rgb(var(--hud-amber-rgb) / <alpha-value>)',
          green: 'rgb(var(--hud-green-rgb) / <alpha-value>)',
          red: 'rgb(var(--hud-red-rgb) / <alpha-value>)',
          blue: 'rgb(var(--hud-blue-rgb) / <alpha-value>)',
          purple: 'rgb(var(--hud-purple-rgb) / <alpha-value>)',
          cyan: 'rgb(var(--hud-cyan-rgb) / <alpha-value>)',
        },
      },
      fontFamily: {
        mono: ['"SF Mono"', '"Fira Code"', 'ui-monospace', 'Menlo', 'monospace'],
        ui: ['Inter', 'system-ui', 'sans-serif'],
      },
      spacing: {
        '18': '4.5rem',
        '88': '22rem',
        '128': '32rem',
      },
      boxShadow: {
        hud: '0 4px 24px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.03)',
        'hud-lg': '0 8px 48px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.05)',
        'glow-amber': '0 0 20px rgba(245,166,35,0.3)',
        'glow-green': '0 0 20px rgba(52,211,153,0.3)',
        'glow-red': '0 0 20px rgba(248,113,113,0.3)',
      },
      animation: {
        'pulse-slow': 'pulse 3s ease-in-out infinite',
        'spin-slow': 'spin 2s linear infinite',
        'slide-in': 'slideIn 0.2s ease-out',
        'fade-in': 'fadeIn 0.15s ease-out',
      },
      keyframes: {
        slideIn: {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};