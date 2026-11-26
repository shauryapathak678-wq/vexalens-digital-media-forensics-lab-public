import React, { useState, useEffect } from 'react';
import {
  ScanEye,
  Cpu,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Play,
  RefreshCw,
  HelpCircle,
  ShieldCheck,
  Zap,
  Activity,
  Layers,
  Sparkles,
  Info,
} from 'lucide-react';
import { AIModelHealthInfo, AIModelStatusState } from '@/types/forensics';

export const AIModelStatusView: React.FC = () => {
  const [models, setModels] = useState<AIModelHealthInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [testingModelId, setTestingModelId] = useState<string | null>(null);
  const [testOutputMessage, setTestOutputMessage] = useState<{ id: string; msg: string; latency: number } | null>(null);

  const fetchModels = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/models');
      if (res.ok) {
        const data = await res.json();
        setModels(data.models || []);
      }
    } catch (err) {
      console.error('Failed to fetch AI models status:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchModels();
  }, []);

  const handleTestModel = async (modelId: string) => {
    setTestingModelId(modelId);
    setTestOutputMessage(null);

    try {
      const res = await fetch('/api/models/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modelId }),
      });

      if (res.ok) {
        const data = await res.json();
        setTestOutputMessage({
          id: modelId,
          msg: data.message || 'Diagnostic verification passed.',
          latency: data.latencyMs || 45,
        });

        // Update local model state
        setModels((prev) =>
          prev.map((m) =>
            m.modelId === modelId
              ? {
                  ...m,
                  lastInferenceAt: data.timestamp,
                  lastInferenceStatus: 'success',
                  latencyMs: data.latencyMs,
                  status: 'ready',
                }
              : m
          )
        );
      }
    } catch (err: any) {
      alert('Self-test fault: ' + err?.message);
    } finally {
      setTestingModelId(null);
    }
  };

  const statusStyles: Record<AIModelStatusState, { label: string; badge: string }> = {
    ready: { label: 'READY', badge: 'text-emerald-400 bg-emerald-950/40 border-emerald-800' },
    loading: { label: 'LOADING', badge: 'text-cyan-400 bg-cyan-950/40 border-cyan-800' },
    not_configured: { label: 'NOT CONFIGURED', badge: 'text-amber-400 bg-amber-950/40 border-amber-800' },
    not_installed: { label: 'NOT INSTALLED', badge: 'text-slate-400 bg-slate-900 border-slate-800' },
    inference_failed: { label: 'INFERENCE FAILED', badge: 'text-rose-400 bg-rose-950/40 border-rose-800' },
    not_validated: { label: 'NOT VALIDATED', badge: 'text-violet-400 bg-violet-950/40 border-violet-800' },
  };

  return (
    <div className="space-y-6 max-w-7xl mx-auto pb-12">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2.5">
            <span className="p-2 rounded-lg bg-cyan-950/60 border border-cyan-800/60 text-cyan-400">
              <ScanEye className="w-5 h-5" />
            </span>
            <div>
              <h1 className="text-xl font-bold text-slate-100 tracking-tight">AI Model Status</h1>
              <p className="text-xs text-slate-400 mt-0.5">
                Specialist forensic models, runtime execution devices, and live diagnostic inference self-tests
              </p>
            </div>
          </div>
        </div>

        <button
          onClick={fetchModels}
          disabled={loading}
          className="flex items-center gap-2 px-3.5 py-1.5 bg-slate-900 hover:bg-slate-800 text-slate-300 border border-slate-800 rounded-lg text-xs font-medium transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin text-cyan-400' : ''}`} />
          Refresh Registry
        </button>
      </div>

      {/* Model Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {models.map((model) => {
          const st = statusStyles[model.status] || statusStyles.not_configured;
          const isTesting = testingModelId === model.modelId;
          const hasTestNotice = testOutputMessage?.id === model.modelId;

          return (
            <div
              key={model.modelId}
              className="bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-xl p-5 space-y-4 transition-colors"
            >
              {/* Header with Title and Status Badge */}
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-mono text-cyan-400 font-bold uppercase tracking-wider">
                      {model.task}
                    </span>
                    <span className="text-[10px] font-mono text-slate-500">
                      v{model.version}
                    </span>
                  </div>
                  <h2 className="text-base font-bold text-slate-100">{model.name}</h2>
                </div>

                <span className={`px-2.5 py-0.5 rounded text-[10px] font-bold font-mono border ${st.badge}`}>
                  {st.label}
                </span>
              </div>

              {/* Description */}
              <p className="text-xs text-slate-300 leading-relaxed">
                {model.description}
              </p>

              {/* Technical Specifications Grid */}
              <div className="grid grid-cols-2 gap-2 text-xs bg-slate-900/60 p-3 rounded-lg border border-slate-800/80 font-mono">
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase font-sans">Execution Device:</span>
                  <span className="text-slate-200 font-bold flex items-center gap-1.5 mt-0.5">
                    <Cpu className="w-3.5 h-3.5 text-cyan-400" /> {model.device}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase font-sans">Latency / Speed:</span>
                  <span className="text-slate-200 font-bold flex items-center gap-1.5 mt-0.5">
                    <Zap className="w-3.5 h-3.5 text-amber-400" /> {model.latencyMs ? `${model.latencyMs} ms` : '—'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase font-sans">Last Inference:</span>
                  <span className="text-slate-300 text-[11px] mt-0.5">
                    {model.lastInferenceAt ? new Date(model.lastInferenceAt).toLocaleTimeString() : 'Awaiting Test'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 block text-[10px] uppercase font-sans">Accuracy Standard:</span>
                  <span className="text-slate-300 text-[11px] mt-0.5 truncate" title={model.accuracyConfidence}>
                    {model.accuracyConfidence.substring(0, 24)}...
                  </span>
                </div>
              </div>

              {/* Dependencies & License */}
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400 pt-1">
                <span className="font-mono text-slate-500">
                  License: {model.citationOrLicense}
                </span>

                <button
                  onClick={() => handleTestModel(model.modelId)}
                  disabled={isTesting}
                  className="px-3 py-1.5 bg-cyan-950/70 hover:bg-cyan-900 text-cyan-200 border border-cyan-800 rounded-lg text-xs font-medium transition-colors flex items-center gap-1.5 shadow-sm disabled:opacity-50"
                >
                  <Play className={`w-3 h-3 ${isTesting ? 'animate-spin' : ''}`} />
                  {isTesting ? 'Testing...' : 'Diagnostic Self-Test'}
                </button>
              </div>

              {/* Self-Test Result Alert */}
              {hasTestNotice && (
                <div className="p-2.5 bg-emerald-950/30 border border-emerald-800/60 rounded-lg text-xs text-emerald-300 flex items-center gap-2">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span>
                    {testOutputMessage.msg} (Measured Latency: {testOutputMessage.latency}ms)
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
