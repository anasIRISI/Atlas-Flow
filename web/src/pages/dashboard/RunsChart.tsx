import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { DashboardStats } from '@flowforge/shared';

const AXIS = { fill: '#a0a0b0', fontSize: 12 };

const shortDay = (day: string) => {
  const [, m, d] = day.split('-');
  return `${d}/${m}`;
};

/** Stacked bars: executions per day (last 14 days). */
export function RunsChart({ perDay }: { perDay: DashboardStats['perDay'] }) {
  return (
    <div className="h-64 w-full" data-testid="runs-chart">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={perDay} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <CartesianGrid stroke="#22324a" vertical={false} />
          <XAxis dataKey="day" tickFormatter={shortDay} tick={AXIS} axisLine={{ stroke: '#354963' }} tickLine={false} interval="preserveStartEnd" />
          <YAxis allowDecimals={false} tick={AXIS} axisLine={false} tickLine={false} />
          <Tooltip
            cursor={{ fill: 'rgba(255,255,255,0.04)' }}
            contentStyle={{ background: '#152136', border: '1px solid #354963', borderRadius: 8, color: '#ececf1', fontSize: 13 }}
            labelStyle={{ color: '#ececf1', fontWeight: 600 }}
            itemStyle={{ color: '#ececf1' }}
          />
          <Legend wrapperStyle={{ fontSize: 12, color: '#a0a0b0' }} iconType="circle" />
          <Bar dataKey="success" name="Réussites" stackId="runs" fill="#2fbf71" isAnimationActive={false} />
          <Bar dataKey="error" name="Erreurs" stackId="runs" fill="#f0524f" isAnimationActive={false} />
          <Bar dataKey="other" name="Autres" stackId="runs" fill="#6e6e7e" radius={[3, 3, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
