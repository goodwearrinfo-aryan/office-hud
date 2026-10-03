import { useLive } from '../api';
import AutopilotPanel from './AutopilotPanel';
import FleetPerformancePanel from './FleetPerformancePanel';

export default function OpsFloor() {
  return (
    <div className="h-full overflow-auto p-4">
      <h2 className="font-mono text-hud-amber text-lg mb-4">F9 · 24x7 OPS</h2>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">LAUNCHD SERVICES</h3>
          <div className="space-y-2 text-sm">
            <div className="panel p-3 flex items-center justify-between">
              <span className="text-hud-dim">com.openalice.office-manager</span>
              <span className="badge badge-success">RUNNING</span>
            </div>
            <div className="panel p-3 flex items-center justify-between">
              <span className="text-hud-dim">com.openalice.free-harness</span>
              <span className="badge badge-success">RUNNING</span>
            </div>
            <div className="panel p-3 flex items-center justify-between">
              <span className="text-hud-dim">com.openalice.localai</span>
              <span className="badge badge-success">RUNNING</span>
            </div>
            <div className="panel p-3 flex items-center justify-between">
              <span className="text-hud-dim">com.openalice.recovery-engine</span>
              <span className="badge badge-success">RUNNING</span>
            </div>
          </div>
        </div>
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">HEALTH CHECKS</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between text-xs">
              <span className="text-hud-dim">FreeHarness API</span>
              <span className="badge badge-success">HEALTHY</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-hud-dim">NVIDIA NIM</span>
              <span className="badge badge-success">HEALTHY</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-hud-dim">Groq API</span>
              <span className="badge badge-success">HEALTHY</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-hud-dim">OpenRouter</span>
              <span className="badge badge-success">HEALTHY</span>
            </div>
            <div className="flex items-center justify-between text-xs">
              <span className="text-hud-dim">LocalAI</span>
              <span className="badge badge-warning">CHECKING</span>
            </div>
          </div>
        </div>
        <div className="panel p-4">
          <h3 className="font-mono text-hud-amber text-sm mb-3">CRON / ADHERENCE</h3>
          <div className="text-hud-dim text-xs">Loading cron status...</div>
        </div>
      </div>

      <div className="panel p-4">
        <h3 className="font-mono text-hud-amber text-sm mb-3">API KEY VAULT</h3>
        <div className="space-y-2 text-sm">
          <div className="panel p-3 flex items-center justify-between">
            <div>
              <div className="font-mono text-xs">NVIDIA_API_KEY</div>
              <div className="text-xs text-hud-dim">****7q (key 1 of 6)</div>
            </div>
            <span className="badge badge-success">ACTIVE</span>
          </div>
          <div className="panel p-3 flex items-center justify-between">
            <div>
              <div className="font-mono text-xs">GROQ_API_KEY</div>
              <div className="text-xs text-hud-dim">****u9N6 (key 1 of 1)</div>
            </div>
            <span className="badge badge-success">ACTIVE</span>
          </div>
          <div className="panel p-3 flex items-center justify-between">
            <div>
              <div className="font-mono text-xs">OPENROUTER_API_KEY</div>
              <div className="text-xs text-hud-dim">Not configured</div>
            </div>
            <span className="badge badge-warning">MISSING</span>
          </div>
        </div>
      </div>

      {/*
        The 24/7 self-improvement loop and the fleet roll-up. Both were built
        earlier and had no surface anywhere in the UI, so neither could be seen
        or operated from the HUD at all — this floor is where an operator acts on
        them.
      */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 mt-4">
        <AutopilotPanel />
        <FleetPerformancePanel />
      </div>
    </div>
  );
}