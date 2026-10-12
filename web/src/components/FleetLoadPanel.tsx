import React, { useEffect, useState } from 'react';

interface Worker {
  pid: number;
  role: string;
  cpu: string;
  mem: string;
  nice: number;
  elapsed: string;
}

interface FleetLoadData {
  workers: Worker[];
  throttleMode: 'normal' | 'paused';
}

const FleetLoadPanel: React.FC = () => {
  const [data, setData] = useState<FleetLoadData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshInterval, setRefreshInterval] = useState<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        const response = await fetch('/api/fleet/load');
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const json: FleetLoadData = await response.json();
        setData(json);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 5000); // refresh every 5 seconds
    setRefreshInterval(interval);

    return () => {
      if (refreshInterval) {
        clearInterval(refreshInterval);
      }
    };
  }, []);

  const handleAction = async (pid: number, action: string) => {
    try {
      const response = await fetch(`/api/fleet/load/${pid}/action`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      // Refetch data after action
      const response2 = await fetch('/api/fleet/load');
      if (!response2.ok) {
        throw new Error(`HTTP ${response2.status}`);
      }
      const json: FleetLoadData = await response2.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleThrottleChange = async (mode: 'normal' | 'paused') => {
    try {
      const response = await fetch('/api/fleet/throttle', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ mode }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      // Refetch data to update throttle mode
      const response2 = await fetch('/api/fleet/load');
      if (!response2.ok) {
        throw new Error(`HTTP ${response2.status}`);
      }
      const json: FleetLoadData = await response2.json();
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  if (error) {
    return <div className="fleet-load-panel">Error: {error}</div>;
  }

  if (!data) {
    return <div className="fleet-load-panel">Loading fleet load data...</div>;
  }

  return (
    <div className="fleet-load-panel">
      <h3>Fleet Load & Throttle</h3>
      <div className="throttle-status">
        Throttle mode: 
        <strong>{data.throttleMode === 'paused' ? 'PAUSED' : 'NORMAL'}</strong>
        &nbsp;
        <button 
          onClick={() => handleThrottleChange(data.throttleMode === 'paused' ? 'normal' : 'paused')}
          disabled={data.throttleMode === 'paused' ? false : false}
        >
          {data.throttleMode === 'paused' ? 'Resume' : 'Pause'}
        </button>
      </div>
      <table className="fleet-load-table">
        <thead>
          <tr>
            <th>PID</th>
            <th>Role</th>
            <th>CPU (%)</th>
            <th>MEM (%)</th>
            <th>Nice</th>
            <th>Elapsed</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {data.workers.map((worker) => (
            <tr key={worker.pid}>
              <td>{worker.pid}</td>
              <td>{worker.role}</td>
              <td>{worker.cpu}</td>
              <td>{worker.mem}</td>
              <td>{worker.nice}</td>
              <td>{worker.elapsed}</td>
              <td>
                <button 
                  onClick={() => handleAction(worker.pid, 'renice')}
                  title="Increase nice to 10 (lower priority)"
                >
                  Renice
                </button>
                <button 
                  onClick={() => handleAction(worker.pid, 'pause')}
                  title="Pause worker (SIGSTOP)"
                  disabled={false}
                >
                  Pause
                </button>
                <button 
                  onClick={() => handleAction(worker.pid, 'resume')}
                  title="Resume worker (SIGCONT)"
                  disabled={false}
                >
                  Resume
                </button>
                <button 
                  onClick={() => handleAction(worker.pid, 'kill')}
                  title="Terminate worker (SIGTERM)"
                  disabled={false}
                >
                  Kill
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

export default FleetLoadPanel;
