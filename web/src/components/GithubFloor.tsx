import { useState } from 'react';
import { useLive, type JarvisPreview } from '../api';
import { canDispatch, previewJarvisCommand, routeJarvisCommand, writeErrorReason } from '../jarvisPreview';

interface GitState {
  branch: string | null;
  head: string | null;
  dirty: number | null;
  ahead: number | null;
  behind: number | null;
  lastCommitAgeSec: number | null;
}

interface PullRequest {
  number: number;
  title: string;
  author: string | null;
  draft: boolean;
  review: string | null;
  checks: 'passing' | 'failing' | 'pending' | 'none';
  url: string | null;
}

interface Issue {
  number: number;
  title: string;
  labels: string[];
  assignees: string[];
  url: string | null;
}

interface Run {
  workflow: string | null;
  status: string | null;
  conclusion: string | null;
  branch: string | null;
  url: string | null;
}

interface GithubRepo {
  id: string;
  localPath: string | null;
  gh: boolean;
  git: GitState | null;
  prs: PullRequest[];
  issues: Issue[];
  runs: Run[];
  error: string | null;
  counts: { prs: number; issues: number; runs: number; failing: number };
}

interface GithubSnapshot {
  disabled: boolean;
  configured: boolean;
  generatedAt: number | null;
  ageSec: number | null;
  poll: { lastSuccessAt: number | null; lastError: string | null; failures: number; nextPollAt: number | null; deferred: boolean };
  auth: { ok: boolean | null; account: string | null };
  warnings: { kind: string; text: string }[];
  totals: { repos: number; prs: number; issues: number; failing: number };
  repos: GithubRepo[];
}

interface QueueTarget {
  key: string;
  prompt: string;
}

function ageLabel(seconds: number | null | undefined): string {
  if (seconds == null) return 'never';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function checkDot(checks: PullRequest['checks']): string {
  if (checks === 'failing') return 'bg-hud-red';
  if (checks === 'pending') return 'bg-hud-amber';
  if (checks === 'passing') return 'bg-hud-green';
  return 'bg-hud-dim';
}

function runTone(run: Run): string {
  if (run.conclusion === 'failure' || run.conclusion === 'timed_out') return 'bg-hud-red';
  if (run.conclusion === 'success') return 'bg-hud-green';
  if (run.status && run.status !== 'completed') return 'bg-hud-amber';
  return 'bg-hud-dim';
}

export default function GithubFloor() {
  const { data, error } = useLive<GithubSnapshot>('/api/github');
  const [queued, setQueued] = useState<Record<string, boolean>>({});
  const [target, setTarget] = useState<QueueTarget | null>(null);
  const [preview, setPreview] = useState<JarvisPreview | null>(null);
  const [judging, setJudging] = useState(false);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const openIssue = (repo: string, issue: Issue) => {
    const key = `${repo}#${issue.number}`;
    setTarget({
      key,
      prompt: `GitHub issue ${key}: ${issue.title}${issue.url ? ` — ${issue.url}` : ''}`,
    });
    setPreview(null);
    setWord('');
    setNote(null);
    setJudging(true);
    void previewJarvisCommand({ prompt: `GitHub issue ${key}: ${issue.title}`, priority: 'high' })
      .then((judged) => setPreview(judged))
      .finally(() => setJudging(false));
  };

  const cancelQueue = () => {
    setTarget(null);
    setPreview(null);
    setWord('');
    setNote(null);
  };

  const sendQueue = async () => {
    if (!target) return;
    const verdict = canDispatch(preview, word);
    if (!verdict.allowed) {
      setNote(verdict.reason);
      return;
    }
    setBusy(true);
    try {
      const result = await routeJarvisCommand({ prompt: target.prompt, priority: 'high' }, preview, word, 'high');
      if (result.ok) {
        setQueued((prev) => ({ ...prev, [target.key]: true }));
        setNote(`Queued to ${result.data?.task?.task_id ?? 'the task store'}.`);
        setTarget(null);
        setPreview(null);
        setWord('');
      } else {
        setNote(writeErrorReason(result));
      }
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return <div className="panel p-4 text-hud-red">GitHub snapshot unavailable: {error}</div>;
  }
  if (!data) {
    return <div className="panel p-4 text-hud-dim">Reading the GitHub snapshot…</div>;
  }

  const disabled = data.disabled;
  const blockedReason = disabled ? 'The GitHub probe is disabled on this host.'
    : !data.configured ? (data.warnings[0]?.text || 'No repos are configured for this host.')
      : null;

  return (
    <div className="space-y-4">
      <div className="panel p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="font-mono text-sm text-hud-amber tracking-widest">GITHUB</div>
            <div className="mt-1 text-[10px] font-mono text-hud-dim">
              {data.totals.repos} repos · {data.totals.prs} open PRs · {data.totals.issues} open issues · {data.totals.failing} failing runs
              {' · '}{data.auth.account ?? 'gh not checked'}{' · '}synced {ageLabel(data.ageSec)}
            </div>
          </div>
          <div className="text-right text-[10px] font-mono text-hud-dim">
            <div>{data.poll.deferred ? 'deferred (load)' : 'polling every 3m'}</div>
            <div>{data.poll.lastError ? `last error: ${data.poll.lastError}` : 'last poll ok'}</div>
          </div>
        </div>
        {data.warnings.map((warning) => (
          <div key={warning.kind} className="mt-2 text-[10px] font-mono text-hud-amber">{warning.text}</div>
        ))}
      </div>

      {blockedReason && (
        <div className="panel p-4 text-[11px] font-mono text-hud-dim">{blockedReason}</div>
      )}

      {target && (
        <div className="panel p-3 border border-hud-amber/40">
          <div className="text-[10px] font-mono text-hud-amber">QUEUE {target.key}</div>
          <div className="mt-1 text-[10px] font-mono text-hud-dim break-all">{target.prompt}</div>
          <div className="mt-2 text-[10px] font-mono text-hud-dim">
            {judging ? 'Judging the command…' : preview
              ? `${preview.risk === 'destructive' ? 'DESTRUCTIVE' : 'OPS TASK'} · ${preview.assigned_agent ?? 'JEV auto-route'}${preview.requires_type_confirmation ? ' · type EXECUTE' : ''}`
              : 'No verdict — the office could not judge this command.'}
          </div>
          {preview?.requires_type_confirmation && (
            <input
              value={word}
              onChange={(event) => setWord(event.target.value)}
              placeholder="EXECUTE"
              className="mt-2 w-40 bg-hud-bg border border-hud-edge px-2 py-1 text-[11px] font-mono text-hud-text"
            />
          )}
          {note && <div className="mt-2 text-[10px] font-mono text-hud-red">{note}</div>}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={sendQueue}
              disabled={busy || judging || !canDispatch(preview, word).allowed}
              className="px-2 py-1 text-[10px] font-mono border border-hud-edge text-hud-text disabled:text-hud-dim disabled:border-hud-edge/40"
              title={canDispatch(preview, word).reason ?? 'Queue this issue through /api/jarvis/command'}
            >
              {busy ? 'QUEUEING…' : 'QUEUE AS TASK'}
            </button>
            <button type="button" onClick={cancelQueue} className="px-2 py-1 text-[10px] font-mono border border-hud-edge text-hud-dim">CANCEL</button>
          </div>
        </div>
      )}

      {note && !target && (
        <div className="panel p-3 text-[10px] font-mono text-hud-dim">{note}</div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {data.repos.map((repo) => (
          <div key={repo.id} className="panel p-3">
            <div className="flex items-baseline justify-between gap-3">
              <div className="text-[11px] font-mono text-hud-text">{repo.id}</div>
              <div className="text-[9px] font-mono text-hud-dim text-right">
                {repo.git
                  ? `${repo.git.branch ?? 'detached'} · ${repo.git.head ?? 'no head'} · ${repo.git.dirty ?? '?'} dirty${repo.git.ahead != null || repo.git.behind != null ? ` · ↑${repo.git.ahead ?? '?'} ↓${repo.git.behind ?? '?'}` : ''} · last commit ${ageLabel(repo.git.lastCommitAgeSec)}`
                  : repo.localPath ? 'git unreadable' : 'no local checkout'}
              </div>
            </div>

            {!repo.gh && <div className="mt-1 text-[9px] font-mono text-hud-dim">local git only — this gh account cannot read the repo</div>}
            {repo.error && <div className="mt-1 text-[9px] font-mono text-hud-amber break-all">{repo.error}</div>}

            <div className="mt-2 space-y-1">
              {repo.prs.map((pr) => (
                <div key={`pr-${pr.number}`} className="flex items-center gap-2 text-[10px] font-mono">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${checkDot(pr.checks)}`} />
                  <span className="text-hud-dim">#{pr.number}</span>
                  <span className="text-hud-text truncate">{pr.title}</span>
                  <span className="text-hud-dim shrink-0">
                    {pr.draft ? 'draft' : pr.review ?? ''}{pr.checks !== 'none' ? ` · ${pr.checks}` : ''}
                  </span>
                </div>
              ))}
              {repo.issues.map((issue) => {
                const key = `${repo.id}#${issue.number}`;
                return (
                  <div key={`issue-${issue.number}`} className="flex items-center gap-2 text-[10px] font-mono">
                    <span className="text-hud-dim">#{issue.number}</span>
                    <span className="text-hud-text truncate">{issue.title}</span>
                    {issue.labels.map((label) => (
                      <span key={label} className="text-[8px] px-1 border border-hud-edge text-hud-blue shrink-0">{label}</span>
                    ))}
                    <button
                      type="button"
                      onClick={() => openIssue(repo.id, issue)}
                      disabled={Boolean(queued[key])}
                      className="ml-auto shrink-0 px-1.5 py-0.5 text-[9px] font-mono border border-hud-edge text-hud-amber disabled:text-hud-dim disabled:border-hud-edge/40"
                    >
                      {queued[key] ? 'QUEUED' : 'QUEUE'}
                    </button>
                  </div>
                );
              })}
              {repo.runs.map((run, index) => (
                <div key={`run-${index}`} className="flex items-center gap-2 text-[10px] font-mono text-hud-dim">
                  <span className={`inline-block w-1.5 h-1.5 rounded-full ${runTone(run)}`} />
                  <span className="text-hud-text truncate">{run.workflow ?? 'run'}</span>
                  <span className="shrink-0">{run.conclusion ?? run.status ?? ''}{run.branch ? ` · ${run.branch}` : ''}</span>
                </div>
              ))}
              {repo.prs.length === 0 && repo.issues.length === 0 && repo.runs.length === 0 && !repo.error && (
                <div className="text-[10px] font-mono text-hud-dim">nothing open</div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
