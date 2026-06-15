import { useRef, useEffect } from 'react';
import './LogsPanel.css';

const LEVEL_STYLES = {
  INFO: 'log--info',
  SUCCESS: 'log--success',
  WARNING: 'log--warning',
  ERROR: 'log--error',
};

export default function LogsPanel({ logs }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  if (!logs || logs.length === 0) return null;

  return (
    <div className="logs-panel">
      <h3 className="logs-panel__title">Activity Log</h3>
      <div className="logs-panel__list">
        {logs.map((log, i) => (
          <div key={i} className={`logs-panel__entry ${LEVEL_STYLES[log.level] || ''}`}>
            <span className="logs-panel__time">{log.time}</span>
            <span className="logs-panel__level">[{log.level}]</span>
            <span className="logs-panel__msg">{log.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
