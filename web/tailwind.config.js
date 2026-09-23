/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        hud: {
          bg: '#0b0e14',
          panel: '#12161f',
          surface: '#182033',
          edge: '#232a38',
          text: '#e7eaf0',
          dim: '#5b6a8f',
          amber: '#f5a623',
          green: '#34d399',
          red: '#f87171',
          blue: '#60a5fa',
          purple: '#c084fc',
          cyan: '#22d3ee',
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