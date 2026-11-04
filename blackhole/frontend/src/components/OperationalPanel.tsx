import React from 'react';
import type { ApiClient, AppConfig, RuntimeDiscovery, RuntimeStatus, TranslateFn, UsageSummary } from '../types.ts';

const OperationalPanel = React.memo(function OperationalPanel({
  view,
  client,
  workspacePath,
  config,
  runtimeStatus,
  runtimeDiscovery,
  setIsOpenSettingsModal,
  setSettingsActiveTab,
  handleRunPreflight,
  handleStartLlamaRuntime,
  handleSelectGgufFile,
  detectInstalledIdes,
  integrateAndLaunchIde,
  fetchFiles,
  t
}: {
  view: string;
  client: ApiClient | null;
  workspacePath: string;
  config: AppConfig;
  runtimeStatus: RuntimeStatus | null;
  runtimeDiscovery: RuntimeDiscovery;
  setIsOpenSettingsModal: (open: boolean) => void;
  setSettingsActiveTab: (tab: string) => void;
  handleRunPreflight: () => void;
  handleStartLlamaRuntime: () => void;
  handleSelectGgufFile: () => void;
  detectInstalledIdes: () => void;
  integrateAndLaunchIde: () => void;
  fetchFiles: () => void;
  locale?: string;
  t: TranslateFn;
}) {
  if (view === 'setup') {
    return (
      <SetupPanel
        workspacePath={workspacePath}
        config={config}
        runtimeStatus={runtimeStatus}
        runtimeDiscovery={runtimeDiscovery}
        setIsOpenSettingsModal={setIsOpenSettingsModal}
        setSettingsActiveTab={setSettingsActiveTab}
        handleRunPreflight={handleRunPreflight}
        handleStartLlamaRuntime={handleStartLlamaRuntime}
        handleSelectGgufFile={handleSelectGgufFile}
        detectInstalledIdes={detectInstalledIdes}
        integrateAndLaunchIde={integrateAndLaunchIde}
        t={t}
      />
    );
  }

  if (view === 'review') {
    return <DiffReviewPanel client={client} fetchFiles={fetchFiles} t={t} />;
  }

  if (view === 'reports') {
    return <BenchmarkReportPanel client={client} config={config} t={t} />;
  }

  if (view === 'ci') {
    return <CiCheckPanel client={client} t={t} />;
  }

  return null;
});

export default OperationalPanel;

function PanelShell({ title, description, children }: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="ops-panel">
      <div className="ops-header">
        <div>
          <h3>{title}</h3>
          {description && <p>{description}</p>}
        </div>
      </div>
      {children}
    </div>
  );
}

function StatusRow({ ok, label, detail, action }: {
  ok: boolean;
  label: string;
  detail: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div className={`ops-row ${ok ? 'ok' : 'warn'}`}>
      <span className={`ops-pill ${ok ? 'ok' : 'warn'}`}>{ok ? 'OK' : 'WAIT'}</span>
      <div className="ops-row-copy">
        <strong>{label}</strong>
        <small>{detail}</small>
      </div>
      <div className="ops-row-action">{action}</div>
    </div>
  );
}

function SetupPanel({
  workspacePath,
  config,
  runtimeStatus,
  runtimeDiscovery,
  setIsOpenSettingsModal,
  setSettingsActiveTab,
  handleRunPreflight,
  handleStartLlamaRuntime,
  handleSelectGgufFile,
  detectInstalledIdes,
  integrateAndLaunchIde,
  t
}: {
  workspacePath: string;
  config: AppConfig;
  runtimeStatus: RuntimeStatus | null;
  runtimeDiscovery: RuntimeDiscovery;
  setIsOpenSettingsModal: (open: boolean) => void;
  setSettingsActiveTab: (tab: string) => void;
  handleRunPreflight: () => void;
  handleStartLlamaRuntime: () => void;
  handleSelectGgufFile: () => void;
  detectInstalledIdes: () => void;
  integrateAndLaunchIde: () => void;
  t: TranslateFn;
}) {
  const openSettingsTab = (tab: string) => {
    setSettingsActiveTab(tab);
    setIsOpenSettingsModal(true);
  };

  return (
    <PanelShell title={t('firstRunSetup')} description={t('setupGuide')}>
      <StatusRow
        ok={Boolean(workspacePath)}
        label={t('workspaceSelected')}
        detail={workspacePath || t('noWorkspaceSelected')}
        action={<button className="btn-save-settings" type="button" onClick={() => openSettingsTab('workspace')}>{t('openSettings')}</button>}
      />
      <StatusRow
        ok={Boolean(config?.llamaCppServerPath || (runtimeDiscovery?.servers || []).length)}
        label={t('llamaServerAvailable')}
        detail={config?.llamaCppServerPath || t('useSettingsGguf')}
        action={<button className="btn-save-settings" type="button" onClick={() => openSettingsTab('gguf')}>{t('openSettings')}</button>}
      />
      <StatusRow
        ok={Boolean(config?.llamaCppModelPath)}
        label={t('ggufModelSelected')}
        detail={config?.llamaCppModelPath || t('modelUnselected')}
        action={<button className="btn-save-settings" type="button" onClick={handleSelectGgufFile}>{t('chooseGgufModel')}</button>}
      />
      <StatusRow
        ok={Boolean(runtimeStatus?.healthy)}
        label={t('runtimeReachable')}
        detail={runtimeStatus?.healthy ? runtimeStatus.baseUrl : t('notRunning')}
        action={<button className="btn-save-settings" type="button" onClick={runtimeStatus?.healthy ? handleRunPreflight : handleStartLlamaRuntime}>{runtimeStatus?.healthy ? t('runPreflight') : t('startRuntime')}</button>}
      />
      <StatusRow
        ok={false}
        label={t('ideBridgeReady')}
        detail={t('detectIde')}
        action={(
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-save-settings" type="button" onClick={detectInstalledIdes}>{t('detectIde')}</button>
            <button className="btn-save-settings" type="button" onClick={integrateAndLaunchIde}>{t('installVsCodeBridge')}</button>
          </div>
        )}
      />
    </PanelShell>
  );
}

interface DiffTransaction {
  id: string;
  status?: string;
  operations?: Array<{ path?: string; filePath?: string; type?: string; kind?: string; diff?: string; content?: string; replace?: string }>;
  preview?: { operations?: Array<{ path?: string; filePath?: string; type?: string; kind?: string; diff?: string; content?: string; replace?: string }> };
}

function DiffReviewPanel({ client, fetchFiles, t }: {
  client: ApiClient | null;
  fetchFiles: () => void;
  t: TranslateFn;
}) {
  const [transactions, setTransactions] = React.useState<DiffTransaction[]>([]);
  const [selected, setSelected] = React.useState<DiffTransaction | null>(null);
  const [status, setStatus] = React.useState('');

  const refreshTransactions = React.useCallback(async () => {
    if (!client) return;
    try {
      const data = await client.request('/diff/transactions?limit=30');
      setTransactions((data.transactions || []) as DiffTransaction[]);
      setSelected(prev => prev || ((data.transactions || [])[0] as DiffTransaction) || null);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }, [client]);

  React.useEffect(() => {
    refreshTransactions();
  }, [refreshTransactions]);

  const act = async (action: string) => {
    if (!client || !selected) return;
    setStatus('');
    try {
      const data = await client.request(`/diff/transactions/${selected.id}/${action}`, { method: 'POST' });
      setSelected((data.transaction || null) as DiffTransaction | null);
      await refreshTransactions();
      fetchFiles?.();
      setStatus(`${action}: ${data.transaction?.status || 'ok'}`);
    } catch (error) {
      setStatus((error as Error).message);
    }
  };

  return (
    <PanelShell title={t('diffReview')} description={t('diffReviewDesc')}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
        <button className="btn-save-settings" type="button" onClick={refreshTransactions}>{t('refresh')}</button>
        {status && <span style={{ color: status.includes('error') ? '#f87171' : 'var(--text-secondary)', fontSize: 12 }}>{status}</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '170px 1fr', gap: 10, minHeight: 0 }}>
        <div style={{ display: 'grid', gap: 6, alignContent: 'start' }}>
          {transactions.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{t('noTransactionSelected')}</div>}
          {transactions.map(transaction => (
            <button
              key={transaction.id}
              className={`settings-modal-tab ${selected?.id === transaction.id ? 'active' : ''}`}
              type="button"
              onClick={() => setSelected(transaction)}
              style={{ textAlign: 'left' }}
            >
              <div>{transaction.status || 'pending'}</div>
              <small>{transaction.id}</small>
            </button>
          ))}
        </div>
        <div style={{ minWidth: 0 }}>
          {selected ? (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                <button className="btn-save-settings" type="button" onClick={() => act('accept')}>{t('accept')}</button>
                <button className="btn-save-settings" type="button" onClick={() => act('reject')}>{t('reject')}</button>
                <button className="btn-save-settings" type="button" onClick={() => act('rollback')}>{t('rollback')}</button>
              </div>
              <DiffPreview transaction={selected} t={t} />
            </>
          ) : (
            <div style={{ color: 'var(--text-secondary)' }}>{t('noTransactionSelected')}</div>
          )}
        </div>
      </div>
    </PanelShell>
  );
}

function DiffPreview({ transaction, t }: { transaction: DiffTransaction; t: TranslateFn }) {
  const operations = transaction.operations || transaction.preview?.operations || [];
  if (operations.length === 0) {
    return <div style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{t('noPreviewDetails')}</div>;
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {operations.map((operation, index) => (
        <div key={`${operation.path || index}-${index}`} style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '8px 10px', background: 'rgba(255,255,255,0.04)', color: 'var(--accent-cyan)', fontWeight: 700 }}>
            {operation.type || operation.kind || 'patch'} - {operation.path || operation.filePath || '-'}
          </div>
          <pre style={{ margin: 0, padding: 10, whiteSpace: 'pre-wrap', color: 'var(--text-secondary)' }}>
            {operation.diff || operation.content || operation.replace || JSON.stringify(operation, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  );
}

interface BenchmarkRow {
  model: string;
  bestSolveRate?: number;
  bestPassAt1?: number;
}

function BenchmarkReportPanel({ client, config, t }: {
  client: ApiClient | null;
  config: AppConfig;
  t: TranslateFn;
}) {
  const [report, setReport] = React.useState<{ models?: BenchmarkRow[] } | null>(null);
  const [autocompleteReport, setAutocompleteReport] = React.useState<{ models?: BenchmarkRow[] } | null>(null);
  const [repoReport, setRepoReport] = React.useState<{ fixtures?: { prepared?: number }; prepared?: number; solveRate?: string } | null>(null);
  const [proofReport, setProofReport] = React.useState<{ latest?: ProofLatest; latestPath?: string } | null>(null);
  const [status, setStatus] = React.useState('');

  const loadReports = React.useCallback(async () => {
    if (!client) return;
    try {
      const [modelData, autocompleteData, repoData, proofData] = await Promise.all([
        client.request('/reports/model-benchmarks'),
        client.request('/reports/autocomplete-benchmarks'),
        client.request('/reports/real-repo-eval'),
        client.request('/reports/proof')
      ]);
      setReport(modelData);
      setAutocompleteReport(autocompleteData);
      setRepoReport(repoData);
      setProofReport(proofData);
    } catch (error) {
      setStatus((error as Error).message);
    }
  }, [client]);

  React.useEffect(() => {
    loadReports();
  }, [loadReports]);

  const runReport = async (path: string, body: unknown, doneMessage: string) => {
    if (!client) return;
    setStatus(t('testing'));
    try {
      await client.request(path, { method: 'POST', body: JSON.stringify(body) });
      await loadReports();
      setStatus(doneMessage);
    } catch (error) {
      setStatus((error as Error).message);
    }
  };

  return (
    <PanelShell title={t('modelBenchmarkReport')}>
      <UsagePanel client={client} t={t} />
      <div className="ops-actions">
        <button className="btn-save-settings" type="button" onClick={() => runReport('/reports/e2e-eval', { maxCases: 50, realModel: false, modelPath: config?.llamaCppModelPath }, t('runE2E'))}>{t('runE2E')}</button>
        <button className="btn-save-settings" type="button" onClick={() => runReport('/reports/autocomplete-benchmark', { maxCases: 20, realModel: false, modelPath: config?.llamaCppModelPath }, t('runAutocompleteBenchmark'))}>{t('runAutocompleteBenchmark')}</button>
        <button className="btn-save-settings" type="button" onClick={() => runReport('/reports/real-repo-eval', { prepare: false, maxRepos: 12 }, t('refreshRepoSummary'))}>{t('refreshRepoSummary')}</button>
        <button className="btn-save-settings" type="button" onClick={() => runReport('/reports/proof', { full: false, maxCases: 12, soakMinutes: 0.25 }, 'Proof pipeline complete')}>Run Proof</button>
        <button className="btn-save-settings" type="button" onClick={() => runReport('/reports/proof', { full: false, realModels: true, maxModels: 1, realModelCases: 3, soakMinutes: 0.25 }, 'Model proof complete')}>Run Model Proof</button>
        <button className="btn-save-settings" type="button" onClick={loadReports}>{t('refresh')}</button>
      </div>
      {status && <div className="ops-status">{status}</div>}

      <ProofSummary proofReport={proofReport} />
      <ReportSection title={t('agentSolveRate')} empty={t('noBenchmarkRecords')} rows={report?.models || []} valueKey="bestSolveRate" />
      <ReportSection title={t('autocompleteQuality')} empty={t('noAutocompleteRecords')} rows={autocompleteReport?.models || []} valueKey="bestPassAt1" />
      <div className="ops-card">
        <div className="ops-card-title">{t('realRepoEvaluation')}</div>
        <div className="ops-muted">
          {t('fixturesPrepared')}: {repoReport?.fixtures?.prepared ?? repoReport?.prepared ?? '-'} / {t('realRepoSolveRate')}: {repoReport?.solveRate ?? '-'}
        </div>
      </div>
    </PanelShell>
  );
}

function UsagePanel({ client, t }: { client: ApiClient | null; t: TranslateFn }) {
  const [usage, setUsage] = React.useState<UsageSummary | null>(null);

  const loadUsage = React.useCallback(async () => {
    if (!client) return;
    try {
      const data = await client.request('/reports/usage');
      setUsage((data.usage || null) as UsageSummary | null);
    } catch {
      // Usage panel is informational; keep previous state on failure.
    }
  }, [client]);

  React.useEffect(() => {
    loadUsage();
  }, [loadUsage]);

  const resetUsage = async () => {
    if (!client) return;
    try {
      const data = await client.request('/reports/usage', { method: 'DELETE' });
      setUsage((data.usage || null) as UsageSummary | null);
    } catch {
      // Keep previous state on failure.
    }
  };

  const rows = Object.entries(usage?.byModel || {}).map(([model, stats]) => ({ model, ...stats }));
  const tagLabel = (tags?: Record<string, number>) => Object.entries(tags || {}).map(([tag, count]) => `${tag}×${count}`).join(' ');

  return (
    <div className="ops-card">
      <div className="ops-card-heading">
        <div className="ops-card-title violet">{t('usageTitle')}</div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn-save-settings" type="button" onClick={loadUsage}>{t('refresh')}</button>
          <button className="btn-save-settings" type="button" onClick={resetUsage}>{t('usageReset')}</button>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="ops-empty">{t('usageEmpty')}</div>
      ) : (
        <>
          {rows.map(row => (
            <div key={row.model} className="ops-metric-row" style={{ alignItems: 'flex-start' }}>
              <span style={{ flex: 1 }}>{row.model}<br /><small style={{ color: 'var(--text-secondary)' }}>{tagLabel(row.tags)}</small></span>
              <strong>{t('usageRequests')}: {row.requests} · {t('usageReported')}: {(row.totalTokens || 0).toLocaleString()} tok</strong>
            </div>
          ))}
          <div className="ops-muted">
            {t('usageReported')}: {(usage?.totals?.totalTokens || 0).toLocaleString()} tok
            (in {(usage?.totals?.promptTokens || 0).toLocaleString()} / out {(usage?.totals?.completionTokens || 0).toLocaleString()})
          </div>
          {Boolean(usage?.estimatedTotals?.requests) && <div className="ops-muted">{t('usageEstimated')}: ≈{usage?.estimatedTotals?.totalTokens.toLocaleString()} tok</div>}
          {Boolean(usage?.failedTotals?.requests) && <div className="ops-muted">{t('usageFailed')}: {usage?.failedTotals?.requests}</div>}
          {Boolean(usage?.legacyTotals?.requests) && <div className="ops-muted">{t('usageLegacy')}: ≈{usage?.legacyTotals?.totalTokens.toLocaleString()} tok</div>}
        </>
      )}
    </div>
  );
}

interface ProofLatest {
  ok?: boolean;
  score?: { passed: number; total: number; percent: number };
  dimensions?: Record<string, { ok?: boolean; level?: string }>;
  markdownPath?: string;
  recordPath?: string;
}

function ProofSummary({ proofReport }: { proofReport: { latest?: ProofLatest; latestPath?: string } | null }) {
  const latest = proofReport?.latest;
  const dimensions = latest?.dimensions || {};
  const dimensionRows: Array<[string, { ok?: boolean; level?: string } | undefined]> = [
    ['Model solve-rate', dimensions.modelSolveRate],
    ['Large repo durability', dimensions.largeRepoDurability],
    ['IDE UX', dimensions.ideUxCompleteness],
    ['Long-run stability', dimensions.longRunStability],
    ['Feedback loop', dimensions.feedbackLoop]
  ];

  return (
    <div className="ops-card proof-card">
      <div className="ops-card-heading">
        <div className="ops-card-title">Proof Report</div>
        <strong className={`ops-pill ${latest?.ok ? 'ok' : 'warn'}`}>
          {latest?.score ? `${latest.score.passed}/${latest.score.total} (${latest.score.percent}%)` : 'No run'}
        </strong>
      </div>
      {!latest ? (
        <div className="ops-empty">No recorded proof run yet.</div>
      ) : (
        <>
          <div className="proof-dimensions">
            {dimensionRows.map(([label, dimension]) => (
              <div key={label} className="proof-dimension">
                <span>{label}</span>
                <strong className={dimension?.ok ? 'ok' : 'warn'}>{dimension?.level || 'missing'}</strong>
              </div>
            ))}
          </div>
          <div className="ops-path">
            {latest.markdownPath || latest.recordPath || proofReport?.latestPath}
          </div>
        </>
      )}
    </div>
  );
}

function ReportSection({ title, empty, rows, valueKey }: {
  title: string;
  empty: string;
  rows: BenchmarkRow[];
  valueKey: 'bestSolveRate' | 'bestPassAt1';
}) {
  return (
    <div className="ops-card">
      <div className="ops-card-title violet">{title}</div>
      {rows.length === 0 ? (
        <div className="ops-empty">{empty}</div>
      ) : (
        rows.map(row => (
          <div key={row.model} className="ops-metric-row">
            <span>{row.model}</span>
            <strong>{Math.round(Number(row[valueKey] || 0) * 100)}%</strong>
          </div>
        ))
      )}
    </div>
  );
}

function CiCheckPanel({ client, t }: { client: ApiClient | null; t: TranslateFn }) {
  const [status, setStatus] = React.useState(t('idle'));
  const [result, setResult] = React.useState<{ ok: boolean; error?: string } | null>(null);

  const runCheck = async (full: boolean) => {
    if (!client) return;
    setStatus(t('prCheckRunning'));
    setResult(null);
    try {
      const data = await client.request('/reports/pr-check', {
        method: 'POST',
        body: JSON.stringify({ full, skipVsix: !full })
      });
      setResult(data);
      setStatus(data.ok ? t('pass') : t('fail'));
    } catch (error) {
      setResult({ ok: false, error: (error as Error).message });
      setStatus(t('fail'));
    }
  };

  return (
    <PanelShell title={t('ciPrCheck')} description={t('ciPrCheckDesc')}>
      <div className="ops-actions">
        <button className="btn-save-settings" type="button" onClick={() => runCheck(false)}>{t('runQuickPrCheck')}</button>
        <button className="btn-save-settings" type="button" onClick={() => runCheck(true)}>{t('runFullPrCheck')}</button>
      </div>
      <div className="ops-status strong">{status}</div>
      {result && (
        <pre className="ops-result">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </PanelShell>
  );
}
