import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, AlertCircle, CheckCircle2, RefreshCcw, Server } from 'lucide-react';
import type { SimpleReportContent } from '@/lib/forensics/reportBuilder';
import { createSimpleReportPDF } from '@/lib/forensics/pdfExport';
import { performELA } from '@/lib/forensics/ela';
import { isSupabaseConfigured, testSupabaseConnection } from '@/lib/supabase';

type ServiceStatus = 'operational' | 'degraded' | 'unavailable' | 'not_configured' | 'error';
type ServiceEntry = {
  service_id: string;
  display_name: string;
  category: string;
  status: ServiceStatus;
  message: string;
  version: string | null;
  last_checked_at: string;
  last_success_at: string | null;
  capabilities: string[];
  error_code?: string;
};

const statusLabels: Record<ServiceStatus, string> = {
  operational: 'Operational',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  not_configured: 'Not configured',
  error: 'Error',
};

function statusClass(status: ServiceStatus): string {
  if (status === 'operational') return 'text-emerald-300';
  if (status === 'degraded') return 'text-amber-300';
  if (status === 'error' || status === 'unavailable') return 'text-rose-300';
  return 'text-slate-400';
}

export const ForensicServicesView: React.FC = () => {
  const [services, setServices] = useState<ServiceEntry[]>([]);
  const [isChecking, setIsChecking] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const checkInFlight = useRef(false);

  const refreshServices = useCallback(async () => {
    if (checkInFlight.current) return;
    checkInFlight.current = true;
    setIsChecking(true);
    setErrorMessage('');
    const checkedAt = new Date().toISOString();

    try {
      // The registry runs live binary probes (ffmpeg/ffprobe) and a database
      // round-trip, so allow more time before declaring it unreachable.
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 15000);

      let response: Response;
      try {
        response = await fetch('/api/services', { signal: controller.signal });
      } finally {
        window.clearTimeout(timeoutId);
      }

      if (!response.ok) throw new Error(`Service registry returned HTTP ${response.status}.`);
      const data = await response.json() as { services?: ServiceEntry[] };
      const backendServices = data.services || [];
      const browserServices: ServiceEntry[] = [];

      try {
        const canvas = document.createElement('canvas');
        canvas.width = 2;
        canvas.height = 2;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) throw new Error('Canvas 2D context unavailable.');
        context.fillStyle = '#7391ab';
        context.fillRect(0, 0, 2, 2);
        const ela = await performELA(canvas, { quality: 0.95, diffGain: 1, colorChannel: 'rgb', invert: false, luminanceOnly: false });
        if (!ela.dataUrl.startsWith('data:image/png') || !['high', 'medium', 'low'].includes(ela.reliability)) throw new Error('ELA smoke test returned invalid output.');
        browserServices.push({ service_id: 'image_ela', display_name: 'Image ELA Engine', category: 'image', status: 'operational', message: 'Canvas recompression and difference-map smoke test passed. This is a diagnostic, not an authenticity classifier.', version: 'Canvas ELA', last_checked_at: checkedAt, last_success_at: checkedAt, capabilities: ['JPEG recompression difference map'] });
      } catch (error) {
        browserServices.push({ service_id: 'image_ela', display_name: 'Image ELA Engine', category: 'image', status: 'error', message: error instanceof Error ? error.message : 'Browser ELA smoke test failed.', version: 'Canvas ELA', last_checked_at: checkedAt, last_success_at: null, capabilities: [], error_code: 'ELA_SMOKE_TEST_FAILED' });
      }

      try {
        const pdfContent: SimpleReportContent = {
          reportId: 'SERVICE-CHECK', caseNumber: 'SERVICE-CHECK', title: 'PDF engine smoke test', caseSummary: 'Temporary local PDF self-test.',
          conclusion: 'unable_to_analyze', conclusionLabel: 'Unable to analyze', checked: [], findings: [], evidenceGallery: [], domainConclusions: [], glossary: [], whatThisMeans: 'No evidence was processed.',
          nextSteps: [], limitations: 'Temporary test output.', evidenceIds: [], analysisDate: checkedAt,
          timeline: { caseRegistered: checkedAt, evidenceReceived: checkedAt, reportGenerated: checkedAt },
          confidenceLabel: 'Smoke test',
          detectorCount: 0,
        };
        const pdf = await createSimpleReportPDF(pdfContent);
        const bytes = pdf.output('arraybuffer');
        const pdfHeader = new TextDecoder().decode(bytes.slice(0, 4));
        if (pdfHeader !== '%PDF' || bytes.byteLength < 500) throw new Error('PDF smoke test returned invalid output.');
        browserServices.push({ service_id: 'pdf_generation', display_name: 'PDF Report Engine', category: 'reports', status: 'operational', message: 'Client-side smoke test generated a valid PDF header and non-empty document.', version: 'jsPDF', last_checked_at: checkedAt, last_success_at: checkedAt, capabilities: ['English PDF generation'] });
      } catch (error) {
        browserServices.push({ service_id: 'pdf_generation', display_name: 'PDF Report Engine', category: 'reports', status: 'error', message: error instanceof Error ? error.message : 'PDF smoke test failed.', version: 'jsPDF', last_checked_at: checkedAt, last_success_at: null, capabilities: [], error_code: 'PDF_SMOKE_TEST_FAILED' });
      }

      if (isSupabaseConfigured()) {
        const databaseCheck = await testSupabaseConnection();
        browserServices.push({ service_id: 'browser_supabase_query', display_name: 'Supabase Client Query', category: 'database', status: databaseCheck.success ? 'operational' : 'error', message: databaseCheck.message, version: null, last_checked_at: checkedAt, last_success_at: databaseCheck.success ? checkedAt : null, capabilities: ['read-only investigations table connectivity test'], error_code: databaseCheck.success ? undefined : 'SUPABASE_QUERY_FAILED' });
      } else {
        browserServices.push({ service_id: 'browser_supabase_query', display_name: 'Browser Storage Engine', category: 'database', status: 'operational', message: 'Local browser storage active for cases, evidence, and forensic findings.', version: 'IndexedDB/localStorage', last_checked_at: checkedAt, last_success_at: checkedAt, capabilities: ['local persistence', 'client-side forensic workspace'] });
      }

      const browserCheckedIds = new Set(browserServices.map((service) => service.service_id));
      setServices([...backendServices.filter((service) => !browserCheckedIds.has(service.service_id)), ...browserServices]);
      setLastRefreshed(checkedAt);
    } catch (error) {
      setServices([{ service_id: 'backend_api', display_name: 'Backend API', category: 'infrastructure', status: 'error', message: error instanceof Error ? error.message : 'Service registry request failed.', version: null, last_checked_at: checkedAt, last_success_at: null, capabilities: [], error_code: 'SERVICE_REGISTRY_UNREACHABLE' }]);
      setErrorMessage('The service registry could not be reached. Client-only checks were not run.');
    } finally {
      checkInFlight.current = false;
      setIsChecking(false);
    }
  }, []);

  useEffect(() => {
    void refreshServices();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshServices();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [refreshServices]);

  const categories = useMemo(() => ['all', ...new Set(services.map((service) => service.category))], [services]);
  const visibleServices = services.filter((service) =>
    (categoryFilter === 'all' || service.category === categoryFilter) &&
    (statusFilter === 'all' || service.status === statusFilter)
  );
  const criticalServices = services.filter((service) => ['backend_api', 'sha256', 'image_ela', 'pdf_generation'].includes(service.service_id));
  const allCriticalOperational = criticalServices.length > 0 && criticalServices.every((service) => service.status === 'operational');

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="text-xs font-mono text-cyan-400">LIVE SERVICE HEALTH</div>
          <h1 className="text-xl font-bold text-slate-100 mt-1">Forensic Services Center</h1>
          <p className="text-xs text-slate-400 mt-1">Live health monitoring for VexaLens forensic engines and infrastructure.</p>
        </div>
        <button type="button" onClick={() => void refreshServices()} disabled={isChecking} className="inline-flex items-center gap-2 px-3 py-2 rounded bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-xs text-slate-200">
          <RefreshCcw className={`w-3.5 h-3.5 ${isChecking ? 'animate-spin' : ''}`} />
          Refresh Status
        </button>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3 border-y border-slate-800 py-3">
        <div className={`flex items-center gap-2 text-sm ${allCriticalOperational ? 'text-emerald-300' : 'text-amber-300'}`}>
          {allCriticalOperational ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          {allCriticalOperational ? 'Critical local services passed their checks' : 'Some required capabilities are not configured'}
        </div>
        <div className="text-xs text-slate-500">Last refreshed: {lastRefreshed ? new Date(lastRefreshed).toLocaleString() : 'Not checked'}</div>
      </div>

      {errorMessage && <div role="alert" className="border border-rose-800 bg-rose-950/30 px-3 py-2 text-xs text-rose-200">{errorMessage}</div>}

      <div className="flex flex-wrap gap-3">
        <label className="text-xs text-slate-400">Category
          <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)} className="ml-2 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-200">
            {categories.map((category) => <option key={category} value={category}>{category === 'all' ? 'All' : category}</option>)}
          </select>
        </label>
        <label className="text-xs text-slate-400">Status
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className="ml-2 bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-slate-200">
            <option value="all">All</option>
            {(Object.keys(statusLabels) as ServiceStatus[]).map((status) => <option key={status} value={status}>{statusLabels[status]}</option>)}
          </select>
        </label>
      </div>

      {isChecking && services.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-400"><Activity className="w-5 h-5 animate-pulse mx-auto mb-2" />Checking configured services…</div>
      ) : visibleServices.length === 0 ? (
        <div className="py-12 text-center text-sm text-slate-400">No services match these filters.</div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-6">
          {visibleServices.map((service) => (
            <details key={service.service_id} className="border-b border-slate-800 py-4">
              <summary className="cursor-pointer list-none flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2"><Server className="w-3.5 h-3.5 text-slate-500" /><h2 className="text-sm font-medium text-slate-100">{service.display_name}</h2></div>
                  <p className="text-xs text-slate-400 mt-1">{service.message}</p>
                </div>
                <span className={`text-xs whitespace-nowrap ${statusClass(service.status)}`}>{statusLabels[service.status]}</span>
              </summary>
              <div className="pl-5 mt-3 space-y-2 text-xs text-slate-400">
                <div>Category: {service.category}{service.version ? ` · Version: ${service.version}` : ''}</div>
                <div>Last checked: {new Date(service.last_checked_at).toLocaleString()}</div>
                <div>Last success: {service.last_success_at ? new Date(service.last_success_at).toLocaleString() : 'None recorded'}</div>
                <div>Capabilities: {service.capabilities.length ? service.capabilities.join(' · ') : 'None available'}</div>
                {service.error_code && <div>Error code: {service.error_code}</div>}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
};