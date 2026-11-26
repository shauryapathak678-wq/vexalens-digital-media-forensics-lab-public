import React, { useState } from 'react';
import {
  EvidenceCertificate,
  EvidenceItem,
  Investigation,
  UserProfile,
} from '@/types/forensics';
import {
  issueEvidenceCertificate,
  exportEvidenceCertificatePDF,
} from '@/lib/forensics/certificate';
import {
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Download,
  Plus,
  Search,
  Hash,
  Clock,
  QrCode,
  FileText,
  AlertTriangle,
} from 'lucide-react';
import { formatShortHash } from '@/lib/forensics/crypto';

interface CertificatesViewProps {
  certificates: EvidenceCertificate[];
  evidenceList: EvidenceItem[];
  currentCase?: Investigation;
  user: UserProfile;
  onSaveCertificate: (cert: EvidenceCertificate) => void;
  onRevokeCertificate: (id: string, reason: string) => void;
}

export const CertificatesView: React.FC<CertificatesViewProps> = ({
  certificates,
  evidenceList,
  currentCase,
  user,
  onSaveCertificate,
  onRevokeCertificate,
}) => {
  const [activeTab, setActiveTab] = useState<'registry' | 'verifier'>('registry');
  const [isIssueModalOpen, setIsIssueModalOpen] = useState(false);
  const [selectedEvidenceId, setSelectedEvidenceId] = useState(evidenceList[0]?.id || '');
  const [isIssuing, setIsIssuing] = useState(false);

  // Verifier State
  const [verifyCertId, setVerifyCertId] = useState('');
  const [verifyFileHash, setVerifyFileHash] = useState('');
  const [verifyResult, setVerifyResult] = useState<any>(null);
  const [isVerifying, setIsVerifying] = useState(false);

  // Revoke state
  const [revokingCertId, setRevokingCertId] = useState<string | null>(null);
  const [revokeReason, setRevokeReason] = useState('Evidence chain transferred to external court jurisdiction');

  const handleIssueCertificate = async (e: React.FormEvent) => {
    e.preventDefault();
    const evidence = evidenceList.find((ev) => ev.id === selectedEvidenceId);
    if (!evidence || !currentCase) return;

    setIsIssuing(true);
    try {
      const cert = await issueEvidenceCertificate(evidence, currentCase, user, [
        'SHA-256 file digest',
        'ExifReader available-tag inspection',
        'Canvas JPEG recompression ELA diagnostic',
      ]);
      onSaveCertificate(cert);
      setIsIssueModalOpen(false);
      alert(`Certificate ${cert.certificateId} was signed by the configured server.`);
    } catch (err: any) {
      alert(`Failed to issue certificate: ${err?.message || 'Signing failed'}`);
    } finally {
      setIsIssuing(false);
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!verifyCertId.trim()) return;

    setIsVerifying(true);
    setVerifyResult(null);

    try {
      const res = await fetch('/api/certificates/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          certificateId: verifyCertId.trim(),
          sha256Hash: verifyFileHash.trim() || undefined,
        }),
      });

      const data = await res.json();
      setVerifyResult(data);
    } catch (err: any) {
      setVerifyResult({
        status: 'unavailable',
        verified: false,
        reason: err?.message || 'Certificate verification service is unavailable.',
      });
    } finally {
      setIsVerifying(false);
    }
  };

  const handleRevokeConfirm = () => {
    if (!revokingCertId) return;
    onRevokeCertificate(revokingCertId, revokeReason);
    setRevokingCertId(null);
  };

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <div className="text-xs font-mono text-cyan-400">
            SERVER-SIDE HMAC RECORDS · LOCAL VERIFICATION
          </div>
          <h1 className="text-xl font-bold tracking-tight text-slate-100 mt-1">
            Evidence Integrity Certificates & Verification
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            HMAC records can be issued only when a server secret is configured. They do not establish signer identity or media authenticity.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('registry')}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              activeTab === 'registry' ? 'bg-slate-800 text-cyan-300' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Certificate Registry ({certificates.length})
          </button>
          <button
            onClick={() => setActiveTab('verifier')}
            className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              activeTab === 'verifier' ? 'bg-slate-800 text-cyan-300' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            Cryptographic Verifier
          </button>
          <button
            onClick={() => setIsIssueModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-cyan-400 hover:bg-cyan-300 text-slate-950 text-xs font-bold transition-colors shadow-sm"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>Issue New Certificate</span>
          </button>
        </div>
      </div>

      {activeTab === 'registry' ? (
        <div className="space-y-4">
          {/* Legal Notice */}
          <div className="p-3.5 rounded bg-slate-900/40 border border-slate-800 text-xs text-slate-400 leading-relaxed flex items-start gap-2.5">
            <ShieldCheck className="w-4 h-4 text-cyan-400 shrink-0 mt-0.5" />
            <div>
              <span className="text-slate-200 font-medium">Certification Scope & Legal Clarity: </span>
              A VexaLens Certificate confirms the recorded technical checks, hashing procedures, and software version applied to an artifact. It does not certify government accreditation or court-appointed status. Matching hashes verify that the stored file bitstream has not been modified.
            </div>
          </div>

          {/* Certificate Table */}
          <div className="rounded-lg border border-slate-800 bg-slate-900/40 overflow-hidden">
            <table className="w-full text-left border-collapse text-xs font-mono">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/70 text-slate-400 font-sans font-medium">
                  <th className="py-2.5 px-3.5">CERTIFICATE ID</th>
                  <th className="py-2.5 px-3.5">ARTIFACT FILE</th>
                  <th className="py-2.5 px-3.5">SHA-256 HASH</th>
                  <th className="py-2.5 px-3.5">ISSUED TIMESTAMP</th>
                  <th className="py-2.5 px-3.5">STATUS</th>
                  <th className="py-2.5 px-3.5 text-right font-sans">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-300">
                {certificates.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-8 text-center text-slate-400 font-sans">
                      No evidence integrity certificates issued yet. Click 'Issue New Certificate' to generate one.
                    </td>
                  </tr>
                ) : (
                  certificates.map((cert) => (
                    <tr key={cert.certificateId} className="hover:bg-slate-800/20">
                      <td className="py-3 px-3.5 font-bold text-cyan-300">
                        {cert.certificateId}
                      </td>
                      <td className="py-3 px-3.5 font-sans font-medium text-slate-200 truncate max-w-xs">
                        {cert.fileName}
                      </td>
                      <td className="py-3 px-3.5 text-slate-400 text-[11px]">
                        {formatShortHash(cert.sha256Hash, 6, 6)}
                      </td>
                      <td className="py-3 px-3.5 text-slate-400 text-[11px]">
                        {new Date(cert.analysisTimestamp).toLocaleString()}
                      </td>
                      <td className="py-3 px-3.5 font-sans">
                        {cert.status === 'valid' ? (
                          <span className="text-emerald-400 font-medium flex items-center gap-1">
                            <CheckCircle2 className="w-3.5 h-3.5" /> Valid
                          </span>
                        ) : cert.status === 'revoked' ? (
                          <span className="text-rose-400 font-medium flex items-center gap-1" title={cert.revocationReason}>
                            <AlertCircle className="w-3.5 h-3.5" /> Revoked
                          </span>
                        ) : (
                          <span className="text-amber-400 font-medium">Unverifiable</span>
                        )}
                      </td>
                      <td className="py-3 px-3.5 text-right font-sans space-x-2">
                        <button
                          onClick={() => exportEvidenceCertificatePDF(cert)}
                          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs transition-colors"
                          title="Download signed PDF Certificate with QR code"
                        >
                          Download PDF
                        </button>
                        {cert.status === 'valid' && (
                          <button
                            onClick={() => setRevokingCertId(cert.certificateId)}
                            className="px-2 py-1 rounded bg-slate-900 border border-slate-800 hover:border-rose-500/60 text-slate-400 hover:text-rose-300 text-xs transition-colors"
                          >
                            Revoke
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Verifier Tab */
        <div className="max-w-2xl mx-auto space-y-6">
          <div className="p-6 rounded-lg bg-slate-900/60 border border-slate-800 space-y-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200 uppercase tracking-wider">
              <Search className="w-4 h-4 text-cyan-400" />
              <span>Verify Evidence Certificate Authenticity</span>
            </div>

            <p className="text-xs text-slate-400 leading-relaxed">
              Enter any VexaLens Certificate Identifier (or provide an evidence file SHA-256 hash) to verify its cryptographic manifest against the primary key registry.
            </p>

            <form onSubmit={handleVerify} className="space-y-3 text-xs">
              <div className="space-y-1">
                <label className="text-slate-400">Certificate Identifier (Required)</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. VLC-2026-90412"
                  value={verifyCertId}
                  onChange={(e) => setVerifyCertId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="space-y-1">
                <label className="text-slate-400">Evidence SHA-256 Hash (Optional bitstream check)</label>
                <input
                  type="text"
                  placeholder="Paste a calculated SHA-256 digest to compare"
                  value={verifyFileHash}
                  onChange={(e) => setVerifyFileHash(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-3 py-2 text-slate-200 font-mono focus:outline-none focus:border-cyan-500"
                />
              </div>

              <button
                type="submit"
                disabled={isVerifying}
                className="w-full py-2 rounded bg-cyan-400 hover:bg-cyan-300 text-slate-950 font-bold transition-colors shadow-sm disabled:opacity-50 mt-2"
              >
                {isVerifying ? 'Verifying Signature...' : 'Run Cryptographic Verification'}
              </button>
            </form>

            {/* Verification Result Card */}
            {verifyResult && (
              <div
                className={`p-4 rounded-lg border text-xs space-y-2 ${
                  verifyResult.status === 'valid'
                    ? 'bg-emerald-950/20 border-emerald-800/80 text-emerald-300'
                    : verifyResult.status === 'revoked'
                    ? 'bg-rose-950/20 border-rose-800/80 text-rose-300'
                    : 'bg-amber-950/20 border-amber-800/80 text-amber-300'
                }`}
              >
                <div className="flex items-center justify-between font-bold text-sm">
                  <div className="flex items-center gap-1.5">
                    {verifyResult.status === 'valid' ? (
                      <>
                        <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        <span>SERVER HMAC MATCHED FOR THIS RECORD</span>
                      </>
                    ) : verifyResult.status === 'revoked' ? (
                      <>
                        <AlertCircle className="w-4 h-4 text-rose-400" />
                        <span>CERTIFICATE REVOKED</span>
                      </>
                    ) : (
                      <>
                        <AlertTriangle className="w-4 h-4 text-amber-400" />
                        <span>UNVERIFIABLE OR SIGNATURE MISMATCH</span>
                      </>
                    )}
                  </div>
                </div>

                {verifyResult.reason && <p className="text-slate-300">{verifyResult.reason}</p>}
                {verifyResult.revocationReason && (
                  <p className="text-rose-200">Revocation Reason: {verifyResult.revocationReason}</p>
                )}

                {verifyResult.record && (
                  <div className="p-2.5 rounded bg-slate-950 border border-slate-800 text-[11px] font-mono text-slate-300 space-y-1 mt-2">
                    <div>Certified File: {verifyResult.record.fileName || verifyResult.record.metadata?.fileName}</div>
                    <div className="truncate">Certified Hash: {verifyResult.record.sha256Hash || verifyResult.record.fileSha256}</div>
                    <div>Issued: {new Date(verifyResult.record.analysisTimestamp || verifyResult.record.issuedAt).toLocaleString()}</div>
                    <div>Signer Key: VEXA-KEY-2026-PRIMARY</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Issue Certificate Modal */}
      {isIssueModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-lg bg-slate-900 border border-slate-800 shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-base font-bold text-slate-100">Issue Evidence Integrity Certificate</h2>
              <button onClick={() => setIsIssueModalOpen(false)} className="text-slate-400 hover:text-slate-200">
                ✕
              </button>
            </div>

            <form onSubmit={handleIssueCertificate} className="space-y-3.5 text-xs">
              <div className="space-y-1">
                <label className="text-slate-400">Target Evidence File</label>
                <select
                  value={selectedEvidenceId}
                  onChange={(e) => setSelectedEvidenceId(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500 font-mono"
                >
                  {evidenceList.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.fileName} ({e.isOriginal ? 'Baseline' : 'Suspect'})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1">
                <label className="text-slate-400">Attesting Forensic Examiner</label>
                <input
                  type="text"
                  disabled
                  value={`${user.fullName} [Badge #${user.badgeNumber}]`}
                  className="w-full bg-slate-950/50 border border-slate-800 rounded px-2.5 py-1.5 text-slate-400 font-mono"
                />
              </div>

              <div className="p-3 rounded bg-slate-950 border border-slate-800 text-[11px] text-slate-400 space-y-1">
                <span className="text-slate-300 font-semibold">Integrity Protocol:</span>
                <p>
                  Calculates canonical SHA-256 digest, preserves bitstream immutability, signs manifest with server key, and generates scannable QR verification seal.
                </p>
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsIssueModalOpen(false)}
                  className="px-3 py-1.5 rounded text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isIssuing}
                  className="px-4 py-1.5 rounded font-bold text-slate-950 bg-cyan-400 hover:bg-cyan-300 transition-colors disabled:opacity-50"
                >
                  {isIssuing ? 'Signing Certificate...' : 'Generate & Sign Certificate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Revoke Certificate Modal */}
      {revokingCertId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-lg bg-slate-900 border border-slate-800 shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <h2 className="text-base font-bold text-slate-100">Revoke Certificate ({revokingCertId})</h2>
              <button onClick={() => setRevokingCertId(null)} className="text-slate-400 hover:text-slate-200">
                ✕
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <p className="text-slate-300">
                Revoking marks this certificate as invalid in the cryptographic registry without deleting the historical audit trail.
              </p>

              <div className="space-y-1">
                <label className="text-slate-400">Formal Revocation Reason</label>
                <textarea
                  rows={3}
                  value={revokeReason}
                  onChange={(e) => setRevokeReason(e.target.value)}
                  className="w-full bg-slate-950 border border-slate-800 rounded px-2.5 py-1.5 text-slate-200 focus:outline-none focus:border-cyan-500"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setRevokingCertId(null)}
                  className="px-3 py-1.5 rounded text-slate-400 hover:text-slate-200"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleRevokeConfirm}
                  className="px-4 py-1.5 rounded font-bold text-white bg-rose-600 hover:bg-rose-500 transition-colors"
                >
                  Confirm Revocation
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
