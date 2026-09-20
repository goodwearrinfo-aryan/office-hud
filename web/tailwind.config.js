/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        hud: {
          bg: '#0b0e14',
          panel: '#12161f',
          edge: '#232a38',
          text: '#e7eaf0',
          dim: '#8b93a7',
          amber: '#f5a623',
          green: '#34d399',
          red: '#f87171',
          blue: '#60a5fa',
        },
      },
      fontFamily: {
        mono: ['SF Mono', 'ui-monospace', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
