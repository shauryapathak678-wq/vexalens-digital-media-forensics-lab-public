import React from 'react';
import { FindingSeverity, CaseStatus, CasePriority, DetectorVerdict } from '@/types/forensics';
import { AlertCircle, AlertTriangle, CheckCircle2, HelpCircle, Info, ShieldAlert, Sparkles } from 'lucide-react';

interface SeverityBadgeProps {
  severity: FindingSeverity;
  showIcon?: boolean;
}

export const SeverityBadge: React.FC<SeverityBadgeProps> = ({ severity, showIcon = true }) => {
  switch (severity) {
    case 'critical':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-400">
          {showIcon && <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />}
          <span>Critical Indicator</span>
        </span>
      );
    case 'high':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-orange-400">
          {showIcon && <AlertCircle className="w-3.5 h-3.5 text-orange-500 shrink-0" />}
          <span>High Anomaly</span>
        </span>
      );
    case 'medium':
    case 'warning':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-300">
          {showIcon && <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />}
          <span>Warning / Anomaly</span>
        </span>
      );
    case 'low':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-400">
          {showIcon && <Info className="w-3.5 h-3.5 text-sky-400 shrink-0" />}
          <span>Low Priority</span>
        </span>
      );
    case 'informational':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
          {showIcon && <Info className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
          <span>Informational</span>
        </span>
      );
    case 'nominal':
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
          {showIcon && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
          <span>Nominal (Clean)</span>
        </span>
      );
    case 'inconclusive':
    default:
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
          {showIcon && <HelpCircle className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
          <span>Inconclusive</span>
        </span>
      );
  }
};

export const VerdictBadge: React.FC<{ verdict: DetectorVerdict | string }> = ({ verdict }) => {
  switch (verdict) {
    case 'indicators_observed':
      return (
        <span className="inline-flex items-center gap-1 text-xs font-semibold text-rose-400">
          <AlertCircle className="w-3.5 h-3.5 text-rose-500 shrink-0" />
          <span>Indicators Observed</span>
        </span>
      );
    case 'no_indicator_detected':
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-400">
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
          <span>No Indicator Detected</span>
        </span>
      );
    case 'inconclusive':
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-300">
          <HelpCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span>Inconclusive</span>
        </span>
      );
    case 'conflicting_results':
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-purple-300">
          <AlertTriangle className="w-3.5 h-3.5 text-purple-400 shrink-0" />
          <span>Conflicting Results</span>
        </span>
      );
    case 'detection_unavailable':
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400">
          <Info className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span>Detection Unavailable</span>
        </span>
      );
    case 'analysis_incomplete':
    default:
      return (
        <span className="inline-flex items-center gap-1 text-xs font-medium text-slate-400">
          <Info className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          <span>Analysis Incomplete</span>
        </span>
      );
  }
};

export const StatusBadge: React.FC<{ status: CaseStatus }> = ({ status }) => {
  switch (status) {
    case 'open':
      return <span className="text-xs font-medium text-cyan-400">● Open</span>;
    case 'in_progress':
      return <span className="text-xs font-medium text-sky-400">● In Progress</span>;
    case 'review':
      return <span className="text-xs font-medium text-amber-300">● In Review</span>;
    case 'closed':
      return <span className="text-xs font-medium text-slate-400">● Closed</span>;
    default:
      return <span className="text-xs font-medium text-slate-400">{status}</span>;
  }
};

export const PriorityBadge: React.FC<{ priority: CasePriority }> = ({ priority }) => {
  switch (priority) {
    case 'critical':
      return <span className="text-xs font-semibold text-rose-400 uppercase">Critical</span>;
    case 'high':
      return <span className="text-xs font-medium text-amber-300 uppercase">High</span>;
    case 'medium':
      return <span className="text-xs font-medium text-slate-300 uppercase">Medium</span>;
    case 'low':
      return <span className="text-xs font-medium text-slate-400 uppercase">Low</span>;
    default:
      return <span className="text-xs font-medium text-slate-400">{priority}</span>;
  }
};
