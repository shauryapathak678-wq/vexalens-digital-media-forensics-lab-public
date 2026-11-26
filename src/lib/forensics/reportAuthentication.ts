export interface ReportAuthenticationRecord {
  version: 'VEXA-REPORT-1';
  reportNumber: string;
  caseNumber: string;
  reportHash: string;
  examinerName: string;
  examinerBadge: string;
  agency: string;
  issuedAt: string;
  keyId: string;
  signature: string;
}

export interface ReportAuthenticationRequest {
  reportNumber: string;
  caseNumber: string;
  reportHash: string;
  examinerName: string;
  examinerBadge: string;
  agency: string;
}

export interface ReportAuthenticationDisplay {
  record: ReportAuthenticationRecord;
  verificationUrl: string;
  qrDataUrl: string;
  signatureImageUrl?: string;
}

export async function signReport(
  request: ReportAuthenticationRequest
): Promise<ReportAuthenticationRecord> {
  const response = await fetch('/api/reports/sign', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  const responseText = await response.text();
  if (!responseText.trim()) {
    throw new Error(
      `The report-signing service returned an empty response (HTTP ${response.status}). Start or restart the VexaLens server with "npm run dev" and try again.`
    );
  }

  let result: { record?: ReportAuthenticationRecord; error?: string };
  try {
    result = JSON.parse(responseText) as { record?: ReportAuthenticationRecord; error?: string };
  } catch {
    throw new Error(
      `The report-signing service returned an invalid response (HTTP ${response.status}). Make sure this app is running through the VexaLens server ("npm run dev"), not a static preview.`
    );
  }

  if (!response.ok || !result.record) {
    throw new Error(result.error || 'Report signing is unavailable.');
  }
  return result.record;
}

export function getReportVerificationUrl(record: ReportAuthenticationRecord): string {
  const verificationRecord = encodeURIComponent(JSON.stringify(record));
  return `${window.location.origin}/api/reports/verify?record=${verificationRecord}`;
}
