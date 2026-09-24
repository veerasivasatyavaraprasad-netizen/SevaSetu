import { useNavigate } from 'react-router-dom';

export function Table({ cols, rows, onRow, empty = 'Nothing to show.' }) {
  const nav = useNavigate();
  return (
    <div className="table-wrap">
      <table>
        <thead><tr>{cols.map(([k, label]) => <th key={k}>{label}</th>)}</tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={cols.length} className="muted center">{empty}</td></tr>}
          {rows.map((r, i) => (
            <tr key={r.id || i} className={onRow ? 'click' : ''} onClick={onRow ? () => (typeof onRow === 'function' ? onRow(r) : nav(onRow + r.id)) : undefined}>
              {cols.map(([k, , render]) => <td key={k}>{render ? render(r) : r[k]}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Stat({ label, value, tone }) {
  return <div className="stat"><div className="v" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div><div className="l">{label}</div></div>;
}

export const SEVERITY_TONE = { critical: 'danger', high: 'danger', medium: 'warn', low: '' };

export function ask(message) {
  // eslint-disable-next-line no-alert
  return window.prompt(message);
}
