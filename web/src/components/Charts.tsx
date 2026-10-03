import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';
import { Line, Bar, Doughnut } from 'react-chartjs-2';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

const darkOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { labels: { color: '#b9c0d0', font: { family: 'SF Mono, monospace', size: 11 } } },
    tooltip: {
      backgroundColor: '#12161f',
      titleColor: '#e7eaf0',
      bodyColor: '#b9c0d0',
      borderColor: '#232a38',
      borderWidth: 1,
      padding: 10,
      titleFont: { family: 'SF Mono, monospace' },
      bodyFont: { family: 'SF Mono, monospace' },
    },
  },
  scales: {
    x: { grid: { color: '#1a2030' }, ticks: { color: '#8b93a7', font: { family: 'SF Mono, monospace', size: 10 } } },
    y: { grid: { color: '#1a2030' }, ticks: { color: '#8b93a7', font: { family: 'SF Mono, monospace', size: 10 } } },
  },
};

export function EquityCurve({ data, color = '#34d399', height = 200 }: { data: number[]; color?: string; height?: number }) {
  if (!data.length) return <div className="h-[200px] flex items-center justify-center text-hud-dim text-sm">no data</div>;
  const labels = data.map((_, i) => i + 1);
  const dataset = {
    label: 'Equity',
    data,
    borderColor: color,
    backgroundColor: `${color}22`,
    fill: true,
    tension: 0.3,
    pointRadius: 0,
    borderWidth: 2,
  };
  return (
    <div style={{ height }}>
      <Line data={{ labels, datasets: [dataset] }} options={darkOptions} />
    </div>
  );
}

export function SharpeComparison({ strategies }: { strategies: Record<string, { avg_sharpe: number; avg_return: number }> }) {
  const names = Object.keys(strategies);
  const sharpes = names.map(n => strategies[n].avg_sharpe);
  const returns = names.map(n => strategies[n].avg_return * 100);
  const colors = names.map(n => n.includes('RSI') ? '#34d399' : n.includes('EMA') ? '#60a5fa' : n.includes('Bollinger') ? '#f5a623' : '#f87171');
  return (
    <div style={{ height: 200 }}>
      <Bar
        data={{
          labels: names.map(n => n.replace(/_/g, ' ')),
          datasets: [
            { label: 'Avg Sharpe', data: sharpes, backgroundColor: colors.map(c => `${c}88`), borderColor: colors, borderWidth: 1 },
            { label: 'Avg Return %', data: returns, backgroundColor: colors.map(c => `${c}44`), borderColor: colors, borderWidth: 1, yAxisID: 'y1' },
          ],
        }}
        options={{
          ...darkOptions,
          scales: {
            ...darkOptions.scales,
            y: { ...darkOptions.scales!.y, title: { display: true, text: 'Sharpe', color: '#8b93a7' } },
            y1: { type: 'linear', display: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Return %', color: '#8b93a7' }, ticks: { color: '#8b93a7' } },
          },
        }}
      />
    </div>
  );
}

export function WinRateProfitFactor({ strategies }: { strategies: Record<string, { win_rate: number; profit_factor: number }> }) {
  const names = Object.keys(strategies);
  return (
    <div style={{ height: 200 }}>
      <Bar
        data={{
          labels: names.map(n => n.replace(/_/g, ' ')),
          datasets: [
            { label: 'Win Rate %', data: names.map(n => strategies[n].win_rate * 100), backgroundColor: '#34d39988', borderColor: '#34d399', borderWidth: 1 },
            { label: 'Profit Factor', data: names.map(n => strategies[n].profit_factor), backgroundColor: '#60a5fa88', borderColor: '#60a5fa', borderWidth: 1, yAxisID: 'y1' },
          ],
        }}
        options={{
          ...darkOptions,
          scales: {
            ...darkOptions.scales,
            y: { ...darkOptions.scales!.y, max: 100, title: { display: true, text: 'Win Rate %', color: '#8b93a7' } },
            y1: { type: 'linear', display: true, position: 'right', grid: { drawOnChartArea: false }, title: { display: true, text: 'Profit Factor', color: '#8b93a7' }, ticks: { color: '#8b93a7' } },
          },
        }}
      />
    </div>
  );
}

export function RiskMetricsDoughnut({ value, max, label, color = '#34d399' }: { value: number; max: number; label: string; color?: string }) {
  return (
    <div style={{ height: 140 }}>
      <Doughnut
        data={{
          labels: [label, 'Remaining'],
          datasets: [{ data: [value, Math.max(0, max - value)], backgroundColor: [color, '#1a2030'], borderWidth: 0, circumference: 180, rotation: -90 }],
        }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          cutout: '75%',
          plugins: {
            legend: { display: false },
            tooltip: { enabled: false },
          },
        }}
      />
    </div>
  );
}

export function DrawdownChart({ drawdowns }: { drawdowns: number[] }) {
  if (!drawdowns.length) return <div className="h-[150px] flex items-center justify-center text-hud-dim text-sm">no data</div>;
  const labels = drawdowns.map((_, i) => i + 1);
  return (
    <div style={{ height: 150 }}>
      <Line
        data={{
          labels,
          datasets: [{
            label: 'Drawdown %',
            data: drawdowns.map(d => -d * 100),
            borderColor: '#f87171',
            backgroundColor: '#f8717122',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          }],
        }}
        options={{
          ...darkOptions,
          scales: {
            ...darkOptions.scales,
            y: { ...darkOptions.scales!.y, title: { display: true, text: 'Drawdown %', color: '#8b93a7' }, ticks: { color: '#8b93a7', callback: (v: number) => `${v}%` } },
          },
        }}
      />
    </div>
  );
}